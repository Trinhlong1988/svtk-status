/**
 * DISTRIBUTED VALIDATION SCHEDULER RUNTIME — CMD4 Phase 16 Module 4.
 *
 * MMO-scale deterministic scheduling primitive: takes a set of
 * validation jobs and emits a canonical execution plan (lex-sorted
 * batches + merge sequence). Same input → same schedule ALWAYS.
 *
 * Brief v16 §M4 responsibilities:
 *   1. deterministic validation scheduling
 *   2. replay-safe shard validation (schedule replayable)
 *   3. canonical distributed merge ordering (lex shard_id)
 *   4. replay reconstruction verification
 *   5. stable distributed replay hashing (FNV-1a over plan)
 *
 * MANDATORY (brief v16 §M4):
 *   same validation input → same distributed validation result ALWAYS.
 *
 * FORBIDDEN:
 *   transient scheduling / unstable shard traversal /
 *   locale-sensitive ordering / runtime-dependent validation merges.
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence.
 *
 * Ownership: tooling/validator layer (brief v16 §III). No networking,
 * no DB, no deployment — pure planning primitive.
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const DISTRIBUTED_VALIDATION_SCHEDULER_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface ValidationJob {
  readonly shard_id: string;
  /** Priority: higher = earlier. Integer required (caller-determined). */
  readonly priority: number;
}

export interface ScheduledBatch {
  readonly batch_index: number;
  readonly jobs: readonly ValidationJob[];
  /** FNV-1a of canonical(batch_index, jobs[*]). */
  readonly batch_hash: string;
}

export interface SchedulerOptions {
  /** Optional batch size (positive INT). Defaults to 1 batch containing all jobs. */
  readonly batch_size?: number;
}

