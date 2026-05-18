/**
 * REPLAY DRIFT MONITOR — CMD4 Phase 14 Module 2.
 *
 * Continuous replay drift detection infrastructure — append-only artifact
 * log, drift fingerprinting, divergence categorization, deterministic
 * replay diagnostics, regression snapshot export.
 *
 * Brief v13 §TASK 2 responsibilities:
 *   1. replay artifact compare (baseline vs subsequent recordings)
 *   2. drift fingerprinting (deterministic FNV-1a per divergence)
 *   3. divergence categorization (stable string kinds, no runtime enum)
 *   4. deterministic replay diagnostics (canonical sort, frozen output)
 *   5. regression snapshot export (full state captured as frozen object)
 *
 * TARGET (brief v13 §TASK 2): 0 nondeterministic drift.
 *
 * Stateful but PURE — caller manages logical clock (ordinal). No IO, no
 * Date.now, no Math.random, no localeCompare, no insertion-order
 * dependence beyond append-only log (which is itself a caller-controlled
 * sequence).
 *
 * Ownership: tooling layer (brief v13 §III). Does NOT touch combat /
 * orchestration / network / live DB.
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';
import type { ExportArtifact, ExportPerFileEntry } from './deterministic_export_pipeline.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const REPLAY_DRIFT_MONITOR_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

/** Stable string kinds — keep canonical, sorted lex when serialized. */
export const DRIFT_KINDS = [
  'aggregate_hash_drift',
  'artifact_version_drift',
  'canonical_byte_length_drift',
  'canonical_content_hash_drift',
  'content_count_drift',
  'deterministic_hash_drift',
  'per_file_count_drift',
  'per_file_entry_drift',
  'registry_snapshot_drift',
  'schema_fingerprint_drift',
  'schema_names_drift',
] as const;
export type DriftKind = (typeof DRIFT_KINDS)[number];

/** Single drift entry — frozen, deterministic. */
export interface DriftDivergence {
  readonly kind: DriftKind;
  /** Ordinal of the record that diverged from baseline. */
  readonly diverged_ordinal: number;
  /** Caller-supplied label of the diverging record. */
  readonly diverged_label: string;
  /** Canonical-serialized expected value (from baseline). */
  readonly expected_canonical: string;
  /** Canonical-serialized actual value (from diverging record). */
  readonly actual_canonical: string;
  /** FNV-1a fingerprint of (kind, expected, actual) — stable for telemetry. */
  readonly fingerprint: string;
}

export interface ReplayRecord {
  readonly ordinal: number;
  readonly label: string;
  readonly artifact: ExportArtifact;
}

export interface DriftReport {
  readonly monitor_version: number;
  readonly record_count: number;
  /** Ordinal of the baseline record (first recordReplay call). */
  readonly baseline_ordinal: number | null;
  /** Baseline label (first recordReplay call). */
  readonly baseline_label: string | null;
  /** Lex-sorted by (diverged_ordinal asc, kind asc). */
  readonly divergences: readonly DriftDivergence[];
  /** True if record_count <= 1 OR all subsequent records identical to baseline. */
  readonly ok: boolean;
  /** Deterministic FNV-1a of canonical report content. */
  readonly deterministic_hash: string;
}

