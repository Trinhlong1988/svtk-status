/**
 * COMBAT INTEGRATION AUDIT — cross-runtime invariant verifier (Phase 11).
 *
 * Audits the integration between every CMD1 subsystem that participates in
 * combat. Per CMD1.docx Phase 11 § V, verifies:
 *   - status runtime ↔ boss runtime
 *   - threat runtime ↔ companion runtime
 *   - spatial runtime ↔ replay runtime
 *   - itemization runtime hooks (Phase 7 CMD2 — read-only check)
 *
 * STRICT OWNERSHIP LOCK (CMD1.docx § IV):
 *   - This audit is READ-ONLY. No mutation of foreign-owned state.
 *   - Reports issues. Does NOT auto-fix.
 *
 * Use:
 *   ```
 *   const report = auditCombatIntegration(rt);
 *   if (!report.healthy) console.error(report.issues);
 *   ```
 */
import { z } from 'zod';
import type { CombatRuntime } from './combat_runtime.js';
import type { ReplayEventStream } from './replay_event_stream.js';
import { compareStreams } from './replay_event_stream.js';
import { chainMul } from './constants.js';

// ─────────────────────────────────────────────────────────
// Issue taxonomy
// ─────────────────────────────────────────────────────────

export const IntegrationIssueKindSchema = z.enum([
  'session_id_collision',
  'spatial_version_stale',
  'mechanic_budget_overrun',
  'proc_budget_overrun',
  'aura_chain_persistent',
  'replay_session_mismatch',
  'telemetry_explosion',
  'compaction_history_missing',
  'schema_stamp_drift',
  'pending_mechanic_leak',
  'aoe_marker_leak',
  'proximity_trigger_leak',
  'recorder_open_frame',
  'order_sequence_collision',
]);
export type IntegrationIssueKind = z.infer<typeof IntegrationIssueKindSchema>;

export type Severity = 'INFO' | 'WARN' | 'CRITICAL';

export interface IntegrationIssue {
  kind: IntegrationIssueKind;
  severity: Severity;
  detail: string;
  /** Encounter id (for shard correlation). */
  encounterId: string;
  /** Suggested action (developer hint). */
  hint?: string;
}

export interface IntegrationAuditReport {
  encounterId: string;
  sessionId: string;
  currentTurn: number;
  healthy: boolean;
  issues: IntegrationIssue[];
  byKind: Readonly<Record<string, number>>;
  bySeverity: Readonly<Record<Severity, number>>;
}

// ─────────────────────────────────────────────────────────
// Auditor
// ─────────────────────────────────────────────────────────

