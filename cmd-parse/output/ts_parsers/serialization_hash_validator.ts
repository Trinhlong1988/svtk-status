/**
 * SERIALIZATION HASH VALIDATOR — CMD4 Phase 13 Module 2.
 *
 * Cross-system serialization integrity verification. Wider-scope diagnostic
 * companion to Commit #3 `verifyExportArtifact`:
 *   - `verifyExportArtifact` short-circuits on first divergence (single field).
 *   - `validateSerializationHashes` collects ALL divergences (CI gate friendly).
 *
 * Brief v12 §TASK 2 responsibilities:
 *   1. canonical hash verification
 *   2. export byte verification
 *   3. replay-safe hash audit
 *   4. registry fingerprint verification
 *   5. deterministic serialization diagnostics
 *
 * Re-uses Commit #1 (canonicalSerialize, fnv1a32) + Commit #3 (ExportArtifact,
 * exportArtifactToJson). Pure read-only — no I/O, no mutation, no wall-clock,
 * no Math.random, no localeCompare.
 *
 * Same serialized state → same validation result ALWAYS.
 *
 * Ownership: tooling layer only (brief v12 §III).
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';
import {
  exportArtifactToJson,
  EXPORT_ARTIFACT_VERSION,
  type ExportArtifact,
} from './deterministic_export_pipeline.js';

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export const HASH_DIVERGENCE_FIELDS = [
  'artifact_version_unsupported',
  'artifact_content_count',
  'schema_names_length',
  'schema_names_lex_order',
  'per_file_index_alignment',
  'aggregate_hash',
  'registry_snapshot_hash',
  'artifact_schema_fingerprint',
  'canonical_content_hash',
  'canonical_byte_length',
  'deterministic_hash',
  'json_byte_mismatch',
] as const;
export type HashDivergenceField = (typeof HASH_DIVERGENCE_FIELDS)[number];

export interface HashDivergence {
  readonly field: HashDivergenceField | string;
  readonly expected: string;
  readonly actual: string;
}

export interface HashValidationReport {
  readonly ok: boolean;
  readonly artifact_hash_match: boolean;
  readonly registry_fingerprint_match: boolean;
  readonly canonical_byte_length_match: boolean;
  readonly canonical_content_hash_match: boolean;
  readonly per_file_hash_consistent: boolean;
  readonly aggregate_hash_consistent: boolean;
  readonly divergences: readonly HashDivergence[];
  readonly deterministic_hash: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers — mirror Commit #3 internal canonical forms
// ═══════════════════════════════════════════════════════════════════════════

function lexCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function canonicalArtifactCoreNoLength(artifact: ExportArtifact): string {
  return canonicalSerialize({
    artifact_version: artifact.artifact_version,
    artifact_content_count: artifact.artifact_content_count,
    artifact_schema_fingerprint: artifact.artifact_schema_fingerprint,
    aggregate_hash: artifact.aggregate_hash,
    registry_snapshot_hash: artifact.registry_snapshot_hash,
    schema_names: artifact.schema_names,
    per_file: artifact.per_file.map((e) => [e.schema_name, e.content_hash, e.result_hash]),
    canonical_content_hash: artifact.canonical_content_hash,
  });
}

function canonicalArtifactCoreWithLength(artifact: ExportArtifact): string {
  return canonicalSerialize({
    artifact_version: artifact.artifact_version,
    artifact_content_count: artifact.artifact_content_count,
    artifact_schema_fingerprint: artifact.artifact_schema_fingerprint,
    aggregate_hash: artifact.aggregate_hash,
    registry_snapshot_hash: artifact.registry_snapshot_hash,
    schema_names: artifact.schema_names,
    per_file: artifact.per_file.map((e) => [e.schema_name, e.content_hash, e.result_hash]),
    canonical_content_hash: artifact.canonical_content_hash,
    canonical_byte_length: artifact.canonical_byte_length,
  });
}

function computeSchemaFingerprint(schemaNames: readonly string[]): string {
  return fnv1a32(
    canonicalSerialize({
      artifact_version: EXPORT_ARTIFACT_VERSION,
      schema_names: schemaNames,
    }),
  );
}

function recomputeAggregateHashFromPerFile(artifact: ExportArtifact): string {
  return fnv1a32(canonicalSerialize(artifact.per_file.map((e) => e.result_hash)));
}

function makeDivergence(field: HashDivergenceField | string, expected: string, actual: string): HashDivergence {
  return Object.freeze({ field, expected, actual });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — validateSerializationHashes (collect ALL divergences)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate every hash field of an `ExportArtifact` and collect ALL
 * divergences (NOT short-circuit). Returns frozen report suitable for CI
 * gate diff display.
 *
 * Wider-scope companion to `verifyExportArtifact` (Commit #3): instead of
 * one divergence_field, em surfaces ALL divergent fields at once.
 */
