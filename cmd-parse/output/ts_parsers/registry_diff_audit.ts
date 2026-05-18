/**
 * REGISTRY DIFF AUDIT — CMD4 Phase 13 Module 3.
 *
 * Detect deterministic drift between SchemaRegistry / ExportArtifact snapshots.
 *
 * Brief v12 §TASK 4 responsibilities:
 *   1. canonical diff ordering (lex sort everywhere)
 *   2. snapshot divergence audit (added / removed schemas)
 *   3. schema drift detection (fingerprint mismatch + per_file mutation)
 *   4. replay/export compatibility audit (cross-version compatibility check)
 *
 * Pure read-only — no I/O, no mutation, no wall-clock, no Math.random,
 * no localeCompare. Same pair of inputs → same diff output ALWAYS.
 *
 * Different from Module 1 `compareArtifactSnapshots` (which em provided):
 * Module 1 = high-level artifact comparison (added/removed/mutated).
 * Module 3 = deeper drift signal (fingerprint, compatibility, replay impact).
 *
 * Ownership: tooling layer (brief v12 §III strict).
 */
import { canonicalSerialize, fnv1a32, SchemaRegistry } from './schema_validation_runtime.js';
import {
  EXPORT_ARTIFACT_VERSION,
  type ExportArtifact,
} from './deterministic_export_pipeline.js';

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export const DRIFT_KINDS = [
  'schema_added',
  'schema_removed',
  'schema_content_mutated',
  'schema_result_mutated',
  'registry_fingerprint_drift',
  'registry_snapshot_drift',
  'artifact_version_drift',
] as const;
export type DriftKind = (typeof DRIFT_KINDS)[number];

export interface RegistryDriftEntry {
  readonly kind: DriftKind;
  readonly schema_name: string; // empty string for non-per-schema drift kinds
  readonly detail: string;
}

