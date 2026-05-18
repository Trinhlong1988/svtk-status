/**
 * CHECKPOINT SCHEDULER — periodic auto-snapshot during encounter (Phase 13).
 *
 * Per CMD1 1.docx Phase 13 § 1 "checkpoint restore" + 1.docx Phase 13
 * "operational combat integration":
 *
 * Long-running encounters (raid bosses, multi-stage fights) need periodic
 * snapshots to limit data loss on server crash + enable rollback recovery
 * to near-current turn. This module wraps the existing `saveSnapshot` +
 * `appendReplayChunk` (Phase 12 INIT) with a deterministic scheduler.
 *
 * Scheduler policy options:
 *   - every N turns (default 10)
 *   - every M sealed frames (default 50)
 *   - per-encounter cap (default 100 checkpoints to bound storage)
 *
 * STRICT additive — does NOT mutate `combat_runtime.ts` or the orchestrator.
 * Caller invokes `maybeCheckpoint(scheduler, rt, storage)` per turn (typically
 * inside `onCombatEnd` orchestrator stage callback).
 *
 * Pure deterministic — same encounter state + same policy → same checkpoint
 * sequence ALWAYS.
 */
import type { CombatRuntime } from './combat_runtime.js';
import type { CombatStorage, CombatSnapshot } from './combat_storage.js';
import {
  saveSnapshot,
  appendReplayChunk,
  snapshotReplayAsChunk,
} from './persistence_snapshot.js';
import { currentClock } from './deterministic_clock.js';

export const CHECKPOINT_SCHEDULER_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────
// Policy + state
// ─────────────────────────────────────────────────────────

export interface CheckpointPolicy {
  /** Save snapshot every N turn (≥ 1). Default 10. */
  everyNTurns: number;
  /** Also save when frames since last checkpoint ≥ M. Default 50. */
  everyMFrames: number;
  /** Cap on total checkpoints per encounter. Default 100. Set 0 = unlimited. */
  maxCheckpoints: number;
  /**
   * Whether to also append a replay chunk per checkpoint (incremental persistence).
   * Default true. If false, only snapshot is saved (lighter, but recovery has
   * no incremental replay log).
   */
  appendReplayChunk: boolean;
}

export const DEFAULT_CHECKPOINT_POLICY: CheckpointPolicy = Object.freeze({
  everyNTurns: 10,
  everyMFrames: 50,
  maxCheckpoints: 100,
  appendReplayChunk: true,
});

export interface CheckpointSchedulerState {
  schemaVersion: number;
  encounterId: string;
  policy: CheckpointPolicy;
  /** Turn of last checkpoint, -1 = none yet. */
  lastCheckpointTurn: number;
  /** Frame count at last checkpoint. */
  lastCheckpointFrameCount: number;
  /** Total checkpoints created. */
  checkpointCount: number;
  /** Per-checkpoint log (forensic trace). */
  history: CheckpointEntry[];
  /** Next chunkSeq for incremental replay chunks. */
  nextChunkSeq: number;
}

export interface CheckpointEntry {
  /** Monotonic seq within scheduler (== history index). */
  checkpointSeq: number;
  turn: number;
  frameCountAtCheckpoint: number;
  /** Reason that triggered the checkpoint. */
  reason: 'turn_threshold' | 'frame_threshold' | 'manual';
  /** Deterministic-clock timestamp. */
  timestamp: string;
  /** chunkSeq if replay chunk was appended (undefined if appendReplayChunk=false). */
  chunkSeq?: number;
}

export function createCheckpointScheduler(
  encounterId: string,
  policy: Partial<CheckpointPolicy> = {},
): CheckpointSchedulerState {
  const resolvedPolicy: CheckpointPolicy = {
    everyNTurns: policy.everyNTurns ?? DEFAULT_CHECKPOINT_POLICY.everyNTurns,
    everyMFrames: policy.everyMFrames ?? DEFAULT_CHECKPOINT_POLICY.everyMFrames,
    maxCheckpoints: policy.maxCheckpoints ?? DEFAULT_CHECKPOINT_POLICY.maxCheckpoints,
    appendReplayChunk: policy.appendReplayChunk ?? DEFAULT_CHECKPOINT_POLICY.appendReplayChunk,
  };
  if (resolvedPolicy.everyNTurns < 1) {
    throw new Error('[CheckpointPolicy] everyNTurns must be ≥ 1');
  }
  if (resolvedPolicy.everyMFrames < 1) {
    throw new Error('[CheckpointPolicy] everyMFrames must be ≥ 1');
  }
  return {
    schemaVersion: CHECKPOINT_SCHEDULER_SCHEMA_VERSION,
    encounterId,
    policy: resolvedPolicy,
    lastCheckpointTurn: -1,
    lastCheckpointFrameCount: 0,
    checkpointCount: 0,
    history: [],
    nextChunkSeq: 0,
  };
}

// ─────────────────────────────────────────────────────────
// Per-turn checkpoint decision
// ─────────────────────────────────────────────────────────

export interface CheckpointResult {
  triggered: boolean;
  entry?: CheckpointEntry;
  snapshot?: CombatSnapshot;
  reason?: CheckpointEntry['reason'];
  /** True if max checkpoint cap reached — further checkpoints suppressed. */
  capReached?: boolean;
}

/**
 * Evaluate policy at end of a turn — if any threshold met, save a checkpoint.
 *
 * Caller pattern (inside orchestrator `onCombatEnd` callback):
 *   ```
 *   maybeCheckpoint(scheduler, rt, storage);
 *   ```
 *
 * Deterministic: same rt state + same scheduler state + same policy →
 * same checkpoint decision ALWAYS.
 */
