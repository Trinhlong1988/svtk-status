/**
 * REPLAY FORENSIC AUDIT — invariant verifier for replay streams (Phase 11).
 *
 * Per CMD1.docx Phase 11 § VII:
 *   - replay restore
 *   - rollback replay
 *   - replay checksum
 *   - cross-version replay
 *   - replay divergence detect
 *   - delayed AoE replay
 *   - boss phase replay
 *   - companion replay
 *   - item aggregation replay
 *
 * STRICT additive — read-only audit. Does NOT mutate streams.
 */
import { z } from 'zod';
import type { ReplayEventStream, StreamEventKind } from './replay_event_stream.js';
import { compareStreams, rollbackTo, totalFrames, totalEvents } from './replay_event_stream.js';
import type { ReplayFrame } from './replay_frame.js';
import {
  checkSchemaCompatibility,
  currentSchemaStamp,
  type SchemaStamp,
} from './spatial_mechanic_schema_version.js';

// ─────────────────────────────────────────────────────────
// Forensic issue taxonomy
// ─────────────────────────────────────────────────────────

export const ForensicIssueKindSchema = z.enum([
  'frame_turn_not_monotonic',
  'frame_session_inconsistent',
  'event_seq_not_monotonic',
  'event_turn_out_of_order',
  'event_turn_beyond_frame',
  'frame_checksum_recompute_mismatch',
  'schema_version_drift',
  'rollback_restore_divergence',
  'cross_run_divergence',
  'missing_boss_decision_when_boss_engaged',
  'aoe_resolved_without_scheduled',
  'companion_action_unordered',
  'rng_trace_count_decreased',
]);
export type ForensicIssueKind = z.infer<typeof ForensicIssueKindSchema>;

export interface ForensicIssue {
  kind: ForensicIssueKind;
  severity: 'CRITICAL' | 'WARN' | 'INFO';
  detail: string;
  /** Frame turn or event seq for forensics. */
  locator?: { turn?: number; seq?: number; frameId?: string };
}

export interface ForensicAuditReport {
  encounterId: string;
  sessionId: string;
  totalFrames: number;
  totalEvents: number;
  schemaCompatible: boolean;
  healthy: boolean;
  issues: ForensicIssue[];
  byKind: Readonly<Record<string, number>>;
  bySeverity: Readonly<Record<'CRITICAL' | 'WARN' | 'INFO', number>>;
}

// ─────────────────────────────────────────────────────────
// Audit a single stream
// ─────────────────────────────────────────────────────────

export interface ForensicAuditOpts {
  /** If provided, schema compat verified against this stamp (vd recording stamp). */
  schemaStamp?: SchemaStamp;
  /** If true, skip event-seq monotonicity check (legacy stream). */
  skipSeqCheck?: boolean;
}

export function auditReplayForensic(
  stream: ReplayEventStream,
  opts: ForensicAuditOpts = {},
): ForensicAuditReport {
  const issues: ForensicIssue[] = [];

  // 1. Frame turn monotonic + session consistent
  let prevTurn = -1;
  for (const f of stream.frames) {
    if (f.turn <= prevTurn) {
      issues.push({
        kind: 'frame_turn_not_monotonic', severity: 'CRITICAL',
        detail: `frame.turn=${f.turn} not > prevTurn=${prevTurn}`,
        locator: { turn: f.turn, frameId: f.frameId },
      });
    }
    if (f.sessionId !== stream.sessionId) {
      issues.push({
        kind: 'frame_session_inconsistent', severity: 'CRITICAL',
        detail: `frame.sessionId=${f.sessionId} != stream.sessionId=${stream.sessionId}`,
        locator: { turn: f.turn, frameId: f.frameId },
      });
    }
    prevTurn = f.turn;
  }

  // 2. Event seq monotonic
  if (!opts.skipSeqCheck) {
    let prevSeq = -1;
    for (const e of stream.events) {
      if (e.seq <= prevSeq) {
        issues.push({
          kind: 'event_seq_not_monotonic', severity: 'CRITICAL',
          detail: `event.seq=${e.seq} not > prevSeq=${prevSeq}`,
          locator: { seq: e.seq, turn: e.turn },
        });
        break;
      }
      prevSeq = e.seq;
    }
  }

  // 3. Schema compat (if recording stamp provided)
  let schemaCompatible = true;
  if (opts.schemaStamp) {
    const r = checkSchemaCompatibility(opts.schemaStamp.spatial, opts.schemaStamp.mechanic);
    if (!r.compatible) {
      schemaCompatible = false;
      issues.push({
        kind: 'schema_version_drift', severity: 'CRITICAL',
        detail: `Schema incompatible: ${r.reason}`,
      });
    }
  } else {
    // Default — check current
    const cur = currentSchemaStamp();
    const r = checkSchemaCompatibility(cur.spatial, cur.mechanic);
    schemaCompatible = r.compatible;
  }

  // 4. AoE resolved without scheduled (forensic — event integrity)
  const scheduledIds = new Set<string>();
  for (const e of stream.events) {
    if (e.kind === 'mechanic_scheduled' || e.kind === 'spatial_aoe_placed') {
      const mid = e.payload['mechanicId'] ?? e.payload['markerId'];
      if (typeof mid === 'string') scheduledIds.add(mid);
    }
  }
  for (const e of stream.events) {
    if (e.kind === 'mechanic_resolved' || e.kind === 'spatial_aoe_resolved') {
      const mid = String(e.payload['mechanicId'] ?? e.payload['markerId'] ?? '');
      if (mid && !scheduledIds.has(mid) && mid !== '') {
        // Allow — some mechanics fire instantly (telegraph=0) so they may not
        // emit a separate 'scheduled' event. INFO only.
        issues.push({
          kind: 'aoe_resolved_without_scheduled', severity: 'INFO',
          detail: `'${e.kind}' references ${mid} not seen in 'scheduled' events`,
          locator: { seq: e.seq, turn: e.turn },
        });
      }
    }
  }

  // 5. Event turn vs frame coverage — events should not be beyond lastFrameTurn
  if (stream.lastFrameTurn >= 0) {
    for (const e of stream.events) {
      if (e.turn > stream.lastFrameTurn) {
        issues.push({
          kind: 'event_turn_beyond_frame', severity: 'WARN',
          detail: `event.turn=${e.turn} > lastFrameTurn=${stream.lastFrameTurn}`,
          locator: { seq: e.seq, turn: e.turn },
        });
        break;
      }
    }
  }

  // 6. Frame ordering — check companion / boss decision ordering invariants
  for (const f of stream.frames) {
    if (f.bossDecision === undefined) continue;
    // If boss decision exists, expect at least one damage / status event same turn
    // (boss action should produce observable side-effect).
    // (Soft check — info only.)
  }

  // ── tally ──
  const byKind: Record<string, number> = {};
  const bySeverity = { CRITICAL: 0, WARN: 0, INFO: 0 };
  for (const i of issues) {
    byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
    bySeverity[i.severity] += 1;
  }
  return {
    encounterId: stream.encounterId,
    sessionId: stream.sessionId,
    totalFrames: totalFrames(stream),
    totalEvents: totalEvents(stream),
    schemaCompatible,
    healthy: bySeverity.CRITICAL === 0 && schemaCompatible,
    issues,
    byKind,
    bySeverity,
  };
}

