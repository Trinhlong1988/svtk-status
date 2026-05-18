/**
 * DISTRIBUTED VALIDATION RUNTIME — CMD4 Phase 15 Module 2.
 *
 * Deterministic multi-runtime validation coordinator. Composes Phase 13
 * verify/hash-validate/inspect + Phase 14 multi-region audit into a
 * single shard-scheduling pipeline.
 *
 * Brief v15 §M2 responsibilities:
 *   1. shard validation coordination (lex-sorted canonical order)
 *   2. region parity verification (delegates to multi_region_export_audit)
 *   3. replay verification aggregation (per-shard verify + hash-validate)
 *   4. deterministic validation scheduling (canonical lex order)
 *   5. canonical validation merge (FNV-1a over canonical shard chain)
 *
 * CRITICAL (brief v15 §M2):
 *   NO networking runtime. Coordinator = deterministic orchestration ONLY.
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence.
 *
 * Ownership: tooling/validator layer (brief v15 §III).
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';
import {
  verifyExportArtifact,
  type ExportArtifact,
} from './deterministic_export_pipeline.js';
import { validateSerializationHashes } from './serialization_hash_validator.js';
import { inspectExportArtifact } from './replay_registry_inspector.js';
import {
  auditMultiRegionExport,
  type MultiRegionAuditReport,
} from './multi_region_export_audit.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const DISTRIBUTED_VALIDATION_RUNTIME_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface ShardValidationInput {
  /** Globally unique shard identifier (region / host / zone label). */
  readonly shard_id: string;
  readonly artifact: ExportArtifact;
}

export interface ShardValidationResult {
  readonly shard_id: string;
  readonly artifact_hash: string;
  readonly verify_ok: boolean;
  readonly hash_validation_ok: boolean;
  readonly inspection_ok: boolean;
  readonly shard_ok: boolean;
  /** FNV-1a hash over canonical(shard_id, artifact_hash, all verify flags). */
  readonly per_shard_hash: string;
}

