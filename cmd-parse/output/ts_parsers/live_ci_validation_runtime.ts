/**
 * LIVE CI VALIDATION RUNTIME — CMD4 Phase 16 Module 1.
 *
 * Future-live deterministic CI integration layer. Composes Phase 15 M1
 * regression runtime + Phase 16 M4 scheduler + Phase 14 M3 multi-region
 * audit into a single replay-safe CI batch verification gate.
 *
 * Brief v16 §M1 responsibilities:
 *   1. replay-safe CI verification (deterministic rerun-stable)
 *   2. deterministic validation scheduling (via M4 scheduler)
 *   3. replay regression orchestration (via Phase 15 M1)
 *   4. canonical replay verification batching
 *   5. distributed replay validation aggregation
 *
 * MANDATORY (brief v16 §M1):
 *   same replay suite → same CI verification result ALWAYS.
 *
 * IMPORTANT:
 *   NO GitHub/GitLab API integration.
 *   Runtime orchestration ONLY.
 *
 * FORBIDDEN:
 *   runtime-dependent scheduling
 *   nondeterministic validation traversal
 *   replay-affecting CI metadata
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence.
 *
 * Ownership: tooling/validator layer (brief v16 §III). No networking,
 * no DB, no deployment.
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';
import type { ExportArtifact } from './deterministic_export_pipeline.js';
import {
  runReplayRegression,
  type RegressionReport,
} from './automated_replay_regression_runtime.js';
import { ImmutableSnapshotArchive } from './immutable_snapshot_archive.js';
import {
  scheduleDistributedValidation,
  type DistributedValidationSchedule,
} from './distributed_validation_scheduler_runtime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const LIVE_CI_VALIDATION_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface CiJob {
  /** Unique job id (= shard_id in scheduler). */
  readonly shard_id: string;
  /** Priority for scheduling (INT). Higher = earlier. */
  readonly priority: number;
  readonly artifact: ExportArtifact;
  /** Optional baseline_label for regression diff (archive lookup). */
  readonly baseline_label?: string;
}

export interface CiJobResult {
  readonly shard_id: string;
  readonly priority: number;
  readonly artifact_hash: string;
  readonly regression_ok: boolean;
  readonly regression_hash: string;
  /** True iff regression.ok (the gate). */
  readonly job_ok: boolean;
}

export interface LiveCiOptions {
  readonly batch_size?: number;
}

export interface LiveCiRunReport {
  readonly runtime_version: number;
  readonly job_count: number;
  readonly schedule_hash: string;
  /** Lex-sorted by shard_id (canonical view). */
  readonly jobs: readonly CiJobResult[];
  readonly all_jobs_ok: boolean;
  readonly ok: boolean;
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

// ═══════════════════════════════════════════════════════════════════════════
// Public API — runLiveCiValidation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run a deterministic CI batch:
 *   1. Schedule jobs via M4 scheduler (canonical (priority desc, shard_id asc)).
 *   2. For each scheduled job, run Phase 15 M1 `runReplayRegression`
 *      against the provided archive + optional baseline_label.
 *   3. Aggregate ok flag + canonical merge hash.
 *
 * Pure — same (archive snapshot, jobs, options) → same report bytes.
 * NEVER throws on CI failure — gate is `result.ok`. Throws on caller
 * bugs (dup shard_id, baseline_label not in archive).
 *
 * NOTE: `result.ok` inherits `runReplayRegression`'s REGRESSION-DETECTION
 * gating — a per-job fail fires whenever the candidate differs from
 * `archive.latest()`, even if `baseline_label` matches. For multi-release
 * rollout, use a per-release archive (see Phase 18 §6.3 pattern).
 */
export function runLiveCiValidation(
  archive: ImmutableSnapshotArchive,
  jobs: readonly CiJob[],
  options?: LiveCiOptions,
): LiveCiRunReport {
  // Validate caller inputs via scheduler (also handles dup/empty shard_id).
  const schedule: DistributedValidationSchedule = scheduleDistributedValidation(
    jobs.map((j) => ({ shard_id: j.shard_id, priority: j.priority })),
    options?.batch_size !== undefined ? { batch_size: options.batch_size } : undefined,
  );

  // Build shard_id → job lookup (O(1) per shard)
  const jobByShard = new Map<string, CiJob>();
  for (const j of jobs) jobByShard.set(j.shard_id, j);

  // Iterate schedule.merge_order (canonical execution order)
  const jobResults: CiJobResult[] = [];
  let allOk = true;
  for (const shardId of schedule.merge_order) {
    const j = jobByShard.get(shardId)!; // guaranteed present (scheduler validated)
    const regression: RegressionReport = runReplayRegression(
      archive,
      j.artifact,
      j.baseline_label !== undefined ? { baseline_label: j.baseline_label } : undefined,
    );
    const jobOk = regression.ok;
    if (!jobOk) allOk = false;
    jobResults.push(
      Object.freeze({
        shard_id: j.shard_id,
        priority: j.priority,
        artifact_hash: j.artifact.deterministic_hash,
        regression_ok: regression.ok,
        regression_hash: regression.deterministic_hash,
        job_ok: jobOk,
      }),
    );
  }

  // Canonical view: lex-sorted by shard_id (independent of execution order).
  const canonicalJobs = [...jobResults].sort((a, b) => lexCompare(a.shard_id, b.shard_id));
  const frozenJobs = Object.freeze(canonicalJobs.map((j) => j));

  const canonical = canonicalSerialize({
    runtime_version: LIVE_CI_VALIDATION_VERSION,
    job_count: jobs.length,
    schedule_hash: schedule.deterministic_hash,
    jobs: frozenJobs.map((j) => ({
      shard_id: j.shard_id,
      priority: j.priority,
      artifact_hash: j.artifact_hash,
      regression_ok: j.regression_ok,
      regression_hash: j.regression_hash,
      job_ok: j.job_ok,
    })),
    all_jobs_ok: allOk,
    ok: allOk,
  });

  return Object.freeze({
    runtime_version: LIVE_CI_VALIDATION_VERSION,
    job_count: jobs.length,
    schedule_hash: schedule.deterministic_hash,
    jobs: frozenJobs,
    all_jobs_ok: allOk,
    ok: allOk,
    deterministic_hash: fnv1a32(canonical),
  });
}
