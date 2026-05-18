/**
 * MULTI-REGION EXPORT AUDIT — CMD4 Phase 14 Module 3.
 *
 * Cross-region export parity verification — takes N labeled artifacts
 * (region_label → ExportArtifact) and produces a deterministic audit
 * report that proves: same content = same export hash across ALL regions.
 *
 * Brief v13 §TASK 3 responsibilities:
 *   1. region A vs region B export compare
 *   2. canonical ordering parity (lex-sorted regions, lex-sorted pairs)
 *   3. schema compatibility audit (schema_names lex-equal across regions)
 *   4. replay/export synchronization report
 *   5. deterministic shard verification (artifact_content_count + per_file)
 *
 * VERIFY (brief v13 §TASK 3): same content = same export hash across all
 * regions ALWAYS.
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence. Caller provides the
 * full region set up-front (or appends via append-only `addRegion`).
 *
 * Ownership: tooling layer (brief v13 §III). Does NOT touch combat /
 * orchestration / network / live DB.
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';
import type { ExportArtifact, ExportPerFileEntry } from './deterministic_export_pipeline.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const MULTI_REGION_AUDIT_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

/** Stable string kinds — canonical, lex-sorted when serialized. */
export const MULTI_REGION_DIVERGENCE_KINDS = [
  'aggregate_hash_mismatch',
  'artifact_content_count_mismatch',
  'artifact_schema_fingerprint_mismatch',
  'artifact_version_mismatch',
  'canonical_byte_length_mismatch',
  'canonical_content_hash_mismatch',
  'deterministic_hash_mismatch',
  'per_file_count_mismatch',
  'per_file_entry_mismatch',
  'registry_snapshot_hash_mismatch',
  'schema_names_mismatch',
] as const;
export type MultiRegionDivergenceKind = (typeof MULTI_REGION_DIVERGENCE_KINDS)[number];

export interface RegionArtifact {
  readonly region: string;
  readonly artifact: ExportArtifact;
}

export interface RegionDivergence {
  readonly kind: MultiRegionDivergenceKind;
  readonly reference_region: string;
  readonly diverged_region: string;
  readonly expected_canonical: string;
  readonly actual_canonical: string;
  /** FNV-1a fingerprint of (kind, reference_region, diverged_region, expected, actual). */
  readonly fingerprint: string;
}