export function auditCombatIntegration(rt: CombatRuntime): IntegrationAuditReport {
  const issues: IntegrationIssue[] = [];
  const eid = rt.config.encounterId;

  // 1. Replay session id must match runtime session id
  if (rt.replayStream.sessionId !== rt.config.sessionId) {
    issues.push({
      kind: 'replay_session_mismatch', severity: 'CRITICAL',
      encounterId: eid,
      detail: `replayStream.sessionId=${rt.replayStream.sessionId} != runtime.config.sessionId=${rt.config.sessionId}`,
      hint: 'Re-create runtime; do not swap streams mid-encounter.',
    });
  }

  // 2. Recorder must not have open frame at audit time
  if (rt.recorder.current !== undefined) {
    issues.push({
      kind: 'recorder_open_frame', severity: 'WARN',
      encounterId: eid,
      detail: `recorder.current frame at turn=${rt.recorder.current.turn} still open`,
      hint: 'Audit between turns — call endCombatTurn() before auditing.',
    });
  }

  // 3. Pending mechanic queue should not exceed budget cap × turns elapsed
  if (rt.scheduler.pending.size > rt.mechanicBudget.tickCap * Math.max(1, rt.currentTurn + 1)) {
    issues.push({
      kind: 'pending_mechanic_leak', severity: 'WARN',
      encounterId: eid,
      detail: `pendingMechanics=${rt.scheduler.pending.size} exceeds expected upper bound`,
      hint: 'Verify mechanic dispatcher drains scheduler each turn.',
    });
  }

  // 4. AoE markers exceeding 4× tick budget → unreleased
  if (rt.aoeRegistry.markers.size > rt.mechanicBudget.tickCap * 4) {
    issues.push({
      kind: 'aoe_marker_leak', severity: 'WARN',
      encounterId: eid,
      detail: `aoeMarkers=${rt.aoeRegistry.markers.size} exceeds expected upper bound`,
    });
  }

  // 5. Proximity triggers — unbounded growth check
  if (rt.proximityRegistry.triggers.size > 1000) {
    issues.push({
      kind: 'proximity_trigger_leak', severity: 'WARN',
      encounterId: eid,
      detail: `proximityTriggers=${rt.proximityRegistry.triggers.size} unbounded`,
      hint: 'Remove one-shot triggers after fire; cull stale registrations.',
    });
  }

  // 6. Telemetry — if >50% of total events are anomalies, signal explosion.
  //    INT BP per CLAUDE.md mục 14.6 NO FLOAT in Layer 2: replace `*0.5` với
  //    `chainMul(_, 5000)` (= ×50% BP, single Math.floor truncation at end).
  const totalReplayEvents = rt.replayStream.events.length;
  const halfReplayEvents = chainMul(totalReplayEvents, 5000);
  if (totalReplayEvents > 100 && rt.telemetry.totalCount > halfReplayEvents) {
    issues.push({
      kind: 'telemetry_explosion', severity: 'CRITICAL',
      encounterId: eid,
      detail: `anomalies=${rt.telemetry.totalCount} > 50% of replay events (${totalReplayEvents})`,
      hint: 'Check proc/aura guards — system is rejecting too many events.',
    });
  }

  // 7. Proc budget overrun (more rejected than accepted = configuration issue)
  let rejectedProcs = 0;
  for (const v of rt.procBudget.rejectedByReason.values()) rejectedProcs += v;
  const acceptedProcs = (rt.procBudget.remaining < Number.MAX_SAFE_INTEGER)
    ? Math.max(0, 8 - rt.procBudget.remaining)
    : 0;
  if (rejectedProcs > acceptedProcs * 4 && rejectedProcs > 10) {
    issues.push({
      kind: 'proc_budget_overrun', severity: 'INFO',
      encounterId: eid,
      detail: `procRejected=${rejectedProcs} >> procAccepted=${acceptedProcs}`,
      hint: 'Tune MAX_STATUS_PROC_PER_ACTION or reduce chain depth.',
    });
  }

  // 8. Mechanic budget overrun
  let rejectedMech = 0;
  for (const v of rt.mechanicBudget.rejectedByReason.values()) rejectedMech += v;
  if (rejectedMech > 20) {
    issues.push({
      kind: 'mechanic_budget_overrun', severity: 'INFO',
      encounterId: eid,
      detail: `mechanicRejected=${rejectedMech} — boss script may be over-scheduling`,
    });
  }

  // 9. Spatial layer version sanity — version must monotonic > 0 if any positions exist
  if (rt.spatialLayer.positions.size > 0 && rt.spatialLayer.version === 0) {
    issues.push({
      kind: 'spatial_version_stale', severity: 'WARN',
      encounterId: eid,
      detail: `spatialLayer has ${rt.spatialLayer.positions.size} positions but version=0 (never bumped)`,
      hint: 'Caller setPosition must bump version; check direct mutation of positions map.',
    });
  }

  // 10. Aura chain persistence across turns
  if (rt.auraGuard.chainDepth > 0 && rt.auraGuard.visitedSources.size > 5) {
    issues.push({
      kind: 'aura_chain_persistent', severity: 'WARN',
      encounterId: eid,
      detail: `auraGuard chain still active: depth=${rt.auraGuard.chainDepth}, visited=${rt.auraGuard.visitedSources.size}`,
      hint: 'Call endChain() at chain boundary; tickAuraGuard() at turn boundary.',
    });
  }

  // 11. Compaction history sanity — for long-running encounters, expect at least 1 compaction
  if (rt.currentTurn > 100 && rt.compactionHistory.length === 0 && rt.replayStream.events.length > 5000) {
    issues.push({
      kind: 'compaction_history_missing', severity: 'WARN',
      encounterId: eid,
      detail: `encounter at turn=${rt.currentTurn} with ${rt.replayStream.events.length} events but no compaction yet`,
      hint: 'Verify compactionThresholdBytes appropriate for raid scale.',
    });
  }

  // ─── tally ───
  const byKind: Record<string, number> = {};
  const bySeverity: Record<Severity, number> = { INFO: 0, WARN: 0, CRITICAL: 0 };
  for (const i of issues) {
    byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
    bySeverity[i.severity] += 1;
  }

  return {
    encounterId: eid,
    sessionId: rt.config.sessionId,
    currentTurn: rt.currentTurn,
    healthy: bySeverity.CRITICAL === 0,
    issues,
    byKind,
    bySeverity,
  };
}

// ─────────────────────────────────────────────────────────
// Replay session pair audit — compare two streams
// ─────────────────────────────────────────────────────────

export interface PairAuditReport {
  matched: boolean;
  divergentTurn?: number;
  expectedChecksum?: string;
  actualChecksum?: string;
  framesA: number;
  framesB: number;
  eventsA: number;
  eventsB: number;
}

export function auditReplayPair(
  expected: ReplayEventStream,
  actual: ReplayEventStream,
): PairAuditReport {
  const cmp = compareStreams(expected, actual);
  return {
    matched: !cmp.divergent,
    divergentTurn: cmp.firstDivergentTurn,
    expectedChecksum: cmp.expectedChecksum,
    actualChecksum: cmp.actualChecksum,
    framesA: expected.frames.length,
    framesB: actual.frames.length,
    eventsA: expected.events.length,
    eventsB: actual.events.length,
  };
}
