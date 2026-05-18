/**
 * REPLAY TIMELINE EXPORT — ordered forensic timeline (Phase 13).
 *
 * Per CMD1 1.docx Phase 13 § 5 "Forensic replay tooling":
 *   - divergence diagnostics  (Phase 12 ADV — combat_divergence_diagnostics.ts)
 *   - replay timeline export  (THIS module)
 *   - rollback forensic report (Phase 12 ADV — rollback_audit_log.ts)
 *   - orchestration audit traces (Phase 11 — combat_integration_audit.ts)
 *
 * Produces a unified, time-ordered forensic timeline combining:
 *   - sealed replay frames (per-turn checksum)
 *   - stream events (intra-turn ordering, sanitized)
 *   - rollback audit entries (from rollback_audit_log)
 *   - checkpoint markers (from checkpoint_scheduler)
 *
 * Output is JSON-safe + canonical ordered → wire-ready for dashboards.
 *
 * MANDATORY rule (1.docx Phase 13):
 *   "forensic metadata MUST NOT affect replay determinism."
 *
 * Pure read function — does NOT mutate any source. Same inputs → same export.
 */
import type { ReplayEventStream } from './replay_event_stream.js';
import type { ReplayFrame } from './replay_frame.js';
import type { RollbackAuditLog, RollbackAuditEntry } from './rollback_audit_log.js';
import type { CheckpointSchedulerState, CheckpointEntry } from './checkpoint_scheduler.js';
import { canonicalJson, canonicalHash } from './combat_storage.js';

export const TIMELINE_EXPORT_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────
// Timeline entry — discriminated union
// ─────────────────────────────────────────────────────────

export type TimelineEntry =
  | TimelineFrameEntry
  | TimelineEventEntry
  | TimelineRollbackEntry
  | TimelineCheckpointEntry;

export interface TimelineFrameEntry {
  kind: 'frame';
  /** Sorting key: turn × 1000 ordering tier (frames are highest tier per turn). */
  sortKey: number;
  turn: number;
  checksum: string;
}

export interface TimelineEventEntry {
  kind: 'event';
  /** Sorting key: turn × 1000 + seq tier. */
  sortKey: number;
  turn: number;
  eventSeq: number;
  eventKind: string;
  /** Canonical JSON of sanitized payload — caller passed sanitizer already in appendEvent. */
  payloadJson: string;
}

export interface TimelineRollbackEntry {
  kind: 'rollback';
  sortKey: number;
  /** Turn that the rollback targeted. */
  targetTurn: number;
  auditSeq: number;
  reason: string;
  framesDropped: number;
  eventsDropped: number;
  timestamp: string;
}

export interface TimelineCheckpointEntry {
  kind: 'checkpoint';
  sortKey: number;
  turn: number;
  checkpointSeq: number;
  reason: string;
  frameCountAtCheckpoint: number;
  chunkSeq?: number;
  timestamp: string;
}

// ─────────────────────────────────────────────────────────
// Export envelope
// ─────────────────────────────────────────────────────────

export interface TimelineExport {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  /** Timeline entries in canonical sort order. */
  entries: readonly TimelineEntry[];
  /** Aggregate counts for dashboard. */
  summary: {
    totalEntries: number;
    totalFrames: number;
    totalEvents: number;
    totalRollbacks: number;
    totalCheckpoints: number;
    firstTurn: number;
    lastTurn: number;
  };
  /** Stable digest of entire timeline — wire integrity check. */
  digest: string;
}

// ─────────────────────────────────────────────────────────
// Builder inputs
// ─────────────────────────────────────────────────────────

export interface TimelineExportInputs {
  /** Replay stream — frames + events. */
  stream: ReplayEventStream;
  /** Optional rollback audit log (same encounterId required). */
  rollbackLog?: RollbackAuditLog;
  /** Optional checkpoint scheduler state (same encounterId required). */
  checkpointScheduler?: CheckpointSchedulerState;
  /** Filter — only emit entries for turns in this range (inclusive). */
  turnRange?: { from: number; to: number };
}

// ─────────────────────────────────────────────────────────
// Builder
// ─────────────────────────────────────────────────────────

/**
 * Build the timeline export.
 *
 * Sort ordering: by `sortKey` ascending; within same turn the order is:
 *   1. checkpoint markers (turn × 1000 + 0)
 *   2. event entries     (turn × 1000 + 1 + eventSeq mod 1000 — preserves intra-turn order)
 *   3. frame entry       (turn × 1000 + 999 — frame seals at end of turn)
 *   4. rollback entries  (turn × 1000 + 998 — rollback happens before next-turn open)
 *
 * Same inputs → same TimelineExport (digest stable).
 */
