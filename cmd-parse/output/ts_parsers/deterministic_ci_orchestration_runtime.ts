/**
 * DETERMINISTIC CI ORCHESTRATION RUNTIME — CMD4 Phase 17 Module 1.
 *
 * Suite-level deterministic CI orchestration. Groups jobs into per-region
 * batches and runs each batch via Phase 16 M1 `runLiveCiValidation`, then
 * aggregates a canonical suite-level report.
 *
 * Brief v17 §M1 responsibilities:
 *   1. replay-safe CI batching (canonical groupings)
 *   2. deterministic validation scheduling (via Phase 16 M4 / M1)
 *   3. replay regression orchestration (via Phase 15 M1)
 *   4. canonical replay verification grouping (lex by region)
 *   5. stable CI replay hashing (FNV-1a chained over batches)
 *
 * MANDATORY (brief v17 §M1):
 *   same replay suite → same CI result ALWAYS.
 *
 * FORBIDDEN:
 *   runtime-dependent scheduling
 *   transient validation ordering
 *   replay-affecting CI metadata
 *   nondeterministic replay batching
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence.
 *
 * Ownership: tooling/validator layer (brief v17 §III).
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';
import type { ExportArtifact } from './deterministic_export_pipeline.js';
import { ImmutableSnapshotArchive } from './immutable_snapshot_archive.js';
import {
  runLiveCiValidation,
  type CiJob,
  type LiveCiRunReport,
} from './live_ci_validation_runtime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const DETERMINISTIC_CI_ORCHESTRATION_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface CiSuiteJob {
  readonly region: string;
  /** Unique within region — (region, shard_id) is composite key. */
  readonly shard_id: string;
  readonly priority: number;
  readonly artifact: ExportArtifact;
  readonly baseline_label?: string;
}

export interface CiBatchReport {
  readonly region: string;
  readonly job_count: number;
  readonly batch_ok: boolean;
  /** Live CI report deterministic hash for this region's batch. */
  readonly batch_hash: string;
}

export interface CiSuiteReport {
  readonly runtime_version: number;
  readonly suite_job_count: number;
  readonly batch_count: number;
  /** Lex-sorted by region. */
  readonly batches: readonly CiBatchReport[];
  readonly all_batches_ok: boolean;
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

function validateSuiteJobs(jobs: readonly CiSuiteJob[]): void {
  const seen = new Set<string>();
  for (const j of jobs) {
    if (typeof j.region !== 'string' || j.region.length === 0) {
      throw new Error('deterministic_ci_orchestration_runtime: region must be non-empty string');
    }
    if (typeof j.shard_id !== 'string' || j.shard_id.length === 0) {
      throw new Error('deterministic_ci_orchestration_runtime: shard_id must be non-empty string');
    }
    if (!Number.isSafeInteger(j.priority)) {
      throw new Error(
        `deterministic_ci_orchestration_runtime: priority must be safe integer at ${j.region}/${j.shard_id}`,
      );
    }
    const key = JSON.stringify([j.region, j.shard_id]);
    if (seen.has(key)) {
      throw new Error(
        `deterministic_ci_orchestration_runtime: duplicate (region, shard_id) "${j.region}/${j.shard_id}"`,
      );
    }
    seen.add(key);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — runCiSuiteOrchestration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Orchestrate a CI suite across regions:
 *   1. Validate caller inputs.
 *   2. Group jobs by region (canonical lex order).
 *   3. For each region group, run Phase 16 M1 `runLiveCiValidation`.
 *   4. Aggregate batch-level reports into a suite-level canonical hash.
 *
 * Pure — same (archive, jobs) → same suite report bytes ALWAYS.
 * NEVER throws on CI failure — gate is `result.ok`. Throws on caller
 * bugs (dup composite key, baseline_label not in archive — propagated
 * from M1 P16).
 *
 * NOTE: `result.ok` inherits the REGRESSION-DETECTION gating chain
 * (runLiveCiValidation → runReplayRegression). For multi-release rollout
 * where each candidate intentionally differs from the previous release,
 * use a per-release archive (see Phase 18 §6.3 pattern).
 */
export function runCiSuiteOrchestration(
  archive: ImmutableSnapshotArchive,
  jobs: readonly CiSuiteJob[],
): CiSuiteReport {
  validateSuiteJobs(jobs);

  // Group by region
  const byRegion = new Map<string, CiSuiteJob[]>();
  for (const j of jobs) {
    let list = byRegion.get(j.region);
    if (!list) {
      list = [];
      byRegion.set(j.region, list);
    }
    list.push(j);
  }

  // Process per-region in lex-sorted region order
  const regionsSorted = [...byRegion.keys()].sort(lexCompare);
  const batchReports: CiBatchReport[] = [];
  let allBatchesOk = true;

  for (const region of regionsSorted) {
    const regionJobs = byRegion.get(region)!;
    // Convert to Phase 16 M1 CiJob — shard_id should be per-region; within
    // each batch shard_ids are unique by construction (suite-level validation
    // already ensured (region, shard_id) composite uniqueness).
    const ciJobs: CiJob[] = regionJobs.map((j) => {
      const base: CiJob = j.baseline_label !== undefined
        ? { shard_id: j.shard_id, priority: j.priority, artifact: j.artifact, baseline_label: j.baseline_label }
        : { shard_id: j.shard_id, priority: j.priority, artifact: j.artifact };
      return base;
    });
    const batch: LiveCiRunReport = runLiveCiValidation(archive, ciJobs);
    if (!batch.ok) allBatchesOk = false;
    batchReports.push(
      Object.freeze({
        region,
        job_count: regionJobs.length,
        batch_ok: batch.ok,
        batch_hash: batch.deterministic_hash,
      }),
    );
  }

  const frozenBatches = Object.freeze(batchReports.map((b) => b));

  const canonical = canonicalSerialize({
    runtime_version: DETERMINISTIC_CI_ORCHESTRATION_VERSION,
    suite_job_count: jobs.length,
    batch_count: frozenBatches.length,
    batches: frozenBatches.map((b) => ({
      region: b.region,
      job_count: b.job_count,
      batch_ok: b.batch_ok,
      batch_hash: b.batch_hash,
    })),
    all_batches_ok: allBatchesOk,
    ok: allBatchesOk,
  });

  return Object.freeze({
    runtime_version: DETERMINISTIC_CI_ORCHESTRATION_VERSION,
    suite_job_count: jobs.length,
    batch_count: frozenBatches.length,
    batches: frozenBatches,
    all_batches_ok: allBatchesOk,
    ok: allBatchesOk,
    deterministic_hash: fnv1a32(canonical),
  });
}
