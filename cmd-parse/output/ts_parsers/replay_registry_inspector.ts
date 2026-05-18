/**
 * REPLAY REGISTRY INSPECTOR — CMD4 Phase 13 Module 1.
 *
 * Deep inspection of `ExportArtifact` (Commit #3) + `ForensicExport` (Commit #2).
 * Pure reader — detect drift, ordering issues, duplicates BEFORE shipping the
 * artifact to network / replay archive / CI diff.
 *
 * Brief v12 §TASK 1 responsibilities:
 *   1. registry integrity verification
 *   2. duplicate detection
 *   3. deterministic ordering validation
 *   4. registry snapshot comparison
 *   5. replay/export drift diagnostics
 *
 * Re-uses Commit #1 primitives (canonicalSerialize / fnv1a32 / SEVERITY)
 * and Commit #3 (verifyExportArtifact composition). NO duplicate canonical/hash.
 *
 * PURE READ-ONLY — no I/O, no mutation, no Date.now, no Math.random,
 * no localeCompare. Same input → same output ALWAYS.
 *
 * Ownership: tooling layer (brief v12 §III strict lock). KHÔNG đụng combat /
 * replay core / orchestration / economy / progression / network.
 */
import {
  canonicalSerialize,
  fnv1a32,
  SEVERITY,
  type Severity,
} from './schema_validation_runtime.js';
import {
  verifyExportArtifact,
  type ExportArtifact,
  type VerifyExportResult,
} from './deterministic_export_pipeline.js';
import type { ForensicExport } from './content_registry_loader.js';

// ═══════════════════════════════════════════════════════════════════════════
// Finding kinds
// ═══════════════════════════════════════════════════════════════════════════

export const INSPECTION_FINDING_KINDS = [
  'integrity_failure',          // verifyExportArtifact reported divergence
  'duplicate_schema_name',      // schema_names contains duplicate
  'duplicate_content_hash',     // per_file shares identical content_hash (suspicious clone)
  'ordering_violation',         // schema_names NOT lex sorted OR per_file index mismatch
  'empty_registry',             // schema_count == 0
  'forensic_export_drift',      // ForensicExport per_file order/hash inconsistent with artifact
  'unknown',
] as const;

export type InspectionFindingKind = (typeof INSPECTION_FINDING_KINDS)[number];

export interface InspectionFinding {
  readonly severity: Severity;
  readonly kind: InspectionFindingKind;
  readonly path: string;
  readonly message: string;
}

