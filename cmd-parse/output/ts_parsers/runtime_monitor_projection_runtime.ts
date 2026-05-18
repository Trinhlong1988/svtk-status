/**
 * RUNTIME MONITOR PROJECTION RUNTIME — CMD4 Phase 16 Module 2.
 *
 * Production runtime monitoring snapshot infrastructure. Produces
 * deterministic monitor projections from runtime metrics: same metric
 * input → same monitor snapshot bytes ALWAYS.
 *
 * Brief v16 §M2 responsibilities:
 *   1. deterministic runtime projections
 *   2. replay-safe monitoring snapshots (immutable, frozen, canonical)
 *   3. canonical metric serialization (lex-sorted keys, INT values)
 *   4. stable runtime verification exports
 *   5. replay-independent monitoring traces
 *
 * CRITICAL RULE (brief v16 §M2):
 *   monitoring metadata MUST NEVER affect:
 *     - replay hash
 *     - archive checksum
 *     - replay continuation
 *     - forensic reconstruction
 *
 * Architectural guarantee: this module is a parallel pipeline. Its
 * snapshots are produced from runtime metrics and never re-fed into
 * `ExportArtifact` / archive / replay chains.
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence.
 *
 * Ownership: tooling/validator layer (brief v16 §III).
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const RUNTIME_MONITOR_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface RuntimeMonitorSnapshot {
  readonly monitor_version: number;
  readonly source_id: string;
  /** Caller-managed monotonic logical clock (per source). */
  readonly timestamp_ordinal: number;
  /** INT-only metric values, frozen + lex-sorted keys. */
  readonly metrics: Readonly<Record<string, number>>;
  /** FNV-1a over canonical(version, source_id, ordinal, metrics). */
  readonly deterministic_hash: string;
}

export interface RegistryViewEntry {
  readonly source_id: string;
  readonly timestamp_ordinal: number;
  readonly snapshot_hash: string;
}

export interface RuntimeMonitorRegistryView {
  readonly monitor_version: number;
  readonly snapshot_count: number;
  /** Lex-sorted by (source_id asc, timestamp_ordinal asc). */
  readonly entries: readonly RegistryViewEntry[];
  readonly deterministic_hash: string;
}

