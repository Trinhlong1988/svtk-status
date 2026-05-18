/**
 * LIVE-OPS OBSERVABILITY RUNTIME — CMD4 Phase 17 Module 2.
 *
 * Deterministic operational observability projections on top of
 * `RuntimeMonitorRegistry` (Phase 16 M2). Produces dashboard-friendly
 * aggregations (latest-by-source, per-source metric stats) without ever
 * affecting replay / archive / forensic chains.
 *
 * Brief v17 §M2 responsibilities:
 *   1. deterministic operational projections
 *   2. replay-safe monitoring snapshots (passthrough — registry handles)
 *   3. canonical audit serialization (FNV-1a chained)
 *   4. replay-independent metric tracing
 *   5. stable observability hashing
 *
 * CRITICAL RULE (brief v17 §M2):
 *   monitoring metadata MUST NEVER affect:
 *     - replay hash / archive checksum
 *     - replay continuation / forensic reconstruction
 *     - validation parity
 *
 * Architectural isolation: this module is a *projection* layer — it
 * reads the monitor registry and emits frozen aggregates. None of its
 * outputs are fed into archive / replay / forensic hashes.
 *
 * READ-ONLY contract:
 *   No mutation API. Engine-private `#registry` closes runtime escape.
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence.
 *
 * Ownership: tooling/observability layer (brief v17 §III).
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';
import {
  RuntimeMonitorRegistry,
} from './runtime_monitor_projection_runtime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const LIVEOPS_OBSERVABILITY_RUNTIME_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface LatestBySourceEntry {
  readonly source_id: string;
  readonly timestamp_ordinal: number;
  readonly snapshot_hash: string;
}

export interface LatestBySourceProjection {
  readonly runtime_version: number;
  readonly projection_kind: 'latest_by_source';
  readonly source_count: number;
  /** Lex-sorted by source_id. */
  readonly entries: readonly LatestBySourceEntry[];
  readonly deterministic_hash: string;
}

export interface MetricAggregate {
  readonly source_id: string;
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly latest_value: number;
  readonly latest_ordinal: number;
}

export interface MetricAggregateProjection {
  readonly runtime_version: number;
  readonly projection_kind: 'metric_aggregate';
  readonly metric_name: string;
  /** Lex-sorted by source_id. Empty if metric absent in registry. */
  readonly per_source: readonly MetricAggregate[];
  readonly deterministic_hash: string;
}

export interface ObservabilityAuditReport {
  readonly runtime_version: number;
  readonly projection_kind: 'observability_audit';
  readonly source_count: number;
  readonly total_snapshots: number;
  readonly registry_view_hash: string;
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

// ═══════════════════════════════════════════════════════════════════════════
// LiveOpsObservabilityRuntime — READ-ONLY projection wrapper
// ═══════════════════════════════════════════════════════════════════════════

export class LiveOpsObservabilityRuntime {
  /** ES private field — engine-enforced READ-ONLY closure of registry. */
  readonly #registry: RuntimeMonitorRegistry;

  constructor(registry: RuntimeMonitorRegistry) {
    this.#registry = registry;
  }

  get registrySize(): number {
    return this.#registry.size;
  }

  // ════ Projection #1: latest by source ═════════════════════════════════

  /**
   * For each source: the snapshot with the largest timestamp_ordinal.
   * Lex-sorted by source_id. Pure — same registry state → same bytes.
   */
  projectLatestBySource(): LatestBySourceProjection {
    const latestMap = new Map<string, { timestamp_ordinal: number; snapshot_hash: string }>();
    for (const s of this.#registry.allSnapshots()) {
      const existing = latestMap.get(s.source_id);
      if (existing === undefined || intCompare(s.timestamp_ordinal, existing.timestamp_ordinal) > 0) {
        latestMap.set(s.source_id, {
          timestamp_ordinal: s.timestamp_ordinal,
          snapshot_hash: s.deterministic_hash,
        });
      }
    }
    const entries: LatestBySourceEntry[] = [];
    for (const [source_id, v] of latestMap) {
      entries.push({
        source_id,
        timestamp_ordinal: v.timestamp_ordinal,
        snapshot_hash: v.snapshot_hash,
      });
    }
    entries.sort((a, b) => lexCompare(a.source_id, b.source_id));
    const frozen = Object.freeze(entries.map((e) => Object.freeze(e)));

    const canonical = canonicalSerialize({
      runtime_version: LIVEOPS_OBSERVABILITY_RUNTIME_VERSION,
      projection_kind: 'latest_by_source',
      source_count: frozen.length,
      entries: frozen.map((e) => ({
        source_id: e.source_id,
        timestamp_ordinal: e.timestamp_ordinal,
        snapshot_hash: e.snapshot_hash,
      })),
    });

    return Object.freeze({
      runtime_version: LIVEOPS_OBSERVABILITY_RUNTIME_VERSION,
      projection_kind: 'latest_by_source' as const,
      source_count: frozen.length,
      entries: frozen,
      deterministic_hash: fnv1a32(canonical),
    });
  }

