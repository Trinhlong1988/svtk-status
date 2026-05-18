/**
 * ROLLBACK AUDIT LOG — append-only forensic log of every rollback op (Phase 12 ADVANCED).
 *
 * Per CMD1 1.docx Phase 12 ADVANCED § VII:
 *   "EXPAND combat forensic exports. SUPPORT:
 *      - rollback audit logs
 *      - orchestration forensic reports
 *      - combat divergence diagnostics
 *    RULE: forensic metadata MUST NOT affect replay determinism."
 *
 * Wraps the existing `rollbackTo(stream, targetTurn)` in `replay_event_stream.ts`
 * with deterministic audit log capture: target turn / frames dropped / events
 * dropped / reason / deterministic-clock timestamp.
 *
 * The audit log is FORENSIC ONLY — does NOT affect combat math or replay
 * checksum. Server-authoritative caller can persist it via `CombatStorage`
 * (separate channel) or inspect for production diagnostics.
 *
 * STRICT additive — wraps existing rollback API. Same call → same audit entry.
 */
import { rollbackTo, type ReplayEventStream } from './replay_event_stream.js';
import { currentClock } from './deterministic_clock.js';

export const ROLLBACK_AUDIT_SCHEMA_VERSION = 1;

export type RollbackReason =
  | 'server_correction'      // server divergence corrected by replaying from checkpoint
  | 'client_resync'          // client requested resync after disconnect
  | 'test_harness'           // test/audit harness simulated rollback
  | 'admin_intervention'     // GM/operator manual rollback (rare)
  | 'unknown';               // default fallback — caller should specify

export interface RollbackAuditEntry {
  schemaVersion: number;
  encounterId: string;
  /** Monotonic audit sequence within the log. */
  auditSeq: number;
  /** Turn that the stream was rolled back to (inclusive). */
  targetTurn: number;
  /** Frame count that was dropped by the rollback. */
  framesDropped: number;
  /** Event count that was dropped by the rollback. */
  eventsDropped: number;
  /** Caller-supplied reason for the rollback. */
  reason: RollbackReason;
  /** Deterministic-clock timestamp (turn-derived when orchestrator-managed). */
  timestamp: string;
  /** Optional caller note — forensic context. */
  note?: string;
}

export interface RollbackAuditLog {
  schemaVersion: number;
  encounterId: string;
  /** Append-only entries; index in array = audit seq. */
  entries: RollbackAuditEntry[];
  /** Monotonic seq for next entry. */
  nextSeq: number;
}

export function createRollbackAuditLog(encounterId: string): RollbackAuditLog {
  return {
    schemaVersion: ROLLBACK_AUDIT_SCHEMA_VERSION,
    encounterId,
    entries: [],
    nextSeq: 0,
  };
}

// ─────────────────────────────────────────────────────────
// Audited rollback — wrapper around replay_event_stream § rollbackTo
// ─────────────────────────────────────────────────────────

export interface AuditedRollbackOptions {
  reason?: RollbackReason;
  note?: string;
}

export interface AuditedRollbackResult {
  framesDropped: number;
  eventsDropped: number;
  entry: RollbackAuditEntry;
}

/**
 * Perform rollback on the stream AND record an audit entry. Same call →
 * same entry shape (timestamp deterministic when orchestrator-managed clock
 * is installed, wall clock otherwise).
 *
 * Throws if `auditLog.encounterId !== stream.encounterId` — guard against
 * cross-encounter contamination.
 */
export function auditedRollback(
  stream: ReplayEventStream,
  auditLog: RollbackAuditLog,
  targetTurn: number,
  opts: AuditedRollbackOptions = {},
): AuditedRollbackResult {
  if (auditLog.encounterId !== stream.encounterId) {
    throw new Error(
      `[RollbackAudit] encounterId mismatch: audit='${auditLog.encounterId}' stream='${stream.encounterId}'`,
    );
  }
  const { framesDropped, eventsDropped } = rollbackTo(stream, targetTurn);
  const entry: RollbackAuditEntry = {
    schemaVersion: ROLLBACK_AUDIT_SCHEMA_VERSION,
    encounterId: stream.encounterId,
    auditSeq: auditLog.nextSeq++,
    targetTurn,
    framesDropped,
    eventsDropped,
    reason: opts.reason ?? 'unknown',
    timestamp: currentClock().nowIso(),
    ...(opts.note !== undefined && { note: opts.note }),
  };
  auditLog.entries.push(entry);
  return { framesDropped, eventsDropped, entry };
}

// ─────────────────────────────────────────────────────────
// Query helpers
// ─────────────────────────────────────────────────────────

export function totalRollbacks(auditLog: RollbackAuditLog): number {
  return auditLog.entries.length;
}

export function entriesByReason(
  auditLog: RollbackAuditLog,
  reason: RollbackReason,
): readonly RollbackAuditEntry[] {
  return auditLog.entries.filter((e) => e.reason === reason);
}

export function lastEntry(auditLog: RollbackAuditLog): RollbackAuditEntry | undefined {
  return auditLog.entries[auditLog.entries.length - 1];
}

/** Total frames dropped across all rollbacks (production diagnostic). */
export function cumulativeFramesDropped(auditLog: RollbackAuditLog): number {
  let total = 0;
  for (const e of auditLog.entries) total += e.framesDropped;
  return total;
}

/** Total events dropped across all rollbacks. */
export function cumulativeEventsDropped(auditLog: RollbackAuditLog): number {
  let total = 0;
  for (const e of auditLog.entries) total += e.eventsDropped;
  return total;
}

// ─────────────────────────────────────────────────────────
// Serialization — wire/persistence ready
// ─────────────────────────────────────────────────────────

/**
 * Serialize audit log to a stable, canonical JSON-safe object.
 *
 * Use case: pass to `CombatStorage.appendReplayChunk` (as side log) OR
 * publish to forensic dashboard. Same log → same serialized output.
 */
export function serializeAuditLog(auditLog: RollbackAuditLog): {
  schemaVersion: number;
  encounterId: string;
  entries: readonly RollbackAuditEntry[];
  totalEntries: number;
  totalFramesDropped: number;
  totalEventsDropped: number;
} {
  return {
    schemaVersion: auditLog.schemaVersion,
    encounterId: auditLog.encounterId,
    entries: auditLog.entries,
    totalEntries: auditLog.entries.length,
    totalFramesDropped: cumulativeFramesDropped(auditLog),
    totalEventsDropped: cumulativeEventsDropped(auditLog),
  };
}
