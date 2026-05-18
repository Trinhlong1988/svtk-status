/**
 * AUTOMATED REPLAY REGRESSION RUNTIME — CMD4 Phase 15 Module 1.
 *
 * Continuous replay regression verification — composes Phase 14 drift
 * monitor + Phase 13 hash validator + Phase 15 M3 archive into a single
 * historical regression gate. Same replay source → same regression result
 * ALWAYS.
 *
 * Brief v15 §M1 responsibilities:
 *   1. replay regression chain validation (audit archive chain)
 *   2. historical replay comparison (candidate vs archive entries)
 *   3. deterministic replay diff audit (pairwise diff between 2 entries)
 *   4. replay drift regression detection (drift vs latest / vs baseline)
 *   5. canonical replay rerun verification (artifact internal hash recheck)
 *
 * MANDATORY (brief v15 §M1):
 *   same replay source → same regression result ALWAYS.
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence.
 *
 * Ownership: tooling/validator/forensic layer (brief v15 §III).
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';
import {
  verifyExportArtifact,
  type ExportArtifact,
  type VerifyExportResult,
} from './deterministic_export_pipeline.js';
import {
  validateSerializationHashes,
  type HashValidationReport,
} from './serialization_hash_validator.js';
import {
  compareReplayArtifacts,
  type DriftReport,
  type DriftDivergence,
} from './replay_drift_monitor.js';
import {
  ImmutableSnapshotArchive,
  type ArchiveEntry,
} from './immutable_snapshot_archive.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const REPLAY_REGRESSION_RUNTIME_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface RegressionOptions {
  /** Optional baseline label (archive label) to diff candidate against. */
  readonly baseline_label?: string;
}

export interface RegressionReport {
  readonly regression_runtime_version: number;
  /** Candidate artifact's deterministic_hash. */
  readonly candidate_hash: string;
  /** Label of archive entry whose artifact_hash equals candidate (if any). */
  readonly matched_archive_label: string | null;
  readonly matched_archive_ordinal: number | null;
  /** Label of latest archive entry (largest ordinal). null if archive empty. */
  readonly latest_archive_label: string | null;
  /** Drift report candidate vs latest archive entry. null if archive empty. */
  readonly drift_vs_latest: DriftReport | null;
  /** Echoed baseline label (caller-provided). null if not provided. */
  readonly baseline_label: string | null;
  /** Drift report candidate vs baseline. null if no baseline. */
  readonly drift_vs_baseline: DriftReport | null;
  /** Candidate artifact's internal verify result (verifyExportArtifact). */
  readonly rerun_verify_ok: boolean;
  /** Candidate artifact's full hash validation (validateSerializationHashes). */
  readonly rerun_hash_validation_ok: boolean;
  /** True iff candidate verifies AND drifts are absent (vs both latest + baseline). */
  readonly ok: boolean;
  /** Deterministic FNV-1a over canonical report. */
  readonly deterministic_hash: string;
}

export interface ArchiveChainAuditEntry {
  readonly ordinal: number;
  readonly label: string;
  readonly verify_ok: boolean;
  readonly hash_validation_ok: boolean;
}

