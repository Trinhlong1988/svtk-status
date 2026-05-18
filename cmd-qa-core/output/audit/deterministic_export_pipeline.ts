/**
 * DETERMINISTIC EXPORT PIPELINE — CMD4 Commit #3 (hardening pass v11).
 *
 * Produce stable serializable artifacts from a project validation pass.
 * Artifacts are wire-format-safe (JSON-pure INT-only), reproducible
 * (same input → byte-identical bytes), and tamper-detectable (3-level
 * verify: length / fingerprint / canonical hash).
 *
 * Use cases:
 *   - Replay archive snapshot (content + hashes pinned, replayable cross-version)
 *   - CI diff (compare two artifact JSON files between branches)
 *   - Cross-runtime forensic identity (Windows/Linux/Mac/Unity Mono identical)
 *   - Pre-deployment validation gate (CI block on hash mismatch)
 *
 * Re-uses Commit #1 primitives (`canonicalSerialize`, `fnv1a32`,
 * `SchemaRegistry.snapshotHash`) — single source of truth.
 *
 * PURE READ-ONLY runtime — no I/O, no `Date.now`, no `Math.random`,
 * no `localeCompare`. Same input → same output ALWAYS.
 *
 * One-way flow (Mục "Important Architecture Rule"):
 *   runtime → export artifact (forensic + validation infrastructure)
 *   NOT artifact → runtime mutation
 *
 * Ownership: tooling layer only. Does NOT touch combat / orchestration /
 * replay core / economy / progression / network transport.
 */
import { z } from 'zod';
import {
  SchemaRegistry,
  canonicalSerialize,
  fnv1a32,
  type AggregateReport,
} from './schema_validation_runtime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wire-format schema version pinned at 1. Future migrations bump this
 * constant + provide migration handler at deserialize boundary.
 */
export const EXPORT_ARTIFACT_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface ExportPerFileEntry {
  readonly schema_name: string;
  /** FNV-1a 32-bit of canonical serialization of the raw content payload. */
  readonly content_hash: string;
  /** Passthrough of `ValidationResult.deterministic_hash`. */
  readonly result_hash: string;
}

/**
 * Frozen serializable artifact representing one project validation pass.
 *
 * Hardening fields (Mục v11):
 *   - `artifact_content_count`: quick sanity check (== per_file.length).
 *   - `artifact_schema_fingerprint`: detect schema-registry drift across envs.
 *   - `canonical_byte_length`: quick forensic length check before full re-hash.
 *
 * Hash chain:
 *   - Per-file `content_hash` covers the raw input payload.
 *   - Per-file `result_hash` covers Commit #1 ValidationResult.
 *   - `aggregate_hash` covers Commit #1 AggregateReport.
 *   - `canonical_content_hash` covers ALL raw contents together.
 *   - `deterministic_hash` covers every other field — tamper detection.
 */
export interface ExportArtifact {
  readonly artifact_version: number;
  readonly artifact_content_count: number;
  readonly artifact_schema_fingerprint: string;
  readonly aggregate_hash: string;
  readonly registry_snapshot_hash: string;
  readonly schema_names: readonly string[];
  readonly per_file: readonly ExportPerFileEntry[];
  readonly canonical_content_hash: string;
  readonly canonical_byte_length: number;
  readonly deterministic_hash: string;
}

/** Verify divergence-field identifiers (stable strings for telemetry diff). */
export const VERIFY_DIVERGENCE_FIELDS = [
  'artifact_version_unsupported',
  'artifact_content_count_mismatch',
  'schema_names_length_mismatch',
  'schema_names_not_lex_sorted',
  'per_file_index_name_mismatch',
  'aggregate_hash_inconsistent_with_per_file',
  'artifact_schema_fingerprint',
  'canonical_byte_length',
  'deterministic_hash',
] as const;
export type VerifyDivergenceField = (typeof VERIFY_DIVERGENCE_FIELDS)[number] | string;