export function validateSerializationHashes(artifact: ExportArtifact): HashValidationReport {
  const divergences: HashDivergence[] = [];

  // 1. Version compatibility.
  if (artifact.artifact_version !== EXPORT_ARTIFACT_VERSION) {
    divergences.push(
      makeDivergence(
        'artifact_version_unsupported',
        String(EXPORT_ARTIFACT_VERSION),
        String(artifact.artifact_version),
      ),
    );
  }

  // 2. Content count consistency.
  if (
    artifact.artifact_content_count !== artifact.per_file.length ||
    artifact.artifact_content_count !== artifact.schema_names.length
  ) {
    divergences.push(
      makeDivergence(
        'artifact_content_count',
        String(artifact.per_file.length),
        String(artifact.artifact_content_count),
      ),
    );
  }
  if (artifact.schema_names.length !== artifact.per_file.length) {
    divergences.push(
      makeDivergence(
        'schema_names_length',
        String(artifact.per_file.length),
        String(artifact.schema_names.length),
      ),
    );
  }

  // 3. Lex order + index alignment.
  let lexOrderOk = true;
  for (let i = 1; i < artifact.schema_names.length; i++) {
    const prev = artifact.schema_names[i - 1];
    const cur = artifact.schema_names[i];
    if (prev !== undefined && cur !== undefined && lexCompare(prev, cur) > 0) {
      divergences.push(makeDivergence('schema_names_lex_order', `lex(${prev}<${cur})`, `lex(${prev}>${cur})`));
      lexOrderOk = false;
      break;
    }
  }
  let indexAlignOk = true;
  if (lexOrderOk) {
    for (let i = 0; i < artifact.schema_names.length; i++) {
      const a = artifact.schema_names[i];
      const b = artifact.per_file[i]?.schema_name;
      if (a !== b) {
        divergences.push(makeDivergence('per_file_index_alignment', String(a), String(b)));
        indexAlignOk = false;
        break;
      }
    }
  }

  // 4. Aggregate hash consistency (from per_file).
  const recomputedAgg = recomputeAggregateHashFromPerFile(artifact);
  const aggregateMatch = recomputedAgg === artifact.aggregate_hash;
  if (!aggregateMatch) {
    divergences.push(makeDivergence('aggregate_hash', artifact.aggregate_hash, recomputedAgg));
  }

  // 5. Registry snapshot hash — em không thể tự re-derive without registry instance.
  //    Em chỉ verify format (hex8). Real cross-env drift detection occurs at
  //    Module 3 registry_diff_audit comparing 2 artifact snapshots.
  const registryFingerprintMatch = /^[0-9a-f]{8}$/.test(artifact.registry_snapshot_hash);
  if (!registryFingerprintMatch) {
    divergences.push(
      makeDivergence('registry_snapshot_hash', 'hex8 format', artifact.registry_snapshot_hash),
    );
  }

  // 6. Schema fingerprint.
  const recomputedFp = computeSchemaFingerprint(artifact.schema_names);
  const fingerprintMatch = recomputedFp === artifact.artifact_schema_fingerprint;
  if (!fingerprintMatch) {
    divergences.push(
      makeDivergence('artifact_schema_fingerprint', artifact.artifact_schema_fingerprint, recomputedFp),
    );
  }

  // 7. Canonical byte length.
  const recomputedLength = canonicalArtifactCoreNoLength(artifact).length;
  const byteLengthMatch = recomputedLength === artifact.canonical_byte_length;
  if (!byteLengthMatch) {
    divergences.push(
      makeDivergence(
        'canonical_byte_length',
        String(artifact.canonical_byte_length),
        String(recomputedLength),
      ),
    );
  }

  // 8. Deterministic hash.
  const recomputedHash = fnv1a32(canonicalArtifactCoreWithLength(artifact));
  const hashMatch = recomputedHash === artifact.deterministic_hash;
  if (!hashMatch) {
    divergences.push(makeDivergence('deterministic_hash', artifact.deterministic_hash, recomputedHash));
  }

  // 9. canonical_content_hash format check (full re-derive not possible without raw content).
  const contentHashFormatOk = /^[0-9a-f]{8}$/.test(artifact.canonical_content_hash);
  if (!contentHashFormatOk) {
    divergences.push(
      makeDivergence('canonical_content_hash', 'hex8 format', artifact.canonical_content_hash),
    );
  }

  divergences.sort((a, b) => lexCompare(String(a.field), String(b.field)));

  const ok = divergences.length === 0;
  const canonical = canonicalSerialize({
    ok,
    artifact_hash_match: hashMatch,
    registry_fingerprint_match: registryFingerprintMatch,
    canonical_byte_length_match: byteLengthMatch,
    canonical_content_hash_match: contentHashFormatOk,
    per_file_hash_consistent: indexAlignOk,
    aggregate_hash_consistent: aggregateMatch,
    divergences: divergences.map((d) => [d.field, d.expected, d.actual]),
  });

  return Object.freeze({
    ok,
    artifact_hash_match: hashMatch,
    registry_fingerprint_match: registryFingerprintMatch,
    canonical_byte_length_match: byteLengthMatch,
    canonical_content_hash_match: contentHashFormatOk,
    per_file_hash_consistent: indexAlignOk,
    aggregate_hash_consistent: aggregateMatch,
    divergences: Object.freeze(divergences),
    deterministic_hash: fnv1a32(canonical),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — validateArtifactJsonBytes
// ═══════════════════════════════════════════════════════════════════════════

export interface JsonByteValidationResult {
  readonly ok: boolean;
  readonly expected_byte_length: number;
  readonly actual_byte_length: number;
  readonly first_diverging_index?: number; // index of first byte where they differ
}

/**
 * Validate that a stored / wire-received JSON string matches the canonical
 * form produced by `exportArtifactToJson(artifact)`.
 *
 * If divergent, returns `first_diverging_index` (UTF-16 char index) for
 * forensic triage (e.g. detect prefix tampering vs payload tampering).
 */
export function validateArtifactJsonBytes(
  artifact: ExportArtifact,
  expectedJson: string,
): JsonByteValidationResult {
  const canonical = exportArtifactToJson(artifact);
  if (canonical === expectedJson) {
    return Object.freeze({
      ok: true,
      expected_byte_length: expectedJson.length,
      actual_byte_length: canonical.length,
    });
  }
  const minLen = Math.min(canonical.length, expectedJson.length);
  let firstDiverge = minLen;
  for (let i = 0; i < minLen; i++) {
    if (canonical.charCodeAt(i) !== expectedJson.charCodeAt(i)) {
      firstDiverge = i;
      break;
    }
  }
  return Object.freeze({
    ok: false,
    expected_byte_length: expectedJson.length,
    actual_byte_length: canonical.length,
    first_diverging_index: firstDiverge,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — auditAgainstBaseline (CI gate: current vs baseline)
// ═══════════════════════════════════════════════════════════════════════════

export interface BaselineAuditResult {
  readonly ok: boolean;
  readonly hash_diverged: boolean;
  readonly diverged_fields: readonly HashDivergenceField[];
  readonly comparison_hash: string;
}

/**
 * CI gate: compare current artifact against a baseline (e.g. main branch).
 * Returns ok=true iff every top-level hash field matches.
 *
 * Diverged fields surface the SPECIFIC top-level hash that differed —
 * useful for PR diff explanation ("aggregate_hash changed but
 * registry_snapshot_hash same → content changed, schemas unchanged").
 */
export function auditAgainstBaseline(
  current: ExportArtifact,
  baseline: ExportArtifact,
): BaselineAuditResult {
  const diverged: HashDivergenceField[] = [];
  if (current.aggregate_hash !== baseline.aggregate_hash) diverged.push('aggregate_hash');
  if (current.registry_snapshot_hash !== baseline.registry_snapshot_hash) diverged.push('registry_snapshot_hash');
  if (current.artifact_schema_fingerprint !== baseline.artifact_schema_fingerprint) diverged.push('artifact_schema_fingerprint');
  if (current.canonical_content_hash !== baseline.canonical_content_hash) diverged.push('canonical_content_hash');
  if (current.canonical_byte_length !== baseline.canonical_byte_length) diverged.push('canonical_byte_length');
  if (current.deterministic_hash !== baseline.deterministic_hash) diverged.push('deterministic_hash');

  diverged.sort(lexCompare);
  const ok = diverged.length === 0;

  const canonical = canonicalSerialize({
    ok,
    diverged_fields: diverged,
    current_hash: current.deterministic_hash,
    baseline_hash: baseline.deterministic_hash,
  });

  return Object.freeze({
    ok,
    hash_diverged: !ok,
    diverged_fields: Object.freeze(diverged),
    comparison_hash: fnv1a32(canonical),
  });
}
