/**
 * DISTRIBUTED VALIDATION ORCHESTRATOR — CMD4 Phase 17 Module 4.
 *
 * MMO-scale cross-region distributed validation orchestration. Composes
 * Phase 16 M4 scheduler + Phase 12/13 verify/hash-validate primitives
 * to produce a region-grouped, canonical-merged validation report.
 *
 * Brief v17 §M4 responsibilities:
 *   1. deterministic validation scheduling (via Phase 16 M4 scheduler)
 *   2. replay-safe distributed replay validation
 *   3. canonical merge ordering (region asc, shard_id asc)
 *   4. replay reconstruction verification (rerun-stable)
 *   5. stable validation hashing (FNV-1a chained)
 *
 * MANDATORY (brief v17 §M4):
 *   same validation input → same validation result ALWAYS.
 *
 * FORBIDDEN:
 *   transient scheduling
 *   unstable shard traversal
 *   locale-sensitive ordering
 *   runtime-dependent merge ordering
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence.
 *
 * Ownership: tooling/validator layer (brief v17 §III).
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';
import {
  verifyExportArtifact,
  type ExportArtifact,
} from './deterministic_export_pipeline.js';
import { validateSerializationHashes } from './serialization_hash_validator.js';
import {
  scheduleDistributedValidation,
} from './distributed_validation_scheduler_runtime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const DISTRIBUTED_VALIDATION_ORCHESTRATOR_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface OrchestrationJob {
  readonly region: string;
  /** Unique within (region) — (region, shard_id) is the composite key. */
  readonly shard_id: string;
  readonly priority: number;
  readonly artifact: ExportArtifact;
}

export interface PerRegionGroup {
  readonly region: string;
  readonly job_count: number;
  /** FNV-1a of canonical(region, lex-sorted shard_ids in region). */
  readonly region_hash: string;
}

export interface OrchestrationJobResult {
  readonly region: string;
  readonly shard_id: string;
  readonly artifact_hash: string;
  readonly verify_ok: boolean;
  readonly hash_validation_ok: boolean;
  readonly shard_ok: boolean;
  readonly per_shard_hash: string;
}