export interface RegressionSnapshot {
  readonly monitor_version: number;
  readonly records: readonly ReplayRecord[];
  readonly report: DriftReport;
  /** Deterministic FNV-1a of canonical snapshot content. */
  readonly deterministic_hash: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers — direct-codepoint compare (NEVER localeCompare)
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

function fingerprintDivergence(
  kind: DriftKind,
  expected: string,
  actual: string,
): string {
  return fnv1a32(canonicalSerialize({ kind, expected, actual }));
}

function makeDivergence(
  kind: DriftKind,
  ordinal: number,
  label: string,
  expectedValue: unknown,
  actualValue: unknown,
): DriftDivergence {
  const expected = canonicalSerialize(expectedValue);
  const actual = canonicalSerialize(actualValue);
  return Object.freeze({
    kind,
    diverged_ordinal: ordinal,
    diverged_label: label,
    expected_canonical: expected,
    actual_canonical: actual,
    fingerprint: fingerprintDivergence(kind, expected, actual),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-file diff — emit ONE per_file_entry_drift per diverging index
// ═══════════════════════════════════════════════════════════════════════════

function compareEntry(
  baseline: ExportPerFileEntry,
  candidate: ExportPerFileEntry,
): boolean {
  return (
    baseline.schema_name === candidate.schema_name &&
    baseline.content_hash === candidate.content_hash &&
    baseline.result_hash === candidate.result_hash
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ReplayDriftMonitor — append-only log + drift detection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Stateful append-only monitor. Same sequence of `recordReplay` calls →
 * same DriftReport ALWAYS. No internal random/time/network.
 */
export class ReplayDriftMonitor {
  private readonly records: ReplayRecord[] = [];
  private lastOrdinal: number | null = null;

  /**
   * Append a replay observation. Ordinal MUST be strictly monotonic
   * (caller-managed logical clock — prevents non-deterministic insertion).
   */
  recordReplay(ordinal: number, label: string, artifact: ExportArtifact): void {
    // Number.isSafeInteger (not Number.isInteger): values >= 2^53 alias under
    // IEEE-754 (2^53 + 1 === 2^53), which would silently break the strict-
    // monotonic ordinal guard below.
    if (!Number.isSafeInteger(ordinal)) {
      throw new Error(`replay_drift_monitor: ordinal must be a safe integer, got ${String(ordinal)}`);
    }
    if (this.lastOrdinal !== null && ordinal <= this.lastOrdinal) {
      throw new Error(
        `replay_drift_monitor: ordinal must be strictly monotonic (last=${String(this.lastOrdinal)}, got=${String(ordinal)})`,
      );
    }
    if (typeof label !== 'string' || label.length === 0) {
      throw new Error('replay_drift_monitor: label must be non-empty string');
    }
    this.records.push(Object.freeze({ ordinal, label, artifact }));
    this.lastOrdinal = ordinal;
  }

  /** Number of replays recorded. */
  get size(): number {
    return this.records.length;
  }

  /**
   * Compare every record (index 1+) against the baseline (index 0).
   * Returns a frozen `DriftReport`. Pure — same state → same report.
   */
  detectDrift(): DriftReport {
    if (this.records.length === 0) {
      return this.emptyReport(null, null, []);
    }
    const baseline = this.records[0]!;
    if (this.records.length === 1) {
      return this.emptyReport(baseline.ordinal, baseline.label, []);
    }

    const divs: DriftDivergence[] = [];
    for (let i = 1; i < this.records.length; i++) {
      const r = this.records[i]!;
      this.diffArtifact(baseline.artifact, r.artifact, r.ordinal, r.label, divs);
    }

    // Lex sort by (ordinal asc, kind asc, fingerprint asc) — deterministic
    // regardless of detection order. Tertiary key disambiguates multiple
    // divergences of the same kind at the same ordinal (e.g. multiple
    // per_file_entry_drift entries) without depending on Array.sort
    // stability semantics.
    divs.sort((a, b) => {
      const oc = intCompare(a.diverged_ordinal, b.diverged_ordinal);
      if (oc !== 0) return oc;
      const kc = lexCompare(a.kind, b.kind);
      if (kc !== 0) return kc;
      return lexCompare(a.fingerprint, b.fingerprint);
    });

    const sortedDivs = Object.freeze(divs.map((d) => Object.freeze(d)));
    const canonical = canonicalSerialize({
      monitor_version: REPLAY_DRIFT_MONITOR_VERSION,
      record_count: this.records.length,
      baseline_ordinal: baseline.ordinal,
      baseline_label: baseline.label,
      divergences: sortedDivs.map((d) => ({
        kind: d.kind,
        diverged_ordinal: d.diverged_ordinal,
        diverged_label: d.diverged_label,
        expected_canonical: d.expected_canonical,
        actual_canonical: d.actual_canonical,
        fingerprint: d.fingerprint,
      })),
    });
    return Object.freeze({
      monitor_version: REPLAY_DRIFT_MONITOR_VERSION,
      record_count: this.records.length,
      baseline_ordinal: baseline.ordinal,
      baseline_label: baseline.label,
      divergences: sortedDivs,
      ok: sortedDivs.length === 0,
      deterministic_hash: fnv1a32(canonical),
    });
  }

  /**
   * Frozen snapshot of all records + drift report — used for regression
   * archives. Same monitor state → same snapshot bytes.
   */
  exportRegressionSnapshot(): RegressionSnapshot {
    const report = this.detectDrift();
    const records: readonly ReplayRecord[] = Object.freeze(
      this.records.map((r) => Object.freeze({ ordinal: r.ordinal, label: r.label, artifact: r.artifact })),
    );
    const canonical = canonicalSerialize({
      monitor_version: REPLAY_DRIFT_MONITOR_VERSION,
      records: records.map((r) => ({
        ordinal: r.ordinal,
        label: r.label,
        artifact_hash: r.artifact.deterministic_hash,
        aggregate_hash: r.artifact.aggregate_hash,
      })),
      report_hash: report.deterministic_hash,
    });
    return Object.freeze({
      monitor_version: REPLAY_DRIFT_MONITOR_VERSION,
      records,
      report,
      deterministic_hash: fnv1a32(canonical),
    });
  }

  // ════ Internals ═══════════════════════════════════════════════════════

  private emptyReport(
    baselineOrdinal: number | null,
    baselineLabel: string | null,
    divs: readonly DriftDivergence[],
  ): DriftReport {
    const canonical = canonicalSerialize({
      monitor_version: REPLAY_DRIFT_MONITOR_VERSION,
      record_count: this.records.length,
      baseline_ordinal: baselineOrdinal,
      baseline_label: baselineLabel,
      divergences: divs,
    });
    return Object.freeze({
      monitor_version: REPLAY_DRIFT_MONITOR_VERSION,
      record_count: this.records.length,
      baseline_ordinal: baselineOrdinal,
      baseline_label: baselineLabel,
      divergences: Object.freeze([] as DriftDivergence[]),
      ok: true,
      deterministic_hash: fnv1a32(canonical),
    });
  }

  private diffArtifact(
    base: ExportArtifact,
    cand: ExportArtifact,
    ordinal: number,
    label: string,
    out: DriftDivergence[],
  ): void {
    if (base.artifact_version !== cand.artifact_version) {
      out.push(makeDivergence('artifact_version_drift', ordinal, label, base.artifact_version, cand.artifact_version));
    }
    if (base.artifact_content_count !== cand.artifact_content_count) {
      out.push(makeDivergence('content_count_drift', ordinal, label, base.artifact_content_count, cand.artifact_content_count));
    }
    if (base.artifact_schema_fingerprint !== cand.artifact_schema_fingerprint) {
      out.push(makeDivergence('schema_fingerprint_drift', ordinal, label, base.artifact_schema_fingerprint, cand.artifact_schema_fingerprint));
    }
    if (base.aggregate_hash !== cand.aggregate_hash) {
      out.push(makeDivergence('aggregate_hash_drift', ordinal, label, base.aggregate_hash, cand.aggregate_hash));
    }
    if (base.registry_snapshot_hash !== cand.registry_snapshot_hash) {
      out.push(makeDivergence('registry_snapshot_drift', ordinal, label, base.registry_snapshot_hash, cand.registry_snapshot_hash));
    }
    if (canonicalSerialize(base.schema_names) !== canonicalSerialize(cand.schema_names)) {
      out.push(makeDivergence('schema_names_drift', ordinal, label, base.schema_names, cand.schema_names));
    }
    if (base.canonical_content_hash !== cand.canonical_content_hash) {
      out.push(makeDivergence('canonical_content_hash_drift', ordinal, label, base.canonical_content_hash, cand.canonical_content_hash));
    }
    if (base.canonical_byte_length !== cand.canonical_byte_length) {
      out.push(makeDivergence('canonical_byte_length_drift', ordinal, label, base.canonical_byte_length, cand.canonical_byte_length));
    }
    if (base.deterministic_hash !== cand.deterministic_hash) {
      out.push(makeDivergence('deterministic_hash_drift', ordinal, label, base.deterministic_hash, cand.deterministic_hash));
    }

    // per_file: count first, then per-index diff
    if (base.per_file.length !== cand.per_file.length) {
      out.push(makeDivergence('per_file_count_drift', ordinal, label, base.per_file.length, cand.per_file.length));
    } else {
      for (let i = 0; i < base.per_file.length; i++) {
        const b = base.per_file[i]!;
        const c = cand.per_file[i]!;
        if (!compareEntry(b, c)) {
          out.push(
            makeDivergence(
              'per_file_entry_drift',
              ordinal,
              label,
              { index: i, schema_name: b.schema_name, content_hash: b.content_hash, result_hash: b.result_hash },
              { index: i, schema_name: c.schema_name, content_hash: c.content_hash, result_hash: c.result_hash },
            ),
          );
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Stateless convenience — one-shot pair compare
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One-shot drift compare: baseline (ordinal 0) vs candidate (ordinal 1).
 * Pure functional alternative when caller doesn't need the monitor stateful
 * log. Same args → same DriftReport ALWAYS.
 */
export function compareReplayArtifacts(
  baseline: ExportArtifact,
  candidate: ExportArtifact,
  candidateLabel: string = 'candidate',
): DriftReport {
  const m = new ReplayDriftMonitor();
  m.recordReplay(0, 'baseline', baseline);
  m.recordReplay(1, candidateLabel, candidate);
  return m.detectDrift();
}