export interface ArchiveChainAuditReport {
  readonly regression_runtime_version: number;
  readonly archive_entry_count: number;
  /** Lex-sorted by label, frozen. */
  readonly per_entry: readonly ArchiveChainAuditEntry[];
  /** Lex-sorted by ordinal asc, then kind asc — drift between consecutive entries. */
  readonly consecutive_drifts: readonly DriftDivergence[];
  readonly all_entries_verify_ok: boolean;
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

function findLatest(archive: ImmutableSnapshotArchive): ArchiveEntry | undefined {
  // O(1) — avoids full index rebuild that exportSnapshot() would trigger.
  return archive.latestEntry();
}

function findByLabel(
  archive: ImmutableSnapshotArchive,
  label: string,
): ArchiveEntry | undefined {
  return archive.lookupByLabel(label);
}

/**
 * Find first archive entry whose `artifact.deterministic_hash` matches.
 * "First" = lex-smallest label among matches (archive enforces label
 * uniqueness, so this is deterministic regardless of insertion order).
 */
function findMatchByHash(
  archive: ImmutableSnapshotArchive,
  artifactHash: string,
): ArchiveEntry | undefined {
  const matches = archive.lookupByArtifactHash(artifactHash);
  return matches.length === 0 ? undefined : matches[0];
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — runReplayRegression
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run a regression check: candidate artifact vs archive history.
 *
 * Steps:
 *   1. canonical replay rerun verification — `verifyExportArtifact` +
 *      `validateSerializationHashes` on the candidate
 *   2. historical replay comparison — find archive entry whose artifact_hash
 *      equals candidate
 *   3. replay drift regression detection — drift candidate vs latest archive
 *      entry, and optionally vs `options.baseline_label`
 *
 * Pure — same (archive snapshot, candidate, options) → same report bytes.
 * NEVER throws on regression — gate is `result.ok`.
 *
 * Throws on caller bugs only (e.g. baseline_label not in archive).
 *
 * ── `ok` SEMANTICS (IMPORTANT for multi-release rollout) ──────────────────
 *   `result.ok` is true iff verify.ok AND hash_validation.ok AND
 *   drift_vs_latest.ok AND (drift_vs_baseline === null OR drift_vs_baseline.ok).
 *
 *   This is REGRESSION-DETECTION semantics: any drift from the latest
 *   archived state is treated as a fail. For RELEASE-VALIDATION semantics
 *   (where the candidate is INTENDED to differ from the previous release),
 *   either:
 *     (a) use a per-release archive — each new release lives in its own
 *         `ImmutableSnapshotArchive` so `latest` equals the release being
 *         validated. See Phase 18 §6.3 for the canonical pattern.
 *     (b) ignore `result.ok` and inspect `drift_vs_baseline.ok` directly
 *         when `baseline_label` is provided.
 */
export function runReplayRegression(
  archive: ImmutableSnapshotArchive,
  candidate: ExportArtifact,
  options?: RegressionOptions,
): RegressionReport {
  // Step 1: canonical rerun
  const verify: VerifyExportResult = verifyExportArtifact(candidate);
  const hashVal: HashValidationReport = validateSerializationHashes(candidate);

  // Step 2: historical match
  const match = findMatchByHash(archive, candidate.deterministic_hash);
  const matchedLabel = match?.label ?? null;
  const matchedOrdinal = match?.ordinal ?? null;

  // Step 3a: latest comparison
  const latest = findLatest(archive);
  const latestLabel = latest?.label ?? null;
  const driftVsLatest =
    latest !== undefined
      ? compareReplayArtifacts(latest.artifact, candidate, 'candidate')
      : null;

  // Step 3b: baseline comparison (if any)
  let driftVsBaseline: DriftReport | null = null;
  let baselineLabel: string | null = null;
  if (options?.baseline_label !== undefined) {
    const baseline = findByLabel(archive, options.baseline_label);
    if (baseline === undefined) {
      throw new Error(
        `automated_replay_regression_runtime: baseline_label "${options.baseline_label}" not in archive`,
      );
    }
    baselineLabel = baseline.label;
    driftVsBaseline = compareReplayArtifacts(baseline.artifact, candidate, 'candidate');
  }

  const ok =
    verify.ok &&
    hashVal.ok &&
    (driftVsLatest === null || driftVsLatest.ok) &&
    (driftVsBaseline === null || driftVsBaseline.ok);

  const canonical = canonicalSerialize({
    regression_runtime_version: REPLAY_REGRESSION_RUNTIME_VERSION,
    candidate_hash: candidate.deterministic_hash,
    matched_archive_label: matchedLabel,
    matched_archive_ordinal: matchedOrdinal,
    latest_archive_label: latestLabel,
    drift_vs_latest_hash: driftVsLatest?.deterministic_hash ?? null,
    baseline_label: baselineLabel,
    drift_vs_baseline_hash: driftVsBaseline?.deterministic_hash ?? null,
    rerun_verify_ok: verify.ok,
    rerun_hash_validation_ok: hashVal.ok,
    ok,
  });

  return Object.freeze({
    regression_runtime_version: REPLAY_REGRESSION_RUNTIME_VERSION,
    candidate_hash: candidate.deterministic_hash,
    matched_archive_label: matchedLabel,
    matched_archive_ordinal: matchedOrdinal,
    latest_archive_label: latestLabel,
    drift_vs_latest: driftVsLatest,
    baseline_label: baselineLabel,
    drift_vs_baseline: driftVsBaseline,
    rerun_verify_ok: verify.ok,
    rerun_hash_validation_ok: hashVal.ok,
    ok,
    deterministic_hash: fnv1a32(canonical),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — auditArchiveReplayChain
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Audit the full archive replay chain:
 *   - Re-verify every archive entry's artifact (internal hash chain).
 *   - Drift-compare consecutive entries (ordinal i vs i+1) — surfaces
 *     historical regressions (e.g. content reordered in archive).
 *
 * Returns frozen `ArchiveChainAuditReport`. Pure — same archive state →
 * same report bytes ALWAYS.
 */
export function auditArchiveReplayChain(
  archive: ImmutableSnapshotArchive,
): ArchiveChainAuditReport {
  // O(1) entries accessor — skips the heavy index rebuild that
  // exportSnapshot() would do.
  const entries = archive.allEntries();
  const perEntry: ArchiveChainAuditEntry[] = [];
  let allOk = true;
  for (const e of entries) {
    const v = verifyExportArtifact(e.artifact);
    const h = validateSerializationHashes(e.artifact);
    const ok = v.ok && h.ok;
    if (!ok) allOk = false;
    perEntry.push(
      Object.freeze({
        ordinal: e.ordinal,
        label: e.label,
        verify_ok: v.ok,
        hash_validation_ok: h.ok,
      }),
    );
  }
  // Lex sort by label for deterministic per_entry order (label is unique
  // within archive). Ordinal also monotonic but label sort = canonical view.
  perEntry.sort((a, b) => lexCompare(a.label, b.label));

  // Consecutive drift detection
  const consecutiveDrifts: DriftDivergence[] = [];
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]!;
    const curr = entries[i]!;
    const drift = compareReplayArtifacts(prev.artifact, curr.artifact, curr.label);
    for (const d of drift.divergences) consecutiveDrifts.push(d);
  }
  // Sort by (ordinal, kind, fingerprint, label). The quaternary `label`
  // key disambiguates when two pairwise compares produce the same
  // (kind, expected, actual) tuple at different positions in the chain
  // (e.g. A→B→A→B sequence — same field transition twice). Each chain
  // entry has a unique label by archive contract, so label-tiebreak
  // produces a fully deterministic order without relying on Array.sort
  // stability semantics.
  consecutiveDrifts.sort((a, b) => {
    const oc = intCompare(a.diverged_ordinal, b.diverged_ordinal);
    if (oc !== 0) return oc;
    const kc = lexCompare(a.kind, b.kind);
    if (kc !== 0) return kc;
    const fc = lexCompare(a.fingerprint, b.fingerprint);
    if (fc !== 0) return fc;
    return lexCompare(a.diverged_label, b.diverged_label);
  });
  const frozenDrifts = Object.freeze(consecutiveDrifts.map((d) => Object.freeze(d)));
  const frozenPerEntry = Object.freeze(perEntry.map((e) => e));

  const canonical = canonicalSerialize({
    regression_runtime_version: REPLAY_REGRESSION_RUNTIME_VERSION,
    archive_entry_count: entries.length,
    per_entry: frozenPerEntry.map((e) => ({
      ordinal: e.ordinal,
      label: e.label,
      verify_ok: e.verify_ok,
      hash_validation_ok: e.hash_validation_ok,
    })),
    consecutive_drift_fingerprints: frozenDrifts.map((d) => d.fingerprint),
    all_entries_verify_ok: allOk,
  });

  return Object.freeze({
    regression_runtime_version: REPLAY_REGRESSION_RUNTIME_VERSION,
    archive_entry_count: entries.length,
    per_entry: frozenPerEntry,
    consecutive_drifts: frozenDrifts,
    all_entries_verify_ok: allOk,
    deterministic_hash: fnv1a32(canonical),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — diffArchiveSnapshots (pairwise diff between 2 entries)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pairwise diff between two named archive entries. Useful for "what
 * changed between release v1 and v2" forensic queries.
 *
 * Throws if either label is not in archive.
 */
export function diffArchiveSnapshots(
  archive: ImmutableSnapshotArchive,
  labelA: string,
  labelB: string,
): DriftReport {
  const a = findByLabel(archive, labelA);
  const b = findByLabel(archive, labelB);
  if (a === undefined) {
    throw new Error(
      `automated_replay_regression_runtime: label "${labelA}" not in archive`,
    );
  }
  if (b === undefined) {
    throw new Error(
      `automated_replay_regression_runtime: label "${labelB}" not in archive`,
    );
  }
  return compareReplayArtifacts(a.artifact, b.artifact, labelB);
}