export interface MonitorVerifyResult {
  readonly ok: boolean;
  readonly version_match: boolean;
  readonly metrics_int_only: boolean;
  readonly deterministic_hash_match: boolean;
  readonly first_bad_metric: string | null;
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

function freezeMetrics(metrics: Record<string, number>): Readonly<Record<string, number>> {
  const copy: Record<string, number> = {};
  // Sort keys lex for canonical iteration order (caller-visible).
  for (const k of Object.keys(metrics).sort(lexCompare)) {
    const v = metrics[k]!;
    if (typeof v !== 'number') {
      throw new Error(
        `runtime_monitor_projection_runtime: metric "${k}" must be number, got ${typeof v}`,
      );
    }
    if (!Number.isSafeInteger(v)) {
      throw new Error(
        `runtime_monitor_projection_runtime: metric "${k}" must be safe integer (no float / NaN / Infinity), got ${String(v)}`,
      );
    }
    copy[k] = v;
  }
  return Object.freeze(copy);
}

function computeSnapshotHash(
  sourceId: string,
  ordinal: number,
  metrics: Readonly<Record<string, number>>,
): string {
  return fnv1a32(
    canonicalSerialize({
      monitor_version: RUNTIME_MONITOR_VERSION,
      source_id: sourceId,
      timestamp_ordinal: ordinal,
      metrics,
    }),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — createRuntimeMonitorSnapshot
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a frozen `RuntimeMonitorSnapshot`. Pure — same inputs → same
 * bytes ALWAYS. Caller-bug guards:
 *   - source_id: non-empty string
 *   - timestamp_ordinal: safe integer (rejects float / NaN / Infinity / >2^53)
 *   - metrics: every value must be safe integer
 */
export function createRuntimeMonitorSnapshot(
  sourceId: string,
  metrics: Record<string, number>,
  timestampOrdinal: number,
): RuntimeMonitorSnapshot {
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    throw new Error('runtime_monitor_projection_runtime: source_id must be non-empty string');
  }
  if (!Number.isSafeInteger(timestampOrdinal)) {
    throw new Error(
      `runtime_monitor_projection_runtime: timestamp_ordinal must be safe integer, got ${String(timestampOrdinal)}`,
    );
  }
  const frozenMetrics = freezeMetrics(metrics);
  return Object.freeze({
    monitor_version: RUNTIME_MONITOR_VERSION,
    source_id: sourceId,
    timestamp_ordinal: timestampOrdinal,
    metrics: frozenMetrics,
    deterministic_hash: computeSnapshotHash(sourceId, timestampOrdinal, frozenMetrics),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — verifyMonitorSnapshot
// ═══════════════════════════════════════════════════════════════════════════

export function verifyMonitorSnapshot(snap: RuntimeMonitorSnapshot): MonitorVerifyResult {
  const versionMatch = snap.monitor_version === RUNTIME_MONITOR_VERSION;

  // Bug #26 fix: verify is the trust boundary for snapshots that didn't pass
  // through `createRuntimeMonitorSnapshot` (e.g. deserialized externally).
  // Without this check a hand-crafted NaN/Infinity/2^53 ordinal could match
  // a fabricated deterministic_hash (canonicalSerialize maps NaN→null) and
  // pass ok=true. Re-enforce factory-grade input strictness here.
  const ordinalSafeInt = Number.isSafeInteger(snap.timestamp_ordinal);

  let metricsIntOnly = true;
  let firstBad: string | null = null;
  for (const [k, v] of Object.entries(snap.metrics)) {
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
      metricsIntOnly = false;
      firstBad = k;
      break;
    }
  }

  const recomputed = computeSnapshotHash(
    snap.source_id,
    snap.timestamp_ordinal,
    snap.metrics,
  );
  const hashMatch = recomputed === snap.deterministic_hash;

  return Object.freeze({
    ok: versionMatch && ordinalSafeInt && metricsIntOnly && hashMatch,
    version_match: versionMatch,
    metrics_int_only: metricsIntOnly,
    deterministic_hash_match: hashMatch,
    first_bad_metric: firstBad,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// RuntimeMonitorRegistry — append-only registry of snapshots
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Append-only registry of runtime monitor snapshots. Per-source monotonic
 * ordinal enforced — same source MUST not reuse / regress its ordinal.
 *
 * Multiple sources are independent: snapshot ordinals from different
 * sources can interleave freely.
 */
export class RuntimeMonitorRegistry {
  private readonly snapshots: RuntimeMonitorSnapshot[] = [];
  private readonly lastOrdinalBySource = new Map<string, number>();

  append(snapshot: RuntimeMonitorSnapshot): void {
    if (snapshot.monitor_version !== RUNTIME_MONITOR_VERSION) {
      throw new Error(
        `runtime_monitor_projection_runtime: snapshot monitor_version mismatch (expected ${String(RUNTIME_MONITOR_VERSION)}, got ${String(snapshot.monitor_version)})`,
      );
    }
    const last = this.lastOrdinalBySource.get(snapshot.source_id);
    if (last !== undefined && intCompare(snapshot.timestamp_ordinal, last) <= 0) {
      throw new Error(
        `runtime_monitor_projection_runtime: timestamp_ordinal must be strictly monotonic per source "${snapshot.source_id}" (last=${String(last)}, got=${String(snapshot.timestamp_ordinal)})`,
      );
    }
    this.snapshots.push(snapshot);
    this.lastOrdinalBySource.set(snapshot.source_id, snapshot.timestamp_ordinal);
  }

  get size(): number {
    return this.snapshots.length;
  }

  /** O(1) frozen view of all snapshots in insertion order. */
  allSnapshots(): readonly RuntimeMonitorSnapshot[] {
    return Object.freeze([...this.snapshots]);
  }

  /** O(N) per-source filter, lex-sorted by timestamp_ordinal. */
  bySource(sourceId: string): readonly RuntimeMonitorSnapshot[] {
    const filtered = this.snapshots.filter((s) => s.source_id === sourceId);
    filtered.sort((a, b) => intCompare(a.timestamp_ordinal, b.timestamp_ordinal));
    return Object.freeze(filtered);
  }

  /**
   * Frozen registry view. Entries lex-sorted by (source_id, timestamp_ordinal)
   * for canonical determinism — independent of insertion order.
   */
  exportRegistryView(): RuntimeMonitorRegistryView {
    const entries: RegistryViewEntry[] = this.snapshots.map((s) => ({
      source_id: s.source_id,
      timestamp_ordinal: s.timestamp_ordinal,
      snapshot_hash: s.deterministic_hash,
    }));
    entries.sort((a, b) => {
      const sc = lexCompare(a.source_id, b.source_id);
      if (sc !== 0) return sc;
      return intCompare(a.timestamp_ordinal, b.timestamp_ordinal);
    });
    const frozenEntries = Object.freeze(entries.map((e) => Object.freeze(e)));
    const canonical = canonicalSerialize({
      monitor_version: RUNTIME_MONITOR_VERSION,
      snapshot_count: this.snapshots.length,
      entries: frozenEntries.map((e) => ({
        source_id: e.source_id,
        timestamp_ordinal: e.timestamp_ordinal,
        snapshot_hash: e.snapshot_hash,
      })),
    });
    return Object.freeze({
      monitor_version: RUNTIME_MONITOR_VERSION,
      snapshot_count: this.snapshots.length,
      entries: frozenEntries,
      deterministic_hash: fnv1a32(canonical),
    });
  }
}