export function buildTimelineExport(inputs: TimelineExportInputs): TimelineExport {
  // Validate encounter ids match
  const eid = inputs.stream.encounterId;
  if (inputs.rollbackLog && inputs.rollbackLog.encounterId !== eid) {
    throw new Error(
      `[TimelineExport] rollbackLog encounterId mismatch: '${inputs.rollbackLog.encounterId}' vs '${eid}'`,
    );
  }
  if (inputs.checkpointScheduler && inputs.checkpointScheduler.encounterId !== eid) {
    throw new Error(
      `[TimelineExport] checkpointScheduler encounterId mismatch: '${inputs.checkpointScheduler.encounterId}' vs '${eid}'`,
    );
  }

  const entries: TimelineEntry[] = [];
  const inRange = (turn: number): boolean => {
    if (!inputs.turnRange) return true;
    return turn >= inputs.turnRange.from && turn <= inputs.turnRange.to;
  };

  // Frames
  for (const f of inputs.stream.frames) {
    if (!inRange(f.turn)) continue;
    entries.push(buildFrameEntry(f));
  }

  // Events
  for (const e of inputs.stream.events) {
    if (!inRange(e.turn)) continue;
    entries.push({
      kind: 'event',
      sortKey: e.turn * 1000 + 1 + Math.min(e.seq % 998, 997),
      turn: e.turn,
      eventSeq: e.seq,
      eventKind: e.kind,
      payloadJson: canonicalJson(e.payload),
    });
  }

  // Rollback entries
  if (inputs.rollbackLog) {
    for (const r of inputs.rollbackLog.entries) {
      if (!inRange(r.targetTurn)) continue;
      entries.push(buildRollbackEntry(r));
    }
  }

  // Checkpoint entries
  if (inputs.checkpointScheduler) {
    for (const c of inputs.checkpointScheduler.history) {
      if (!inRange(c.turn)) continue;
      entries.push(buildCheckpointEntry(c));
    }
  }

  // Canonical sort — sortKey asc, tie-breakers preserve original ordering
  // (eventSeq for events, checkpointSeq for checkpoints, auditSeq for rollbacks)
  entries.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
    // Tie-breaker by kind for stability
    const kindOrder: Record<TimelineEntry['kind'], number> = {
      checkpoint: 0, event: 1, frame: 2, rollback: 3,
    };
    if (kindOrder[a.kind] !== kindOrder[b.kind]) {
      return kindOrder[a.kind] - kindOrder[b.kind];
    }
    // Within same kind — by seq
    if (a.kind === 'event' && b.kind === 'event') return a.eventSeq - b.eventSeq;
    if (a.kind === 'checkpoint' && b.kind === 'checkpoint') return a.checkpointSeq - b.checkpointSeq;
    if (a.kind === 'rollback' && b.kind === 'rollback') return a.auditSeq - b.auditSeq;
    return 0;
  });

  // Aggregate summary
  let totalFrames = 0, totalEvents = 0, totalRollbacks = 0, totalCheckpoints = 0;
  let firstTurn = Number.POSITIVE_INFINITY, lastTurn = Number.NEGATIVE_INFINITY;
  for (const e of entries) {
    const t = entryTurn(e);
    if (t < firstTurn) firstTurn = t;
    if (t > lastTurn) lastTurn = t;
    switch (e.kind) {
      case 'frame': totalFrames++; break;
      case 'event': totalEvents++; break;
      case 'rollback': totalRollbacks++; break;
      case 'checkpoint': totalCheckpoints++; break;
    }
  }
  if (entries.length === 0) {
    firstTurn = -1; lastTurn = -1;
  }

  const exportObj: TimelineExport = {
    schemaVersion: TIMELINE_EXPORT_SCHEMA_VERSION,
    encounterId: eid,
    sessionId: inputs.stream.sessionId,
    entries,
    summary: {
      totalEntries: entries.length,
      totalFrames, totalEvents, totalRollbacks, totalCheckpoints,
      firstTurn, lastTurn,
    },
    digest: '',           // placeholder, computed below
  };
  exportObj.digest = canonicalHash({ ...exportObj, digest: '' });
  return exportObj;
}

function buildFrameEntry(f: ReplayFrame): TimelineFrameEntry {
  return {
    kind: 'frame',
    sortKey: f.turn * 1000 + 999,
    turn: f.turn,
    checksum: f.checksum ?? '',
  };
}

function buildRollbackEntry(r: RollbackAuditEntry): TimelineRollbackEntry {
  return {
    kind: 'rollback',
    sortKey: r.targetTurn * 1000 + 998,
    targetTurn: r.targetTurn,
    auditSeq: r.auditSeq,
    reason: r.reason,
    framesDropped: r.framesDropped,
    eventsDropped: r.eventsDropped,
    timestamp: r.timestamp,
  };
}

function buildCheckpointEntry(c: CheckpointEntry): TimelineCheckpointEntry {
  return {
    kind: 'checkpoint',
    sortKey: c.turn * 1000 + 0,
    turn: c.turn,
    checkpointSeq: c.checkpointSeq,
    reason: c.reason,
    frameCountAtCheckpoint: c.frameCountAtCheckpoint,
    ...(c.chunkSeq !== undefined && { chunkSeq: c.chunkSeq }),
    timestamp: c.timestamp,
  };
}

function entryTurn(e: TimelineEntry): number {
  switch (e.kind) {
    case 'frame': return e.turn;
    case 'event': return e.turn;
    case 'rollback': return e.targetTurn;
    case 'checkpoint': return e.turn;
  }
}

// ─────────────────────────────────────────────────────────
// Serialization
// ─────────────────────────────────────────────────────────

/**
 * Serialize timeline export to canonical JSON wire bytes.
 */
export function serializeTimelineExport(exp: TimelineExport): string {
  return canonicalJson(exp);
}

/**
 * Compare two timeline exports — returns whether their digests match.
 * Use case: server-vs-client replay reconciliation, dashboard integrity check.
 */
export function compareTimelineExports(
  a: TimelineExport,
  b: TimelineExport,
): { identical: boolean; reason?: string } {
  if (a.digest !== b.digest) {
    return { identical: false, reason: `digest mismatch: ${a.digest} vs ${b.digest}` };
  }
  if (a.entries.length !== b.entries.length) {
    return { identical: false, reason: `entry count: ${a.entries.length} vs ${b.entries.length}` };
  }
  return { identical: true };
}