export interface RegistryDiffReport {
  readonly identical: boolean;
  readonly baseline_snapshot_hash: string;
  readonly current_snapshot_hash: string;
  readonly schema_added_count: number;
  readonly schema_removed_count: number;
  readonly schema_content_mutated_count: number;
  readonly schema_result_mutated_count: number;
  readonly registry_fingerprint_diverged: boolean;
  readonly registry_snapshot_diverged: boolean;
  readonly artifact_version_diverged: boolean;
  readonly drift_entries: readonly RegistryDriftEntry[];
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

function makeDrift(kind: DriftKind, schemaName: string, detail: string): RegistryDriftEntry {
  return Object.freeze({ kind, schema_name: schemaName, detail });
}

function compareDriftEntry(a: RegistryDriftEntry, b: RegistryDriftEntry): number {
  const k = lexCompare(a.kind, b.kind);
  if (k !== 0) return k;
  return lexCompare(a.schema_name, b.schema_name);
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — diffRegistrySnapshots (SchemaRegistry direct)
// ═══════════════════════════════════════════════════════════════════════════

export interface SchemaSnapshotDiff {
  readonly identical: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly baseline_snapshot_hash: string;
  readonly current_snapshot_hash: string;
  readonly deterministic_hash: string;
}

/**
 * Compare two `SchemaRegistry` instances by their registered name sets.
 *
 * Note: cannot compare schema implementations (ZodTypeAny is opaque reference).
 * Drift detection is name-set + snapshotHash level. For runtime behavioral
 * drift use `auditArtifactRegistryDrift` (artifact-level).
 */
export function diffRegistrySnapshots(
  baseline: SchemaRegistry,
  current: SchemaRegistry,
): SchemaSnapshotDiff {
  const baselineNames = new Set(baseline.list());
  const currentNames = new Set(current.list());

  const added: string[] = [];
  const removed: string[] = [];
  for (const name of currentNames) if (!baselineNames.has(name)) added.push(name);
  for (const name of baselineNames) if (!currentNames.has(name)) removed.push(name);
  added.sort(lexCompare);
  removed.sort(lexCompare);

  const baselineHash = baseline.snapshotHash();
  const currentHash = current.snapshotHash();
  const identical = baselineHash === currentHash && added.length === 0 && removed.length === 0;

  const canonical = canonicalSerialize({
    identical,
    added,
    removed,
    baseline_snapshot_hash: baselineHash,
    current_snapshot_hash: currentHash,
  });

  return Object.freeze({
    identical,
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    baseline_snapshot_hash: baselineHash,
    current_snapshot_hash: currentHash,
    deterministic_hash: fnv1a32(canonical),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — auditArtifactRegistryDrift
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Audit deterministic drift between two `ExportArtifact` snapshots.
 * Surfaces drift_entries categorized by `DriftKind`:
 *   - schema_added / schema_removed (name-set delta)
 *   - schema_content_mutated (per_file.content_hash diff for same name)
 *   - schema_result_mutated (per_file.result_hash diff for same name)
 *   - registry_fingerprint_drift (artifact_schema_fingerprint mismatch)
 *   - registry_snapshot_drift (registry_snapshot_hash mismatch)
 *   - artifact_version_drift (version mismatch — cross-version compat audit)
 *
 * Use case: replay/export compatibility audit before merge or deploy.
 * Returns frozen deterministic report — same pair → same hash ALWAYS.
 */
export function auditArtifactRegistryDrift(
  baseline: ExportArtifact,
  current: ExportArtifact,
): RegistryDiffReport {
  const drifts: RegistryDriftEntry[] = [];

  // 1. Version drift.
  const versionDiverged = baseline.artifact_version !== current.artifact_version;
  if (versionDiverged) {
    drifts.push(
      makeDrift(
        'artifact_version_drift',
        '',
        `baseline v${String(baseline.artifact_version)} vs current v${String(current.artifact_version)}`,
      ),
    );
  }

  // 2. Schema added / removed (name set delta).
  const baselineMap = new Map<string, { content_hash: string; result_hash: string }>();
  const currentMap = new Map<string, { content_hash: string; result_hash: string }>();
  for (const e of baseline.per_file) baselineMap.set(e.schema_name, { content_hash: e.content_hash, result_hash: e.result_hash });
  for (const e of current.per_file) currentMap.set(e.schema_name, { content_hash: e.content_hash, result_hash: e.result_hash });

  const addedNames: string[] = [];
  const removedNames: string[] = [];
  const contentMutated: string[] = [];
  const resultMutated: string[] = [];

  for (const name of currentMap.keys()) {
    if (!baselineMap.has(name)) addedNames.push(name);
  }
  for (const name of baselineMap.keys()) {
    if (!currentMap.has(name)) removedNames.push(name);
  }
  for (const [name, baseEntry] of baselineMap) {
    const curEntry = currentMap.get(name);
    if (curEntry === undefined) continue;
    if (baseEntry.content_hash !== curEntry.content_hash) contentMutated.push(name);
    if (baseEntry.result_hash !== curEntry.result_hash) resultMutated.push(name);
  }

  addedNames.sort(lexCompare);
  removedNames.sort(lexCompare);
  contentMutated.sort(lexCompare);
  resultMutated.sort(lexCompare);

  for (const name of addedNames) drifts.push(makeDrift('schema_added', name, `schema "${name}" appeared in current`));
  for (const name of removedNames) drifts.push(makeDrift('schema_removed', name, `schema "${name}" missing in current`));
  for (const name of contentMutated) drifts.push(makeDrift('schema_content_mutated', name, `content_hash diverged for "${name}"`));
  for (const name of resultMutated) drifts.push(makeDrift('schema_result_mutated', name, `result_hash diverged for "${name}"`));

  // 3. Registry fingerprint + snapshot drift.
  const fingerprintDiverged = baseline.artifact_schema_fingerprint !== current.artifact_schema_fingerprint;
  if (fingerprintDiverged) {
    drifts.push(
      makeDrift(
        'registry_fingerprint_drift',
        '',
        `${baseline.artifact_schema_fingerprint} → ${current.artifact_schema_fingerprint}`,
      ),
    );
  }
  const snapshotDiverged = baseline.registry_snapshot_hash !== current.registry_snapshot_hash;
  if (snapshotDiverged) {
    drifts.push(
      makeDrift(
        'registry_snapshot_drift',
        '',
        `${baseline.registry_snapshot_hash} → ${current.registry_snapshot_hash}`,
      ),
    );
  }

  drifts.sort(compareDriftEntry);

  const identical = drifts.length === 0;

  const canonical = canonicalSerialize({
    identical,
    baseline_snapshot_hash: baseline.registry_snapshot_hash,
    current_snapshot_hash: current.registry_snapshot_hash,
    drift_entries: drifts.map((d) => [d.kind, d.schema_name, d.detail]),
  });

  return Object.freeze({
    identical,
    baseline_snapshot_hash: baseline.registry_snapshot_hash,
    current_snapshot_hash: current.registry_snapshot_hash,
    schema_added_count: addedNames.length,
    schema_removed_count: removedNames.length,
    schema_content_mutated_count: contentMutated.length,
    schema_result_mutated_count: resultMutated.length,
    registry_fingerprint_diverged: fingerprintDiverged,
    registry_snapshot_diverged: snapshotDiverged,
    artifact_version_diverged: versionDiverged,
    drift_entries: Object.freeze(drifts),
    deterministic_hash: fnv1a32(canonical),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — replayCompatibilityCheck (cross-version safety)
// ═══════════════════════════════════════════════════════════════════════════

export interface ReplayCompatibilityResult {
  readonly compatible: boolean;
  readonly artifact_version_match: boolean;
  readonly schema_set_match: boolean;
  readonly registry_snapshot_match: boolean;
  readonly note: string;
}

/**
 * Quick cross-version replay safety check for two artifacts.
 * Compatibility = artifact_version match AND registry snapshot hash match.
 *
 * Note: this is a CONSERVATIVE check. If `artifact_version` matches but
 * schema_set differs, replay may STILL work for content that uses common
 * schemas — caller may need finer-grained inspection via
 * `auditArtifactRegistryDrift`.
 */
export function replayCompatibilityCheck(
  baseline: ExportArtifact,
  current: ExportArtifact,
): ReplayCompatibilityResult {
  const versionMatch = baseline.artifact_version === current.artifact_version;
  const snapshotMatch = baseline.registry_snapshot_hash === current.registry_snapshot_hash;

  const baselineNames = new Set(baseline.schema_names);
  const currentNames = new Set(current.schema_names);
  let schemaSetMatch = baselineNames.size === currentNames.size;
  if (schemaSetMatch) {
    for (const n of baselineNames) {
      if (!currentNames.has(n)) {
        schemaSetMatch = false;
        break;
      }
    }
  }

  const compatible = versionMatch && schemaSetMatch && snapshotMatch;
  let note = 'replay-compatible';
  if (!versionMatch) note = `version_drift v${String(baseline.artifact_version)}→v${String(current.artifact_version)} — migration handler required`;
  else if (!schemaSetMatch) note = 'schema_set_drift — added/removed schemas';
  else if (!snapshotMatch) note = 'registry_snapshot_drift — schema content may differ';

  // Forward-compat hint: if current.version > baseline.version, deserializer
  // on baseline side will reject (z.literal(EXPORT_ARTIFACT_VERSION)). Caller
  // must ship migration handler.
  if (current.artifact_version > EXPORT_ARTIFACT_VERSION) {
    note += ` — current is newer than known EXPORT_ARTIFACT_VERSION=${String(EXPORT_ARTIFACT_VERSION)}`;
  }

  return Object.freeze({
    compatible,
    artifact_version_match: versionMatch,
    schema_set_match: schemaSetMatch,
    registry_snapshot_match: snapshotMatch,
    note,
  });
}