export interface DistributedValidationOrchestrationReport {
  readonly runtime_version: number;
  readonly job_count: number;
  readonly region_count: number;
  /** Scheduler.deterministic_hash from Phase 16 M4. */
  readonly schedule_hash: string;
  /** Lex-sorted by region. */
  readonly per_region: readonly PerRegionGroup[];
  /** Lex-sorted by (region, shard_id). */
  readonly jobs: readonly OrchestrationJobResult[];
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

function compositeKey(region: string, shardId: string): string {
  // Use unit separator (codepoint 0x1f) — unlikely in caller identifiers,
  // ensures (region, shard_id) composite uniqueness even if a caller has
  // unusual region/shard naming.
  return JSON.stringify([region, shardId]);
}

function validateJobs(jobs: readonly OrchestrationJob[]): void {
  const seen = new Set<string>();
  for (const j of jobs) {
    if (typeof j.region !== 'string' || j.region.length === 0) {
      throw new Error('distributed_validation_orchestrator_runtime: region must be non-empty string');
    }
    if (typeof j.shard_id !== 'string' || j.shard_id.length === 0) {
      throw new Error('distributed_validation_orchestrator_runtime: shard_id must be non-empty string');
    }
    if (!Number.isSafeInteger(j.priority)) {
      throw new Error(
        `distributed_validation_orchestrator_runtime: priority must be safe integer at ${j.region}/${j.shard_id}`,
      );
    }
    const key = compositeKey(j.region, j.shard_id);
    if (seen.has(key)) {
      throw new Error(
        `distributed_validation_orchestrator_runtime: duplicate (region, shard_id) pair "${j.region}/${j.shard_id}"`,
      );
    }
    seen.add(key);
  }
}

function computePerShardHash(
  region: string,
  shardId: string,
  artifactHash: string,
  verifyOk: boolean,
  hashValOk: boolean,
): string {
  return fnv1a32(
    canonicalSerialize({
      region,
      shard_id: shardId,
      artifact_hash: artifactHash,
      verify_ok: verifyOk,
      hash_validation_ok: hashValOk,
    }),
  );
}

function computeRegionHash(region: string, sortedShardIds: readonly string[]): string {
  return fnv1a32(canonicalSerialize({ region, shard_ids: sortedShardIds }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — runDistributedValidationOrchestration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Orchestrate distributed validation across N (region, shard) jobs:
 *   1. Validate caller inputs (no dup composite key, INT priority).
 *   2. Schedule via Phase 16 M4 scheduler (deterministic execution order).
 *   3. Per-job: verify + hash-validate.
 *   4. Group by region (canonical lex order); compute per-region hash.
 *   5. Canonical merge — top hash over (schedule_hash, per_region, jobs, ok).
 *
 * Pure — same input set (any caller order) → same report bytes ALWAYS.
 *
 * NEVER throws on validation failure — gate is `result.ok`. Throws on
 * caller bugs only (dup composite key, empty fields).
 */
export function runDistributedValidationOrchestration(
  jobs: readonly OrchestrationJob[],
): DistributedValidationOrchestrationReport {
  validateJobs(jobs);

  // Schedule via Phase 16 M4 — composite key avoids collision between regions.
  const schedule = scheduleDistributedValidation(
    jobs.map((j) => ({
      shard_id: compositeKey(j.region, j.shard_id),
      priority: j.priority,
    })),
  );

  // Build composite-key → job lookup
  const byCompositeKey = new Map<string, OrchestrationJob>();
  for (const j of jobs) byCompositeKey.set(compositeKey(j.region, j.shard_id), j);

  // Per-job validation in schedule order
  const jobResults: OrchestrationJobResult[] = [];
  let allOk = true;
  for (const compKey of schedule.merge_order) {
    const j = byCompositeKey.get(compKey)!;
    const v = verifyExportArtifact(j.artifact);
    const h = validateSerializationHashes(j.artifact);
    const shardOk = v.ok && h.ok;
    if (!shardOk) allOk = false;
    jobResults.push(
      Object.freeze({
        region: j.region,
        shard_id: j.shard_id,
        artifact_hash: j.artifact.deterministic_hash,
        verify_ok: v.ok,
        hash_validation_ok: h.ok,
        shard_ok: shardOk,
        per_shard_hash: computePerShardHash(
          j.region,
          j.shard_id,
          j.artifact.deterministic_hash,
          v.ok,
          h.ok,
        ),
      }),
    );
  }

  // Canonical jobs view — lex sort by (region, shard_id)
  jobResults.sort((a, b) => {
    const rc = lexCompare(a.region, b.region);
    if (rc !== 0) return rc;
    return lexCompare(a.shard_id, b.shard_id);
  });
  const frozenJobs = Object.freeze(jobResults.map((j) => j));

  // Per-region grouping
  const regionMap = new Map<string, string[]>();
  for (const jr of frozenJobs) {
    let list = regionMap.get(jr.region);
    if (!list) {
      list = [];
      regionMap.set(jr.region, list);
    }
    list.push(jr.shard_id);
  }
  const perRegion: PerRegionGroup[] = [];
  for (const [region, shardIds] of regionMap) {
    const sortedShards = [...shardIds].sort(lexCompare);
    perRegion.push({
      region,
      job_count: sortedShards.length,
      region_hash: computeRegionHash(region, sortedShards),
    });
  }
  perRegion.sort((a, b) => lexCompare(a.region, b.region));
  const frozenPerRegion = Object.freeze(perRegion.map((r) => Object.freeze(r)));

  const canonical = canonicalSerialize({
    runtime_version: DISTRIBUTED_VALIDATION_ORCHESTRATOR_VERSION,
    job_count: frozenJobs.length,
    region_count: frozenPerRegion.length,
    schedule_hash: schedule.deterministic_hash,
    per_region: frozenPerRegion.map((r) => ({
      region: r.region,
      job_count: r.job_count,
      region_hash: r.region_hash,
    })),
    jobs: frozenJobs.map((j) => ({
      region: j.region,
      shard_id: j.shard_id,
      artifact_hash: j.artifact_hash,
      verify_ok: j.verify_ok,
      hash_validation_ok: j.hash_validation_ok,
      shard_ok: j.shard_ok,
      per_shard_hash: j.per_shard_hash,
    })),
    all_jobs_ok: allOk,
    ok: allOk,
  });

  return Object.freeze({
    runtime_version: DISTRIBUTED_VALIDATION_ORCHESTRATOR_VERSION,
    job_count: frozenJobs.length,
    region_count: frozenPerRegion.length,
    schedule_hash: schedule.deterministic_hash,
    per_region: frozenPerRegion,
    jobs: frozenJobs,
    all_jobs_ok: allOk,
    ok: allOk,
    deterministic_hash: fnv1a32(canonical),
  });
}