export interface DistributedValidationSchedule {
  readonly scheduler_version: number;
  readonly job_count: number;
  /** Sorted (priority desc, shard_id asc) — canonical execution order. */
  readonly merge_order: readonly string[];
  /** Lex-sorted ScheduledBatch by batch_index. */
  readonly batches: readonly ScheduledBatch[];
  /** FNV-1a of canonical full plan. */
  readonly deterministic_hash: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers — direct codepoint compare
// ═══════════════════════════════════════════════════════════════════════════

function lexCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function intCompare(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function validateJobs(jobs: readonly ValidationJob[]): void {
  const seen = new Set<string>();
  for (const j of jobs) {
    if (typeof j.shard_id !== 'string' || j.shard_id.length === 0) {
      throw new Error('distributed_validation_scheduler_runtime: shard_id must be non-empty string');
    }
    if (!Number.isSafeInteger(j.priority)) {
      throw new Error(
        `distributed_validation_scheduler_runtime: priority must be safe integer at shard_id "${j.shard_id}"`,
      );
    }
    if (seen.has(j.shard_id)) {
      throw new Error(`distributed_validation_scheduler_runtime: duplicate shard_id "${j.shard_id}"`);
    }
    seen.add(j.shard_id);
  }
}

function jobCanonical(j: ValidationJob): { shard_id: string; priority: number } {
  return { shard_id: j.shard_id, priority: j.priority };
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — scheduleDistributedValidation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a deterministic execution schedule.
 *
 * Sorting policy:
 *   - Primary: priority DESC (high priority first)
 *   - Secondary: shard_id ASC (lex codepoint)
 *   - Canonical merge order = the full sorted list of shard_ids
 *
 * Batching: if `batch_size` is provided (positive INT), jobs are
 * partitioned into consecutive batches of up to `batch_size` jobs in
 * sort order. Otherwise: a single batch containing all jobs.
 *
 * Pure — same input (any insertion order) → same schedule bytes ALWAYS.
 *
 * Throws on caller bugs (empty/dup shard_id, non-INT priority, batch_size ≤ 0).
 */
export function scheduleDistributedValidation(
  jobs: readonly ValidationJob[],
  options?: SchedulerOptions,
): DistributedValidationSchedule {
  validateJobs(jobs);

  const batchSize = options?.batch_size;
  if (batchSize !== undefined) {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new Error(
        `distributed_validation_scheduler_runtime: batch_size must be positive safe integer, got ${String(batchSize)}`,
      );
    }
  }

  // Canonical sort: priority desc, shard_id asc.
  const sorted = [...jobs].sort((a, b) => {
    const pc = intCompare(b.priority, a.priority); // DESC
    if (pc !== 0) return pc;
    return lexCompare(a.shard_id, b.shard_id);
  });

  const mergeOrder = Object.freeze(sorted.map((j) => j.shard_id));

  // Batching
  const effectiveBatchSize = batchSize ?? Math.max(sorted.length, 1);
  const batches: ScheduledBatch[] = [];
  for (let i = 0; i < sorted.length; i += effectiveBatchSize) {
    const slice = sorted.slice(i, i + effectiveBatchSize);
    const batchIndex = Math.floor(i / effectiveBatchSize);
    const batchCanonical = canonicalSerialize({
      batch_index: batchIndex,
      jobs: slice.map(jobCanonical),
    });
    batches.push(
      Object.freeze({
        batch_index: batchIndex,
        jobs: Object.freeze(slice.map((j) => Object.freeze({ shard_id: j.shard_id, priority: j.priority }))),
        batch_hash: fnv1a32(batchCanonical),
      }),
    );
  }
  const frozenBatches = Object.freeze([...batches]);

  const canonical = canonicalSerialize({
    scheduler_version: DISTRIBUTED_VALIDATION_SCHEDULER_VERSION,
    job_count: sorted.length,
    merge_order: mergeOrder,
    batches: frozenBatches.map((b) => ({
      batch_index: b.batch_index,
      jobs: b.jobs.map(jobCanonical),
      batch_hash: b.batch_hash,
    })),
  });

  return Object.freeze({
    scheduler_version: DISTRIBUTED_VALIDATION_SCHEDULER_VERSION,
    job_count: sorted.length,
    merge_order: mergeOrder,
    batches: frozenBatches,
    deterministic_hash: fnv1a32(canonical),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — verifyScheduleReplay
// ═══════════════════════════════════════════════════════════════════════════

export interface ScheduleVerifyResult {
  readonly ok: boolean;
  readonly merge_order_recompute_match: boolean;
  readonly batch_hashes_match: boolean;
  readonly top_hash_recompute_match: boolean;
  readonly first_bad_batch_index: number | null;
}

/**
 * Replay-verify an existing schedule against a fresh input. Useful for
 * proving a stored schedule recomputes from the same job list deterministically.
 */
export function verifyScheduleReplay(
  jobs: readonly ValidationJob[],
  expected: DistributedValidationSchedule,
  options?: SchedulerOptions,
): ScheduleVerifyResult {
  const rebuilt = scheduleDistributedValidation(jobs, options);

  const mergeOrderMatch =
    rebuilt.merge_order.length === expected.merge_order.length &&
    rebuilt.merge_order.every((s, i) => s === expected.merge_order[i]);

  let firstBad: number | null = null;
  let batchHashesMatch = rebuilt.batches.length === expected.batches.length;
  if (batchHashesMatch) {
    for (let i = 0; i < rebuilt.batches.length; i++) {
      if (rebuilt.batches[i]!.batch_hash !== expected.batches[i]!.batch_hash) {
        batchHashesMatch = false;
        firstBad = rebuilt.batches[i]!.batch_index;
        break;
      }
    }
  }

  const topHashMatch = rebuilt.deterministic_hash === expected.deterministic_hash;

  return Object.freeze({
    ok: mergeOrderMatch && batchHashesMatch && topHashMatch,
    merge_order_recompute_match: mergeOrderMatch,
    batch_hashes_match: batchHashesMatch,
    top_hash_recompute_match: topHashMatch,
    first_bad_batch_index: firstBad,
  });
}