export interface InspectionReport {
  readonly ok: boolean;
  readonly schema_count: number;
  readonly duplicate_schema_count: number;
  readonly duplicate_content_hash_count: number;
  readonly findings: readonly InspectionFinding[];
  readonly deterministic_hash: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function lexCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareFinding(a: InspectionFinding, b: InspectionFinding): number {
  if (a.severity !== b.severity) return a.severity - b.severity;
  const c = lexCompare(a.kind, b.kind);
  if (c !== 0) return c;
  return lexCompare(a.path, b.path);
}

function canonicalReportInput(
  ok: boolean,
  schemaCount: number,
  dupSchema: number,
  dupContent: number,
  findings: readonly InspectionFinding[],
): string {
  return canonicalSerialize([
    ok,
    schemaCount,
    dupSchema,
    dupContent,
    findings.map((f) => [f.severity, f.kind, f.path, f.message]),
  ]);
}

function deepFreezeFindings(findings: InspectionFinding[]): readonly InspectionFinding[] {
  for (const f of findings) Object.freeze(f);
  return Object.freeze(findings);
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — inspectExportArtifact
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Deep inspection of an `ExportArtifact`. Performs:
 *   1. Commit #3 verifyExportArtifact (hash + length + fingerprint + version)
 *   2. Duplicate schema_name detection (lex pass)
 *   3. Duplicate content_hash detection (clone payload suspicion)
 *   4. Ordering invariant (schema_names lex, per_file index alignment)
 *   5. Empty registry check
 *
 * Returns frozen `InspectionReport` with deterministic_hash for replay diff.
 * NEVER throws.
 */
export function inspectExportArtifact(artifact: ExportArtifact): InspectionReport {
  const findings: InspectionFinding[] = [];

  // 1. Composition with Commit #3 verify.
  const v: VerifyExportResult = verifyExportArtifact(artifact);
  if (!v.ok) {
    findings.push({
      severity: SEVERITY.ERROR,
      kind: 'integrity_failure',
      path: v.divergence_field ?? 'unknown',
      message: `verifyExportArtifact divergence on field "${String(v.divergence_field)}"`,
    });
  }

  // 2. Empty registry.
  if (artifact.artifact_content_count === 0 || artifact.per_file.length === 0) {
    findings.push({
      severity: SEVERITY.WARNING,
      kind: 'empty_registry',
      path: '',
      message: 'export artifact has zero schemas — likely caller bug or empty registry',
    });
  }

  // 3. Duplicate schema_name detection.
  const seenNames = new Set<string>();
  const dupNames: string[] = [];
  for (const name of artifact.schema_names) {
    if (seenNames.has(name)) dupNames.push(name);
    seenNames.add(name);
  }
  for (const name of dupNames) {
    findings.push({
      severity: SEVERITY.ERROR,
      kind: 'duplicate_schema_name',
      path: name,
      message: `schema_name "${name}" appears more than once in schema_names list`,
    });
  }

  // 4. Duplicate content_hash detection (clone-payload heuristic).
  const seenContentHash = new Map<string, string>(); // hash → first schema_name
  const dupHashEntries: { hash: string; first: string; second: string }[] = [];
  for (const entry of artifact.per_file) {
    const prev = seenContentHash.get(entry.content_hash);
    if (prev !== undefined) {
      dupHashEntries.push({ hash: entry.content_hash, first: prev, second: entry.schema_name });
    } else {
      seenContentHash.set(entry.content_hash, entry.schema_name);
    }
  }
  for (const dup of dupHashEntries) {
    findings.push({
      severity: SEVERITY.WARNING,
      kind: 'duplicate_content_hash',
      path: `${dup.first}:${dup.second}`,
      message: `content_hash "${dup.hash}" shared by "${dup.first}" and "${dup.second}" — clone payload suspicion`,
    });
  }

  // 5. Ordering invariant (defensive — verifyExportArtifact already covers).
  for (let i = 1; i < artifact.schema_names.length; i++) {
    const prev = artifact.schema_names[i - 1];
    const cur = artifact.schema_names[i];
    if (prev !== undefined && cur !== undefined && lexCompare(prev, cur) > 0) {
      findings.push({
        severity: SEVERITY.ERROR,
        kind: 'ordering_violation',
        path: `schema_names.${String(i)}`,
        message: `schema_names not lex-sorted at index ${String(i)}: "${prev}" > "${cur}"`,
      });
      break;
    }
  }

  findings.sort(compareFinding);

  const ok = findings.length === 0 || !findings.some((f) => f.severity === SEVERITY.ERROR);
  const canonical = canonicalReportInput(ok, artifact.artifact_content_count, dupNames.length, dupHashEntries.length, findings);

  return Object.freeze({
    ok,
    schema_count: artifact.artifact_content_count,
    duplicate_schema_count: dupNames.length,
    duplicate_content_hash_count: dupHashEntries.length,
    findings: deepFreezeFindings(findings),
    deterministic_hash: fnv1a32(canonical),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — inspectForensicExport (Commit #2 ForensicExport)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Inspect a `ForensicExport` for ordering + per_file consistency.
 *
 * Checks:
 *   1. per_file ordered by schema_name lex
 *   2. Reported `schema_count == per_file.length == content_file_count`
 *   3. Duplicate schema_name in per_file
 */
export function inspectForensicExport(forensic: ForensicExport): InspectionReport {
  const findings: InspectionFinding[] = [];

  // Count consistency.
  if (
    forensic.schema_count !== forensic.per_file.length ||
    forensic.content_file_count !== forensic.per_file.length
  ) {
    findings.push({
      severity: SEVERITY.ERROR,
      kind: 'forensic_export_drift',
      path: 'count_mismatch',
      message: `forensic export count mismatch: schema_count=${String(forensic.schema_count)} content_file_count=${String(forensic.content_file_count)} per_file.length=${String(forensic.per_file.length)}`,
    });
  }

  // Lex order check.
  for (let i = 1; i < forensic.per_file.length; i++) {
    const prev = forensic.per_file[i - 1];
    const cur = forensic.per_file[i];
    if (prev !== undefined && cur !== undefined && lexCompare(prev.schema_name, cur.schema_name) > 0) {
      findings.push({
        severity: SEVERITY.ERROR,
        kind: 'ordering_violation',
        path: `per_file.${String(i)}`,
        message: `per_file not lex-sorted at index ${String(i)}`,
      });
      break;
    }
  }

  // Duplicate schema_name.
  const seen = new Set<string>();
  const dupSchemas: string[] = [];
  for (const entry of forensic.per_file) {
    if (seen.has(entry.schema_name)) dupSchemas.push(entry.schema_name);
    seen.add(entry.schema_name);
  }
  for (const name of dupSchemas) {
    findings.push({
      severity: SEVERITY.ERROR,
      kind: 'duplicate_schema_name',
      path: name,
      message: `forensic export has duplicate schema_name "${name}"`,
    });
  }

  // Empty.
  if (forensic.per_file.length === 0) {
    findings.push({
      severity: SEVERITY.WARNING,
      kind: 'empty_registry',
      path: '',
      message: 'forensic export has zero per_file entries',
    });
  }

  findings.sort(compareFinding);
  const ok = !findings.some((f) => f.severity === SEVERITY.ERROR);
  const canonical = canonicalReportInput(ok, forensic.schema_count, dupSchemas.length, 0, findings);

  return Object.freeze({
    ok,
    schema_count: forensic.schema_count,
    duplicate_schema_count: dupSchemas.length,
    duplicate_content_hash_count: 0,
    findings: deepFreezeFindings(findings),
    deterministic_hash: fnv1a32(canonical),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — compareArtifactSnapshots
// ═══════════════════════════════════════════════════════════════════════════

export interface SnapshotComparison {
  readonly identical: boolean;
  readonly aggregate_hash_match: boolean;
  readonly registry_snapshot_hash_match: boolean;
  readonly canonical_content_hash_match: boolean;
  readonly deterministic_hash_match: boolean;
  readonly added_schemas: readonly string[];
  readonly removed_schemas: readonly string[];
  readonly mutated_schemas: readonly string[]; // present both, different content/result hash
  readonly comparison_hash: string;
}

/**
 * Compare two `ExportArtifact` snapshots (e.g. baseline vs current branch).
 * Pure deterministic — same pair → same comparison output.
 *
 * Detects:
 *   - top-level hash divergence per field
 *   - added schemas (in `right` only)
 *   - removed schemas (in `left` only)
 *   - mutated schemas (present both, hash differs)
 */
export function compareArtifactSnapshots(left: ExportArtifact, right: ExportArtifact): SnapshotComparison {
  const leftMap = new Map<string, { content_hash: string; result_hash: string }>();
  const rightMap = new Map<string, { content_hash: string; result_hash: string }>();
  for (const e of left.per_file) leftMap.set(e.schema_name, { content_hash: e.content_hash, result_hash: e.result_hash });
  for (const e of right.per_file) rightMap.set(e.schema_name, { content_hash: e.content_hash, result_hash: e.result_hash });

  const added: string[] = [];
  const removed: string[] = [];
  const mutated: string[] = [];

  for (const name of rightMap.keys()) {
    if (!leftMap.has(name)) added.push(name);
  }
  for (const name of leftMap.keys()) {
    if (!rightMap.has(name)) removed.push(name);
  }
  for (const [name, lEntry] of leftMap) {
    const rEntry = rightMap.get(name);
    if (rEntry === undefined) continue;
    if (lEntry.content_hash !== rEntry.content_hash || lEntry.result_hash !== rEntry.result_hash) {
      mutated.push(name);
    }
  }

  added.sort(lexCompare);
  removed.sort(lexCompare);
  mutated.sort(lexCompare);

  const aggMatch = left.aggregate_hash === right.aggregate_hash;
  const regMatch = left.registry_snapshot_hash === right.registry_snapshot_hash;
  const contentMatch = left.canonical_content_hash === right.canonical_content_hash;
  const detMatch = left.deterministic_hash === right.deterministic_hash;
  const identical = aggMatch && regMatch && contentMatch && detMatch && added.length === 0 && removed.length === 0 && mutated.length === 0;

  const canonical = canonicalSerialize([
    identical,
    aggMatch,
    regMatch,
    contentMatch,
    detMatch,
    added,
    removed,
    mutated,
  ]);

  return Object.freeze({
    identical,
    aggregate_hash_match: aggMatch,
    registry_snapshot_hash_match: regMatch,
    canonical_content_hash_match: contentMatch,
    deterministic_hash_match: detMatch,
    added_schemas: Object.freeze(added),
    removed_schemas: Object.freeze(removed),
    mutated_schemas: Object.freeze(mutated),
    comparison_hash: fnv1a32(canonical),
  });
}