  // ════ Projection #2: metric aggregate ══════════════════════════════════

  /**
   * Per-source aggregation for a named metric: count, sum, min, max,
   * latest_value, latest_ordinal. INT-only — sum kept within safe integer.
   * Same registry + same metric_name → same projection bytes ALWAYS.
   *
   * If metric absent in a source's snapshots, that source is omitted from
   * per_source. If metric absent everywhere, per_source = [].
   */
  projectMetricAggregate(metricName: string): MetricAggregateProjection {
    if (typeof metricName !== 'string' || metricName.length === 0) {
      throw new Error('liveops_observability_runtime: metric_name must be non-empty string');
    }
    type AggAcc = {
      count: number;
      sum: number;
      min: number;
      max: number;
      latest_value: number;
      latest_ordinal: number;
    };
    const aggMap = new Map<string, AggAcc>();

    for (const s of this.#registry.allSnapshots()) {
      // Use Object.hasOwn (own-property check) instead of `in`. The metrics
      // record is a plain object literal {} that inherits Object.prototype,
      // so `in` would match names like 'toString' / 'constructor' /
      // '__proto__' / 'hasOwnProperty' and resolve `s.metrics[metricName]`
      // to the inherited function — then `acc.sum + v` becomes NaN and the
      // safe-integer guard throws a misleading "sum overflow" error.
      if (!Object.hasOwn(s.metrics, metricName)) continue;
      const v = s.metrics[metricName]!;
      let acc = aggMap.get(s.source_id);
      if (acc === undefined) {
        acc = {
          count: 1,
          sum: v,
          min: v,
          max: v,
          latest_value: v,
          latest_ordinal: s.timestamp_ordinal,
        };
        aggMap.set(s.source_id, acc);
        continue;
      }
      acc.count += 1;
      acc.sum += v;
      if (!Number.isSafeInteger(acc.sum)) {
        throw new Error(
          `liveops_observability_runtime: metric "${metricName}" sum overflow for source "${s.source_id}" — sum exceeds 2^53`,
        );
      }
      if (v < acc.min) acc.min = v;
      if (v > acc.max) acc.max = v;
      if (intCompare(s.timestamp_ordinal, acc.latest_ordinal) > 0) {
        acc.latest_value = v;
        acc.latest_ordinal = s.timestamp_ordinal;
      }
    }

    const perSource: MetricAggregate[] = [];
    for (const [source_id, acc] of aggMap) {
      perSource.push({
        source_id,
        count: acc.count,
        sum: acc.sum,
        min: acc.min,
        max: acc.max,
        latest_value: acc.latest_value,
        latest_ordinal: acc.latest_ordinal,
      });
    }
    perSource.sort((a, b) => lexCompare(a.source_id, b.source_id));
    const frozen = Object.freeze(perSource.map((a) => Object.freeze(a)));

    const canonical = canonicalSerialize({
      runtime_version: LIVEOPS_OBSERVABILITY_RUNTIME_VERSION,
      projection_kind: 'metric_aggregate',
      metric_name: metricName,
      per_source: frozen.map((a) => ({
        source_id: a.source_id,
        count: a.count,
        sum: a.sum,
        min: a.min,
        max: a.max,
        latest_value: a.latest_value,
        latest_ordinal: a.latest_ordinal,
      })),
    });

    return Object.freeze({
      runtime_version: LIVEOPS_OBSERVABILITY_RUNTIME_VERSION,
      projection_kind: 'metric_aggregate' as const,
      metric_name: metricName,
      per_source: frozen,
      deterministic_hash: fnv1a32(canonical),
    });
  }

  // ════ Projection #3: observability audit ═══════════════════════════════

  /** Composite audit: registry view hash + counts. */
  exportObservabilityAudit(): ObservabilityAuditReport {
    const view = this.#registry.exportRegistryView();
    // Unique sources count
    const sources = new Set<string>();
    for (const s of this.#registry.allSnapshots()) sources.add(s.source_id);

    const canonical = canonicalSerialize({
      runtime_version: LIVEOPS_OBSERVABILITY_RUNTIME_VERSION,
      projection_kind: 'observability_audit',
      source_count: sources.size,
      total_snapshots: this.#registry.size,
      registry_view_hash: view.deterministic_hash,
    });

    return Object.freeze({
      runtime_version: LIVEOPS_OBSERVABILITY_RUNTIME_VERSION,
      projection_kind: 'observability_audit' as const,
      source_count: sources.size,
      total_snapshots: this.#registry.size,
      registry_view_hash: view.deterministic_hash,
      deterministic_hash: fnv1a32(canonical),
    });
  }
}