export function maybeCheckpoint(
  scheduler: CheckpointSchedulerState,
  rt: CombatRuntime,
  storage: CombatStorage,
): CheckpointResult {
  if (scheduler.encounterId !== rt.config.encounterId) {
    throw new Error(
      `[CheckpointScheduler] encounterId mismatch: scheduler='${scheduler.encounterId}' rt='${rt.config.encounterId}'`,
    );
  }

  // Cap check
  if (scheduler.policy.maxCheckpoints > 0
      && scheduler.checkpointCount >= scheduler.policy.maxCheckpoints) {
    return { triggered: false, capReached: true };
  }

  // Decide trigger reason
  const turn = rt.currentTurn;
  const framesNow = rt.replayStream.frames.length;
  const turnsSinceLast = scheduler.lastCheckpointTurn === -1
    ? turn + 1                                          // first-checkpoint case (treat starting turn 0 as 1 elapsed)
    : turn - scheduler.lastCheckpointTurn;
  const framesSinceLast = framesNow - scheduler.lastCheckpointFrameCount;

  let reason: CheckpointEntry['reason'] | undefined;
  if (turnsSinceLast >= scheduler.policy.everyNTurns) {
    reason = 'turn_threshold';
  } else if (framesSinceLast >= scheduler.policy.everyMFrames) {
    reason = 'frame_threshold';
  } else {
    return { triggered: false };
  }

  return performCheckpoint(scheduler, rt, storage, reason);
}

/**
 * Force a checkpoint immediately, regardless of policy thresholds.
 * Useful for boss-phase transitions, raid wipe detection, GM operations.
 */
export function forceCheckpoint(
  scheduler: CheckpointSchedulerState,
  rt: CombatRuntime,
  storage: CombatStorage,
): CheckpointResult {
  if (scheduler.encounterId !== rt.config.encounterId) {
    throw new Error(
      `[CheckpointScheduler] encounterId mismatch: scheduler='${scheduler.encounterId}' rt='${rt.config.encounterId}'`,
    );
  }
  // Cap check still applies — but we explicitly bypass it when manually forced?
  // Decision: respect cap to avoid unbounded storage growth.
  if (scheduler.policy.maxCheckpoints > 0
      && scheduler.checkpointCount >= scheduler.policy.maxCheckpoints) {
    return { triggered: false, capReached: true };
  }
  return performCheckpoint(scheduler, rt, storage, 'manual');
}

// ─────────────────────────────────────────────────────────
// Internal checkpoint write
// ─────────────────────────────────────────────────────────

function performCheckpoint(
  scheduler: CheckpointSchedulerState,
  rt: CombatRuntime,
  storage: CombatStorage,
  reason: CheckpointEntry['reason'],
): CheckpointResult {
  const snapshot = saveSnapshot(rt, storage);
  let chunkSeqUsed: number | undefined;
  if (scheduler.policy.appendReplayChunk) {
    chunkSeqUsed = scheduler.nextChunkSeq;
    // DELTA CHECKPOINT (CMD1 1.docx Phase 13 FIX #3): chunk contains ONLY
    // frames/events added SINCE the last checkpoint. First checkpoint
    // (lastCheckpointTurn === -1) → chunk has whole stream from turn 0.
    // Subsequent → chunk starts at lastCheckpointTurn + 1.
    const fromTurn = scheduler.lastCheckpointTurn === -1
      ? undefined
      : scheduler.lastCheckpointTurn + 1;
    appendReplayChunk(storage, snapshotReplayAsChunk(rt, chunkSeqUsed, fromTurn));
    scheduler.nextChunkSeq++;
  }
  const entry: CheckpointEntry = {
    checkpointSeq: scheduler.checkpointCount,
    turn: rt.currentTurn,
    frameCountAtCheckpoint: rt.replayStream.frames.length,
    reason,
    timestamp: currentClock().nowIso(),
    ...(chunkSeqUsed !== undefined && { chunkSeq: chunkSeqUsed }),
  };
  scheduler.history.push(entry);
  scheduler.checkpointCount++;
  scheduler.lastCheckpointTurn = rt.currentTurn;
  scheduler.lastCheckpointFrameCount = rt.replayStream.frames.length;
  return { triggered: true, entry, snapshot, reason };
}

// ─────────────────────────────────────────────────────────
// Query helpers
// ─────────────────────────────────────────────────────────

export function checkpointCount(scheduler: CheckpointSchedulerState): number {
  return scheduler.checkpointCount;
}

export function lastCheckpoint(
  scheduler: CheckpointSchedulerState,
): CheckpointEntry | undefined {
  return scheduler.history[scheduler.history.length - 1];
}

export function checkpointHistoryByReason(
  scheduler: CheckpointSchedulerState,
  reason: CheckpointEntry['reason'],
): readonly CheckpointEntry[] {
  return scheduler.history.filter((e) => e.reason === reason);
}

/**
 * Stable hash of checkpoint sequence — forensic verification.
 * Same scheduler history → same hash ALWAYS.
 */
export function checkpointSequenceHash(scheduler: CheckpointSchedulerState): string {
  let h = 0x811c9dc5 >>> 0;
  const eat = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const e of scheduler.history) {
    eat(`${e.checkpointSeq}|${e.turn}|${e.reason}|${e.frameCountAtCheckpoint}|${e.chunkSeq ?? -1}`);
  }
  return h.toString(16).padStart(8, '0');
}