export interface DistributedValidationReport {
  readonly runtime_version: number;
  readonly shard_count: number;
  /** Lex-sorted by shard_id. */
  readonly shards: readonly ShardValidationResult[];
  /** Region parity audit across all shards. */
  readonly region_parity: MultiRegionAuditReport;
  readonly all_shards_ok: boolean;
  /** Aggregate: every shard ok AND region parity ok. */
  readonly ok: boolean;
  /** Canonical merge hash over all per_shard_hash + region_parity hash. */
  readonly merged_canonical_hash: string;
  /** FNV-1a of full report — top-level deterministic hash. */
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

function computePerShardHash(
  shardId: string,
  artifactHash: string,
  verifyOk: boolean,
  hashValOk: boolean,
  inspectionOk: boolean,
): string {
  return fnv1a32(
    canonicalSerialize({
      shard_id: shardId,
      artifact_hash: artifactHash,
      verify_ok: verifyOk,
      hash_validation_ok: hashValOk,
      inspection_ok: inspectionOk,
    }),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal — shard input validation (caller-bug guards)
// ═══════════════════════════════════════════════════════════════════════════

function validateShardInputs(shards: readonly ShardValidationInput[]): void {
  const seen = new Set<string>();
  for (const s of shards) {
    if (typeof s.shard_id !== 'string' || s.shard_id.length === 0) {
      throw new Error('distributed_validation_runtime: shard_id must be non-empty string');
    }
    if (seen.has(s.shard_id)) {
      throw new Error(`distributed_validation_runtime: duplicate shard_id "${s.shard_id}"`);
    }
    seen.add(s.shard_id);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — scheduleShards (canonical lex order)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Return the canonical processing order for shards (lex-sorted by
 * shard_id). Pure, deterministic — no side effects. Useful for diagnostic
 * display and caller-side parallelism scheduling.
 *
 * Throws on duplicate shard_id (caller bug).
 */
export function scheduleShards(shards: readonly ShardValidationInput[]): readonly string[] {
  validateShardInputs(shards);
  return Object.freeze([...shards].map((s) => s.shard_id).sort(lexCompare));
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — runDistributedValidation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Coordinate validation across N shards:
 *   1. lex-sort shards by shard_id (canonical scheduling)
 *   2. per-shard: verifyExportArtifact + validateSerializationHashes +
 *      inspectExportArtifact
 *   3. region parity audit: auditMultiRegionExport(shards-as-regions)
 *   4. canonical merge: FNV-1a over canonical(shard_id → per_shard_hash) +
 *      region_parity.deterministic_hash
 *
 * Same input set (any caller order) → same report bytes ALWAYS.
 *
 * NEVER throws on validation failure — gate is `result.ok`. Throws on
 * caller bugs (empty/duplicate shard_id).
 */
export function runDistributedValidation(
  shards: readonly ShardValidationInput[],
): DistributedValidationReport {
  // Caller-bug guards (extracted — no redundant sort allocation).
  validateShardInputs(shards);

  // Lex sort by shard_id — canonical processing order.
  const sorted = [...shards].sort((a, b) => lexCompare(a.shard_id, b.shard_id));

  // Per-shard validation
  const results: ShardValidationResult[] = [];
  let allOk = true;
  for (const s of sorted) {
    const v = verifyExportArtifact(s.artifact);
    const h = validateSerializationHashes(s.artifact);
    const insp = inspectExportArtifact(s.artifact);
    const shardOk = v.ok && h.ok && insp.ok;
    if (!shardOk) allOk = false;
    const psh = computePerShardHash(
      s.shard_id,
      s.artifact.deterministic_hash,
      v.ok,
      h.ok,
      insp.ok,
    );
    results.push(
      Object.freeze({
        shard_id: s.shard_id,
        artifact_hash: s.artifact.deterministic_hash,
        verify_ok: v.ok,
        hash_validation_ok: h.ok,
        inspection_ok: insp.ok,
        shard_ok: shardOk,
        per_shard_hash: psh,
      }),
    );
  }
  const frozenShards = Object.freeze(results.map((r) => r));

  // Region parity audit — uses Phase 14 M3 (auditMultiRegionExport)
  // shard_id becomes region label; if no shards / 1 shard → degenerate ok=true
  const regionParity = auditMultiRegionExport(
    sorted.map((s) => ({ region: s.shard_id, artifact: s.artifact })),
  );

  // Canonical merge hash
  const mergedCanonical = canonicalSerialize({
    runtime_version: DISTRIBUTED_VALIDATION_RUNTIME_VERSION,
    per_shard_hashes: frozenShards.map((r) => ({
      shard_id: r.shard_id,
      per_shard_hash: r.per_shard_hash,
    })),
    region_parity_hash: regionParity.deterministic_hash,
  });
  const mergedHash = fnv1a32(mergedCanonical);

  const ok = allOk && regionParity.ok;

  const topCanonical = canonicalSerialize({
    runtime_version: DISTRIBUTED_VALIDATION_RUNTIME_VERSION,
    shard_count: frozenShards.length,
    shards: frozenShards.map((r) => ({
      shard_id: r.shard_id,
      artifact_hash: r.artifact_hash,
      verify_ok: r.verify_ok,
      hash_validation_ok: r.hash_validation_ok,
      inspection_ok: r.inspection_ok,
      shard_ok: r.shard_ok,
      per_shard_hash: r.per_shard_hash,
    })),
    region_parity_hash: regionParity.deterministic_hash,
    all_shards_ok: allOk,
    ok,
    merged_canonical_hash: mergedHash,
  });

  return Object.freeze({
    runtime_version: DISTRIBUTED_VALIDATION_RUNTIME_VERSION,
    shard_count: frozenShards.length,
    shards: frozenShards,
    region_parity: regionParity,
    all_shards_ok: allOk,
    ok,
    merged_canonical_hash: mergedHash,
    deterministic_hash: fnv1a32(topCanonical),
  });
}