export interface VerifyExportResult {
  readonly ok: boolean;
  readonly divergence_field?: VerifyDivergenceField;
  readonly divergent_hash?: {
    readonly expected: string;
    readonly actual: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Lex compare (cross-platform direct codepoint)
// ═══════════════════════════════════════════════════════════════════════════

function lexCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Normalize content input — accept Map or plain object
// ═══════════════════════════════════════════════════════════════════════════

function extractContentEntriesSorted(
  contentByName: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>,
): readonly { readonly name: string; readonly value: unknown }[] {
  const entries: { name: string; value: unknown }[] = [];
  // Detect Map-LIKE via Symbol.iterator presence — catches both real `Map`
  // instances AND `ReadonlyMap` view objects (e.g. `freezeMapView` returned
  // by `ContentRegistryLoader.loadAllContent`). Pre-fix `instanceof Map`
  // missed the freezeMapView case: `Object.keys(view)` returns its method
  // names (`get`, `has`, `keys`, ...) instead of the actual map keys,
  // producing garbage entries silently. Symbol.iterator check is the JS
  // standard for "iterable of [key, value] pairs".
  const iter = (contentByName as { [Symbol.iterator]?: unknown })[Symbol.iterator];
  if (typeof iter === 'function') {
    for (const [name, value] of contentByName as Iterable<[string, unknown]>) {
      entries.push({ name, value });
    }
  } else {
    const obj = contentByName as Record<string, unknown>;
    for (const name of Object.keys(obj)) entries.push({ name, value: obj[name] });
  }
  return entries.sort((a, b) => lexCompare(a.name, b.name));
}

// ═══════════════════════════════════════════════════════════════════════════
// Canonical forms for length/hash computation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Canonical form WITHOUT `deterministic_hash` AND `canonical_byte_length`.
 * Used to compute `canonical_byte_length` (avoids self-reference).
 */
function canonicalArtifactCoreNoLength(artifact: Omit<ExportArtifact, 'deterministic_hash' | 'canonical_byte_length'>): string {
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

/**
 * Canonical form WITHOUT `deterministic_hash` only (includes length).
 * Used to compute `deterministic_hash` over all fields except itself.
 */
function canonicalArtifactCoreWithLength(artifact: Omit<ExportArtifact, 'deterministic_hash'>): string {
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

/**
 * Compute schema fingerprint from lex-sorted schema name list bound to
 * the artifact version. Same registered schema set + same version →
 * same fingerprint regardless of registration order.
 */
function computeSchemaFingerprint(schemaNames: readonly string[]): string {
  return fnv1a32(
    canonicalSerialize({
      artifact_version: EXPORT_ARTIFACT_VERSION,
      schema_names: schemaNames,
    }),
  );
}

/**
 * Aggregate hash consistency: re-derive from per_file result_hashes and
 * compare with stored aggregate_hash. Mirrors Commit #1
 * `validateAllRegistries` final-step hash composition.
 */
function recomputeAggregateHashFromPerFile(perFile: readonly ExportPerFileEntry[]): string {
  return fnv1a32(canonicalSerialize(perFile.map((e) => e.result_hash)));
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — serialize
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Produce a frozen `ExportArtifact` from a Commit #1 `AggregateReport`,
 * `SchemaRegistry`, and the original content map keyed by schema name.
 *
 * Throws if `contentByName` keys do NOT match `aggregate.results` schema
 * names exactly (caller bug — agg + content must come from same validation
 * pass).
 *
 * Same input → byte-identical artifact ALWAYS. Verified by fuzz.
 */
export function serializeProjectContent(
  aggregate: AggregateReport,
  registry: SchemaRegistry,
  contentByName: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>,
): ExportArtifact {
  const sorted = extractContentEntriesSorted(contentByName);
  const sortedNames = sorted.map((e) => e.name);

  // Caller-bug guard: agg result names must match content keys exactly.
  const aggNames = [...aggregate.results.map((r) => r.schema_name)].sort(lexCompare);
  if (aggNames.length !== sortedNames.length) {
    throw new Error(
      `deterministic_export_pipeline: aggregate has ${aggNames.length} results but content has ${sortedNames.length} keys`,
    );
  }
  for (let i = 0; i < aggNames.length; i++) {
    if (aggNames[i] !== sortedNames[i]) {
      throw new Error(
        `deterministic_export_pipeline: name mismatch at index ${i} — aggregate "${String(aggNames[i])}" ≠ content "${String(sortedNames[i])}"`,
      );
    }
  }

  // Per-file entries (lex by schema_name).
  const resultsByName = new Map<string, string>();
  for (const r of aggregate.results) resultsByName.set(r.schema_name, r.deterministic_hash);

  const perFile: ExportPerFileEntry[] = [];
  for (const entry of sorted) {
    const contentCanonical = canonicalSerialize(entry.value);
    const contentHash = fnv1a32(contentCanonical);
    const resultHash = resultsByName.get(entry.name);
    if (resultHash === undefined) {
      // Unreachable defensive (guard above).
      throw new Error(`deterministic_export_pipeline: missing result for "${entry.name}"`);
    }
    perFile.push(
      Object.freeze({
        schema_name: entry.name,
        content_hash: contentHash,
        result_hash: resultHash,
      }),
    );
  }

  const canonicalContentHash = fnv1a32(
    canonicalSerialize(Object.fromEntries(sorted.map((e) => [e.name, e.value]))),
  );

  const schemaFingerprint = computeSchemaFingerprint(sortedNames);

  const coreNoLength: Omit<ExportArtifact, 'deterministic_hash' | 'canonical_byte_length'> = {
    artifact_version: EXPORT_ARTIFACT_VERSION,
    artifact_content_count: perFile.length,
    artifact_schema_fingerprint: schemaFingerprint,
    aggregate_hash: aggregate.deterministic_hash,
    registry_snapshot_hash: registry.snapshotHash(),
    schema_names: Object.freeze(sortedNames),
    per_file: Object.freeze(perFile),
    canonical_content_hash: canonicalContentHash,
  };

  // 1st canonical pass: compute canonical_byte_length (without length + hash).
  const canonicalByteLength = canonicalArtifactCoreNoLength(coreNoLength).length;

  // 2nd canonical pass: compute deterministic_hash (with length, without hash).
  const coreWithLength: Omit<ExportArtifact, 'deterministic_hash'> = {
    ...coreNoLength,
    canonical_byte_length: canonicalByteLength,
  };
  const deterministicHash = fnv1a32(canonicalArtifactCoreWithLength(coreWithLength));

  return Object.freeze({
    ...coreWithLength,
    deterministic_hash: deterministicHash,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — deserialize (Zod-validated boundary)
// ═══════════════════════════════════════════════════════════════════════════

const HEX8 = /^[0-9a-f]{8}$/;

const ExportPerFileEntrySchema = z
  .object({
    schema_name: z.string(),
    content_hash: z.string().regex(HEX8),
    result_hash: z.string().regex(HEX8),
  })
  .strict();

const ExportArtifactSchema = z
  .object({
    artifact_version: z.literal(EXPORT_ARTIFACT_VERSION),
    artifact_content_count: z.number().int().nonnegative(),
    artifact_schema_fingerprint: z.string().regex(HEX8),
    aggregate_hash: z.string().regex(HEX8),
    registry_snapshot_hash: z.string().regex(HEX8),
    schema_names: z.array(z.string()),
    per_file: z.array(ExportPerFileEntrySchema),
    canonical_content_hash: z.string().regex(HEX8),
    canonical_byte_length: z.number().int().nonnegative(),
    deterministic_hash: z.string().regex(HEX8),
  })
  .strict();

/**
 * Parse + Zod-validate an artifact JSON string. Returns deep-frozen
 * `ExportArtifact` on success.
 *
 * Throws on:
 *   - JSON parse error
 *   - schema validation reject (wrong shape / non-INT numeric / extra key)
 *   - wrong `artifact_version` (z.literal blocks)
 *
 * Does NOT verify hash integrity — call `verifyExportArtifact` for that.
 *
 * Float contamination rejection: numeric fields are `z.number().int()`;
 * any float in `artifact_content_count` or `canonical_byte_length` →
 * schema reject. Other numeric leaves don't exist at artifact top level.
 */
export function deserializeProjectContent(json: string): ExportArtifact {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`deterministic_export_pipeline: invalid artifact JSON: ${msg}`);
  }
  const parsed = ExportArtifactSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first ? first.path.join('.') : '<root>';
    const msg = first ? first.message : 'unknown';
    throw new Error(`deterministic_export_pipeline: artifact schema reject at "${path}": ${msg}`);
  }
  const perFile = parsed.data.per_file.map((e) => Object.freeze({ ...e }));
  return Object.freeze({
    artifact_version: parsed.data.artifact_version,
    artifact_content_count: parsed.data.artifact_content_count,
    artifact_schema_fingerprint: parsed.data.artifact_schema_fingerprint,
    aggregate_hash: parsed.data.aggregate_hash,
    registry_snapshot_hash: parsed.data.registry_snapshot_hash,
    schema_names: Object.freeze([...parsed.data.schema_names]),
    per_file: Object.freeze(perFile),
    canonical_content_hash: parsed.data.canonical_content_hash,
    canonical_byte_length: parsed.data.canonical_byte_length,
    deterministic_hash: parsed.data.deterministic_hash,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — verify (6-point check, NO throws)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 6-point deterministic verification (Mục v11 verifyExportArtifact rules):
 *   1. artifact_version compatibility (== EXPORT_ARTIFACT_VERSION)
 *   2. artifact_content_count consistency (== per_file.length == schema_names.length)
 *   3. schema_names lex-sorted + index-aligned with per_file
 *   4. aggregate hash consistency (re-derive from per_file.result_hash)
 *   5. artifact_schema_fingerprint matches re-computed fingerprint
 *   6. canonical_byte_length matches re-canonicalized length
 *   7. deterministic_hash matches re-canonicalized hash
 *
 * Returns pure frozen report ONLY. NEVER throws — caller decides action
 * on divergence. Safe to call on untrusted artifact.
 */
export function verifyExportArtifact(artifact: ExportArtifact): VerifyExportResult {
  // 1. Version compatibility.
  if (artifact.artifact_version !== EXPORT_ARTIFACT_VERSION) {
    return Object.freeze({
      ok: false,
      divergence_field: 'artifact_version_unsupported',
    });
  }

  // 2. Content count + length consistency.
  if (
    artifact.artifact_content_count !== artifact.per_file.length ||
    artifact.artifact_content_count !== artifact.schema_names.length
  ) {
    return Object.freeze({
      ok: false,
      divergence_field: 'artifact_content_count_mismatch',
    });
  }
  if (artifact.schema_names.length !== artifact.per_file.length) {
    return Object.freeze({
      ok: false,
      divergence_field: 'schema_names_length_mismatch',
    });
  }

  // 3. Lex order + index alignment.
  for (let i = 1; i < artifact.schema_names.length; i++) {
    const prev = artifact.schema_names[i - 1];
    const cur = artifact.schema_names[i];
    if (prev !== undefined && cur !== undefined && lexCompare(prev, cur) > 0) {
      return Object.freeze({
        ok: false,
        divergence_field: 'schema_names_not_lex_sorted',
      });
    }
  }
  for (let i = 0; i < artifact.schema_names.length; i++) {
    const a = artifact.schema_names[i];
    const b = artifact.per_file[i]?.schema_name;
    if (a !== b) {
      return Object.freeze({
        ok: false,
        divergence_field: 'per_file_index_name_mismatch',
      });
    }
  }

  // 4. Aggregate hash consistency (re-derive from per_file.result_hash list).
  const recomputedAgg = recomputeAggregateHashFromPerFile(artifact.per_file);
  if (recomputedAgg !== artifact.aggregate_hash) {
    return Object.freeze({
      ok: false,
      divergence_field: 'aggregate_hash_inconsistent_with_per_file',
      divergent_hash: { expected: artifact.aggregate_hash, actual: recomputedAgg },
    });
  }

  // 5. Schema fingerprint check.
  const recomputedFp = computeSchemaFingerprint(artifact.schema_names);
  if (recomputedFp !== artifact.artifact_schema_fingerprint) {
    return Object.freeze({
      ok: false,
      divergence_field: 'artifact_schema_fingerprint',
      divergent_hash: { expected: artifact.artifact_schema_fingerprint, actual: recomputedFp },
    });
  }

  // 6. Canonical byte length check.
  const recomputedLength = canonicalArtifactCoreNoLength(artifact).length;
  if (recomputedLength !== artifact.canonical_byte_length) {
    return Object.freeze({
      ok: false,
      divergence_field: 'canonical_byte_length',
      divergent_hash: {
        expected: String(artifact.canonical_byte_length),
        actual: String(recomputedLength),
      },
    });
  }

  // 7. Deterministic hash check.
  const recomputedHash = fnv1a32(canonicalArtifactCoreWithLength(artifact));
  if (recomputedHash !== artifact.deterministic_hash) {
    return Object.freeze({
      ok: false,
      divergence_field: 'deterministic_hash',
      divergent_hash: { expected: artifact.deterministic_hash, actual: recomputedHash },
    });
  }

  return Object.freeze({ ok: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — canonical JSON wire format
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert artifact to canonical JSON string (suitable for wire / disk).
 * Reverse of `deserializeProjectContent(json)`.
 *
 * Same artifact → byte-identical JSON ALWAYS (canonical key order).
 */
export function exportArtifactToJson(artifact: ExportArtifact): string {
  return canonicalSerialize({
    artifact_version: artifact.artifact_version,
    artifact_content_count: artifact.artifact_content_count,
    artifact_schema_fingerprint: artifact.artifact_schema_fingerprint,
    aggregate_hash: artifact.aggregate_hash,
    registry_snapshot_hash: artifact.registry_snapshot_hash,
    schema_names: artifact.schema_names,
    per_file: artifact.per_file.map((e) => ({
      schema_name: e.schema_name,
      content_hash: e.content_hash,
      result_hash: e.result_hash,
    })),
    canonical_content_hash: artifact.canonical_content_hash,
    canonical_byte_length: artifact.canonical_byte_length,
    deterministic_hash: artifact.deterministic_hash,
  });
}