export interface MultiRegionAuditReport {
  readonly audit_version: number;
  readonly region_count: number;
  /** All region labels, lex-sorted. */
  readonly regions: readonly string[];
  /** Lex-smallest region — used as parity baseline. */
  readonly reference_region: string | null;
  /** Lex-sorted by (diverged_region asc, kind asc). */
  readonly divergences: readonly RegionDivergence[];
  /** True if region_count <= 1 OR every non-reference region matches. */
  readonly ok: boolean;
  /** Deterministic FNV-1a over canonical report. */
  readonly deterministic_hash: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers — direct-codepoint compare
// ═══════════════════════════════════════════════════════════════════════════

function lexCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function fingerprintDivergence(
  kind: MultiRegionDivergenceKind,
  refRegion: string,
  divRegion: string,
  expected: string,
  actual: string,
): string {
  return fnv1a32(
    canonicalSerialize({
      kind,
      reference_region: refRegion,
      diverged_region: divRegion,
      expected,
      actual,
    }),
  );
}

function makeDivergence(
  kind: MultiRegionDivergenceKind,
  refRegion: string,
  divRegion: string,
  expectedValue: unknown,
  actualValue: unknown,
): RegionDivergence {
  const expected = canonicalSerialize(expectedValue);
  const actual = canonicalSerialize(actualValue);
  return Object.freeze({
    kind,
    reference_region: refRegion,
    diverged_region: divRegion,
    expected_canonical: expected,
    actual_canonical: actual,
    fingerprint: fingerprintDivergence(kind, refRegion, divRegion, expected, actual),
  });
}

function entriesEqual(a: ExportPerFileEntry, b: ExportPerFileEntry): boolean {
  return (
    a.schema_name === b.schema_name &&
    a.content_hash === b.content_hash &&
    a.result_hash === b.result_hash
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — auditMultiRegionExport
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Audit N regions for export parity. Reference region = lex-smallest
 * region label. Every other region is compared against the reference.
 *
 * Pure — same `regions` input (any insertion order) → same report bytes
 * ALWAYS. Region labels MUST be unique.
 *
 * Throws on caller bugs (duplicate region label, empty region name) —
 * those are programmer errors, NOT audit outcomes.
 */
export function auditMultiRegionExport(
  regions: readonly RegionArtifact[],
): MultiRegionAuditReport {
  // Caller validation
  const seen = new Set<string>();
  for (const r of regions) {
    if (typeof r.region !== 'string' || r.region.length === 0) {
      throw new Error('multi_region_audit: region label must be non-empty string');
    }
    if (seen.has(r.region)) {
      throw new Error(`multi_region_audit: duplicate region label "${r.region}"`);
    }
    seen.add(r.region);
  }

  // Lex sort regions by label — deterministic regardless of caller order.
  const sorted = [...regions].sort((a, b) => lexCompare(a.region, b.region));
  const labels = Object.freeze(sorted.map((r) => r.region));

  if (sorted.length === 0) {
    return emptyReport([], null);
  }
  if (sorted.length === 1) {
    return emptyReport(labels as string[], sorted[0]!.region);
  }

  const ref = sorted[0]!;
  const divs: RegionDivergence[] = [];
  for (let i = 1; i < sorted.length; i++) {
    diffPair(ref, sorted[i]!, divs);
  }

  // Lex sort divergences by (diverged_region asc, kind asc, fingerprint asc).
  // Tertiary key disambiguates same-kind same-region duplicates (e.g.
  // multiple per_file_entry_mismatch) without relying on Array.sort
  // stability semantics.
  divs.sort((a, b) => {
    const rc = lexCompare(a.diverged_region, b.diverged_region);
    if (rc !== 0) return rc;
    const kc = lexCompare(a.kind, b.kind);
    if (kc !== 0) return kc;
    return lexCompare(a.fingerprint, b.fingerprint);
  });

  const frozenDivs = Object.freeze(divs.map((d) => Object.freeze(d)));
  const canonical = canonicalSerialize({
    audit_version: MULTI_REGION_AUDIT_VERSION,
    region_count: sorted.length,
    regions: labels,
    reference_region: ref.region,
    divergences: frozenDivs.map((d) => ({
      kind: d.kind,
      reference_region: d.reference_region,
      diverged_region: d.diverged_region,
      expected_canonical: d.expected_canonical,
      actual_canonical: d.actual_canonical,
      fingerprint: d.fingerprint,
    })),
  });

  return Object.freeze({
    audit_version: MULTI_REGION_AUDIT_VERSION,
    region_count: sorted.length,
    regions: labels,
    reference_region: ref.region,
    divergences: frozenDivs,
    ok: frozenDivs.length === 0,
    deterministic_hash: fnv1a32(canonical),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — quick pair compare
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Two-region parity helper. Equivalent to `auditMultiRegionExport([a, b])`
 * but produces a flat boolean + divergence list.
 */
export function compareRegionExports(
  a: RegionArtifact,
  b: RegionArtifact,
): MultiRegionAuditReport {
  return auditMultiRegionExport([a, b]);
}

// ═══════════════════════════════════════════════════════════════════════════
// Internals — pair diff
// ═══════════════════════════════════════════════════════════════════════════

function diffPair(
  ref: RegionArtifact,
  cand: RegionArtifact,
  out: RegionDivergence[],
): void {
  const a = ref.artifact;
  const b = cand.artifact;
  const refR = ref.region;
  const candR = cand.region;

  if (a.artifact_version !== b.artifact_version) {
    out.push(makeDivergence('artifact_version_mismatch', refR, candR, a.artifact_version, b.artifact_version));
  }
  if (a.artifact_content_count !== b.artifact_content_count) {
    out.push(makeDivergence('artifact_content_count_mismatch', refR, candR, a.artifact_content_count, b.artifact_content_count));
  }
  if (a.artifact_schema_fingerprint !== b.artifact_schema_fingerprint) {
    out.push(makeDivergence('artifact_schema_fingerprint_mismatch', refR, candR, a.artifact_schema_fingerprint, b.artifact_schema_fingerprint));
  }
  if (a.aggregate_hash !== b.aggregate_hash) {
    out.push(makeDivergence('aggregate_hash_mismatch', refR, candR, a.aggregate_hash, b.aggregate_hash));
  }
  if (a.registry_snapshot_hash !== b.registry_snapshot_hash) {
    out.push(makeDivergence('registry_snapshot_hash_mismatch', refR, candR, a.registry_snapshot_hash, b.registry_snapshot_hash));
  }
  if (canonicalSerialize(a.schema_names) !== canonicalSerialize(b.schema_names)) {
    out.push(makeDivergence('schema_names_mismatch', refR, candR, a.schema_names, b.schema_names));
  }
  if (a.canonical_content_hash !== b.canonical_content_hash) {
    out.push(makeDivergence('canonical_content_hash_mismatch', refR, candR, a.canonical_content_hash, b.canonical_content_hash));
  }
  if (a.canonical_byte_length !== b.canonical_byte_length) {
    out.push(makeDivergence('canonical_byte_length_mismatch', refR, candR, a.canonical_byte_length, b.canonical_byte_length));
  }
  if (a.deterministic_hash !== b.deterministic_hash) {
    out.push(makeDivergence('deterministic_hash_mismatch', refR, candR, a.deterministic_hash, b.deterministic_hash));
  }

  if (a.per_file.length !== b.per_file.length) {
    out.push(makeDivergence('per_file_count_mismatch', refR, candR, a.per_file.length, b.per_file.length));
  } else {
    for (let i = 0; i < a.per_file.length; i++) {
      const ea = a.per_file[i]!;
      const eb = b.per_file[i]!;
      if (!entriesEqual(ea, eb)) {
        out.push(
          makeDivergence(
            'per_file_entry_mismatch',
            refR,
            candR,
            { index: i, schema_name: ea.schema_name, content_hash: ea.content_hash, result_hash: ea.result_hash },
            { index: i, schema_name: eb.schema_name, content_hash: eb.content_hash, result_hash: eb.result_hash },
          ),
        );
      }
    }
  }
}

function emptyReport(labels: readonly string[], reference: string | null): MultiRegionAuditReport {
  const canonical = canonicalSerialize({
    audit_version: MULTI_REGION_AUDIT_VERSION,
    region_count: labels.length,
    regions: labels,
    reference_region: reference,
    divergences: [],
  });
  return Object.freeze({
    audit_version: MULTI_REGION_AUDIT_VERSION,
    region_count: labels.length,
    regions: Object.freeze([...labels]),
    reference_region: reference,
    divergences: Object.freeze([] as RegionDivergence[]),
    ok: true,
    deterministic_hash: fnv1a32(canonical),
  });
}