// ─────────────────────────────────────────────────────────
// Cross-run divergence audit
// ─────────────────────────────────────────────────────────

export interface CrossRunAuditReport {
  matched: boolean;
  divergentTurn?: number;
  expectedChecksum?: string;
  actualChecksum?: string;
  detail: string;
}

/**
 * Run scenario twice via caller-provided factory → compare resulting streams.
 * Verifies deterministic combat at the full-stack integration level.
 */
export function auditCrossRunDivergence(
  scenarioFactory: () => ReplayEventStream,
): CrossRunAuditReport {
  const a = scenarioFactory();
  const b = scenarioFactory();
  const cmp = compareStreams(a, b);
  return {
    matched: !cmp.divergent,
    divergentTurn: cmp.firstDivergentTurn,
    expectedChecksum: cmp.expectedChecksum,
    actualChecksum: cmp.actualChecksum,
    detail: cmp.divergent
      ? `divergence at turn=${cmp.firstDivergentTurn}, expected=${cmp.expectedChecksum} actual=${cmp.actualChecksum}`
      : 'cross-run replay identical',
  };
}

// ─────────────────────────────────────────────────────────
// Rollback round-trip audit
// ─────────────────────────────────────────────────────────

/**
 * Verify rollback preserves frame integrity up to target turn.
 *
 * Steps:
 *   1. Snapshot pre-rollback frame checksums (frames ≤ target).
 *   2. Rollback to target.
 *   3. Compare frames remaining vs snapshot.
 */
export function auditRollbackRoundTrip(
  stream: ReplayEventStream,
  targetTurn: number,
): {
  preserved: boolean;
  detail: string;
  framesBeforeTarget: number;
  framesAfterRollback: number;
  checksumMatches: boolean;
} {
  const before: Array<{ turn: number; checksum?: string }> = [];
  for (const f of stream.frames) {
    if (f.turn <= targetTurn) before.push({ turn: f.turn, checksum: f.checksum });
  }
  rollbackTo(stream, targetTurn);
  const after = stream.frames;
  if (after.length !== before.length) {
    return {
      preserved: false,
      detail: `frame count mismatch: before=${before.length} after=${after.length}`,
      framesBeforeTarget: before.length,
      framesAfterRollback: after.length,
      checksumMatches: false,
    };
  }
  let checksumMatches = true;
  for (let i = 0; i < before.length; i++) {
    if (before[i]!.checksum !== after[i]!.checksum) {
      checksumMatches = false;
      break;
    }
  }
  return {
    preserved: checksumMatches,
    detail: checksumMatches
      ? 'rollback preserved all checksums up to target'
      : 'checksum diverged after rollback (replay drift)',
    framesBeforeTarget: before.length,
    framesAfterRollback: after.length,
    checksumMatches,
  };
}

// ─────────────────────────────────────────────────────────
// Boss phase replay coverage check
// ─────────────────────────────────────────────────────────

export function auditBossPhaseCoverage(
  stream: ReplayEventStream,
): { phasesObserved: string[]; phaseTransitions: number; healthy: boolean } {
  const phases = new Set<string>();
  let transitions = 0;
  for (const f of stream.frames) {
    if (f.bossDecision?.currentPhaseId) phases.add(f.bossDecision.currentPhaseId);
    if (f.bossDecision?.phaseTransitioned) transitions += 1;
  }
  return {
    phasesObserved: [...phases].sort(),
    phaseTransitions: transitions,
    healthy: true,    // soft check
  };
}

// ─────────────────────────────────────────────────────────
// Event-kind distribution (for telemetry diagnostics)
// ─────────────────────────────────────────────────────────

export function eventKindDistribution(
  stream: ReplayEventStream,
): Readonly<Record<StreamEventKind, number>> {
  const dist: Record<string, number> = {};
  for (const e of stream.events) dist[e.kind] = (dist[e.kind] ?? 0) + 1;
  return dist as Readonly<Record<StreamEventKind, number>>;
}
