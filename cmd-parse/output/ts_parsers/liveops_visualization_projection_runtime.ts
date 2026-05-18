/**
 * LIVEOPS VISUALIZATION PROJECTION RUNTIME — CMD4 Phase 19 Module 1.
 *
 * Backend projection layer for operational visualization. Reads runtime
 * monitor data + (optional) archive metadata and emits canonical
 * visualization-friendly projection structs. Pure read-only — NEVER
 * touches replay / archive / forensic state.
 *
 * Brief v19 §M1 responsibilities:
 *   1. deterministic operational projections (lex-sorted, frozen)
 *   2. replay-safe visualization aggregation (no archive write)
 *   3. canonical visualization serialization (FNV-1a fingerprint)
 *   4. replay-independent rendering projections (read-only consumer)
 *   5. stable operational fingerprints
 *
 * ★ CRITICAL RULE (brief v19 §M1) ★
 *   visualization metadata MUST NEVER affect:
 *     - replay hash
 *     - archive checksum
 *     - deployment verification
 *     - forensic reconstruction
 *
 * Architectural isolation: this module is a strict PROJECTION layer —
 * it consumes registry data and emits frozen projections. No registry
 * mutation, no archive interaction, no replay-side-effect.
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence.
 *
 * Ownership: tooling/visualization layer (brief v19 §III).
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';
import {
  RuntimeMonitorRegistry,
  type RuntimeMonitorSnapshot,
} from './runtime_monitor_projection_runtime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const LIVEOPS_VISUALIZATION_PROJECTION_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface TimeSeriesPoint {
  readonly ordinal: number;
  readonly value: number;
}

export interface TimeSeriesProjection {
  readonly runtime_version: number;
  readonly projection_kind: 'time_series';
  readonly metric_name: string;
  /** Max points retained per source (after lex sort by source_id). */
  readonly max_points: number;
  /** Lex-sorted by source_id. */
  readonly per_source: readonly {
    readonly source_id: string;
    readonly point_count: number;
    /** Ordinal-ascending series, truncated to last `max_points` points. */
    readonly points: readonly TimeSeriesPoint[];
  }[];
  readonly deterministic_hash: string;
}

export interface SourceHeatmapEntry {
  readonly source_id: string;
  /** Lex-sorted by metric_name. */
  readonly metrics: readonly { readonly metric_name: string; readonly latest_value: number }[];
}

export interface SourceHeatmapProjection {
  readonly runtime_version: number;
  readonly projection_kind: 'source_heatmap';
  /** Lex-sorted by source_id. */
  readonly entries: readonly SourceHeatmapEntry[];
  readonly deterministic_hash: string;
}

export interface MetricSummaryProjection {
  readonly runtime_version: number;
  readonly projection_kind: 'metric_summary';
  /** Lex-sorted by metric_name. */
  readonly per_metric: readonly {
    readonly metric_name: string;
    readonly source_count: number;
    readonly total_samples: number;
    readonly aggregate_sum: number;
    readonly aggregate_min: number;
    readonly aggregate_max: number;
  }[];
  readonly deterministic_hash: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers — direct codepoint compare (NEVER localeCompare)
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
// LiveOpsVisualizationProjectionRuntime — READ-ONLY projection wrapper
// ═══════════════════════════════════════════════════════════════════════════

export class LiveOpsVisualizationProjectionRuntime {
  /** ES private field — engine-enforced READ-ONLY closure of registry. */
  readonly #registry: RuntimeMonitorRegistry;

  constructor(registry: RuntimeMonitorRegistry) {
    this.#registry = registry;
  }

  get registrySize(): number {
    return this.#registry.size;
  }

  // ════ Projection #1: per-source time series for one metric ════════════

  /**
   * Build a per-source time series for `metric_name`. Each source's points
   * are ordinal-ascending; the series is truncated to the most recent
   * `max_points` per source (caller-controlled retention budget).
   *
   * Pure — same registry + same args → same projection bytes ALWAYS.
   * Throws on caller bug: empty `metric_name`, non-positive `max_points`.
   */
  projectTimeSeries(metricName: string, maxPoints: number): TimeSeriesProjection {
    if (typeof metricName !== 'string' || metricName.length === 0) {
      throw new Error('liveops_visualization_projection_runtime: metric_name must be non-empty string');
    }
    if (!Number.isSafeInteger(maxPoints) || maxPoints <= 0) {
      throw new Error(
        `liveops_visualization_projection_runtime: max_points must be positive safe integer, got ${String(maxPoints)}`,
      );
    }

    // Group snapshots by source_id, collect points for the requested metric.
    const grouped = new Map<string, TimeSeriesPoint[]>();
    for (const s of this.#registry.allSnapshots()) {
      // Use Object.hasOwn — inherited prototype methods must not leak through.
      if (!Object.hasOwn(s.metrics, metricName)) continue;
      const v = s.metrics[metricName]!;
      let list = grouped.get(s.source_id);
      if (list === undefined) {
        list = [];
        grouped.set(s.source_id, list);
      }
      list.push({ ordinal: s.timestamp_ordinal, value: v });
    }

    const perSource: {
      source_id: string;
      point_count: number;
      points: readonly TimeSeriesPoint[];
    }[] = [];
    for (const [sourceId, pts] of grouped) {
      pts.sort((a, b) => intCompare(a.ordinal, b.ordinal));
      // Truncate to most recent maxPoints.
      const truncated = pts.length > maxPoints ? pts.slice(pts.length - maxPoints) : pts;
      perSource.push({
        source_id: sourceId,
        point_count: truncated.length,
        points: Object.freeze(truncated.map((p) => Object.freeze({ ordinal: p.ordinal, value: p.value }))),
      });
    }
    perSource.sort((a, b) => lexCompare(a.source_id, b.source_id));
    const frozen = Object.freeze(perSource.map((s) => Object.freeze(s)));

    const canonical = canonicalSerialize({
      runtime_version: LIVEOPS_VISUALIZATION_PROJECTION_VERSION,
      projection_kind: 'time_series',
      metric_name: metricName,
      max_points: maxPoints,
      per_source: frozen.map((s) => ({
        source_id: s.source_id,
        point_count: s.point_count,
        points: s.points.map((p) => [p.ordinal, p.value]),
      })),
    });

    return Object.freeze({
      runtime_version: LIVEOPS_VISUALIZATION_PROJECTION_VERSION,
      projection_kind: 'time_series' as const,
      metric_name: metricName,
      max_points: maxPoints,
      per_source: frozen,
      deterministic_hash: fnv1a32(canonical),
    });
  }

  // ════ Projection #2: per-source heatmap (source × metric → latest) ════

  /**
   * For each source, collect the latest value of every metric the source
   * has ever reported. Latest = the snapshot with the largest
   * `timestamp_ordinal` containing that metric.
   *
   * Pure — same registry state → same projection bytes ALWAYS.
   */
  projectSourceHeatmap(): SourceHeatmapProjection {
    // source → metric → { ordinal, value } (latest seen)
    const grid = new Map<string, Map<string, { ordinal: number; value: number }>>();
    for (const s of this.#registry.allSnapshots()) {
      let row = grid.get(s.source_id);
      if (row === undefined) {
        row = new Map();
        grid.set(s.source_id, row);
      }
      for (const metricName of Object.keys(s.metrics)) {
        const v = s.metrics[metricName]!;
        const prev = row.get(metricName);
        if (prev === undefined || intCompare(s.timestamp_ordinal, prev.ordinal) > 0) {
          row.set(metricName, { ordinal: s.timestamp_ordinal, value: v });
        }
      }
    }

    const entries: SourceHeatmapEntry[] = [];
    for (const [sourceId, row] of grid) {
      const metrics: { metric_name: string; latest_value: number }[] = [];
      for (const [metricName, { value }] of row) {
        metrics.push({ metric_name: metricName, latest_value: value });
      }
      metrics.sort((a, b) => lexCompare(a.metric_name, b.metric_name));
      entries.push({
        source_id: sourceId,
        metrics: Object.freeze(metrics.map((m) => Object.freeze(m))),
      });
    }
    entries.sort((a, b) => lexCompare(a.source_id, b.source_id));
    const frozen = Object.freeze(entries.map((e) => Object.freeze(e)));

    const canonical = canonicalSerialize({
      runtime_version: LIVEOPS_VISUALIZATION_PROJECTION_VERSION,
      projection_kind: 'source_heatmap',
      entries: frozen.map((e) => ({
        source_id: e.source_id,
        metrics: e.metrics.map((m) => [m.metric_name, m.latest_value]),
      })),
    });

    return Object.freeze({
      runtime_version: LIVEOPS_VISUALIZATION_PROJECTION_VERSION,
      projection_kind: 'source_heatmap' as const,
      entries: frozen,
      deterministic_hash: fnv1a32(canonical),
    });
  }

  // ════ Projection #3: multi-metric aggregate summary ═══════════════════

  /**
   * Aggregate summary across multiple metrics. For each named metric:
   *   - source_count: distinct sources that ever reported the metric
   *   - total_samples: total snapshots containing the metric
   *   - aggregate_sum / aggregate_min / aggregate_max across ALL samples
   *
   * Throws on caller bug: empty metric list or empty metric name.
   */
  projectMetricSummary(metricNames: readonly string[]): MetricSummaryProjection {
    if (!Array.isArray(metricNames) || metricNames.length === 0) {
      throw new Error(
        'liveops_visualization_projection_runtime: metric_names must be non-empty string array',
      );
    }
    // Reject duplicates — silent dedupe would mask a caller bug, and accepting
    // duplicates would double-count per-snapshot aggregation (inner loop hits
    // the same aggMap entry twice → sum/total_samples skew by the dup factor).
    const seenNames = new Set<string>();
    for (const m of metricNames) {
      if (typeof m !== 'string' || m.length === 0) {
        throw new Error(
          'liveops_visualization_projection_runtime: every metric_name must be non-empty string',
        );
      }
      if (seenNames.has(m)) {
        throw new Error(
          `liveops_visualization_projection_runtime: duplicate metric_name "${m}" in input list`,
        );
      }
      seenNames.add(m);
    }

    interface MetricAgg {
      readonly sourceSet: Set<string>;
      total_samples: number;
      sum: number;
      min: number;
      max: number;
      seen: boolean;
    }
    const aggMap = new Map<string, MetricAgg>();
    for (const name of metricNames) {
      aggMap.set(name, {
        sourceSet: new Set<string>(),
        total_samples: 0,
        sum: 0,
        min: Number.MAX_SAFE_INTEGER,
        max: Number.MIN_SAFE_INTEGER,
        seen: false,
      });
    }

    for (const s of this.#registry.allSnapshots()) {
      for (const name of metricNames) {
        if (!Object.hasOwn(s.metrics, name)) continue;
        const v = s.metrics[name]!;
        const agg = aggMap.get(name)!;
        agg.sourceSet.add(s.source_id);
        agg.total_samples += 1;
        agg.sum += v;
        if (!Number.isSafeInteger(agg.sum)) {
          throw new Error(
            `liveops_visualization_projection_runtime: metric "${name}" sum overflow — exceeds 2^53`,
          );
        }
        if (v < agg.min) agg.min = v;
        if (v > agg.max) agg.max = v;
        agg.seen = true;
      }
    }

    const perMetric: {
      metric_name: string;
      source_count: number;
      total_samples: number;
      aggregate_sum: number;
      aggregate_min: number;
      aggregate_max: number;
    }[] = [];
    for (const name of metricNames) {
      const agg = aggMap.get(name)!;
      perMetric.push({
        metric_name: name,
        source_count: agg.sourceSet.size,
        total_samples: agg.total_samples,
        aggregate_sum: agg.sum,
        aggregate_min: agg.seen ? agg.min : 0,
        aggregate_max: agg.seen ? agg.max : 0,
      });
    }
    perMetric.sort((a, b) => lexCompare(a.metric_name, b.metric_name));
    const frozen = Object.freeze(perMetric.map((m) => Object.freeze(m)));

    const canonical = canonicalSerialize({
      runtime_version: LIVEOPS_VISUALIZATION_PROJECTION_VERSION,
      projection_kind: 'metric_summary',
      per_metric: frozen.map((m) => ({
        metric_name: m.metric_name,
        source_count: m.source_count,
        total_samples: m.total_samples,
        aggregate_sum: m.aggregate_sum,
        aggregate_min: m.aggregate_min,
        aggregate_max: m.aggregate_max,
      })),
    });

    return Object.freeze({
      runtime_version: LIVEOPS_VISUALIZATION_PROJECTION_VERSION,
      projection_kind: 'metric_summary' as const,
      per_metric: frozen,
      deterministic_hash: fnv1a32(canonical),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper export for downstream consumers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pure function helper: extract the lex-sorted distinct metric names that
 * appear across all snapshots in a `RuntimeMonitorRegistry`. Useful when
 * the caller doesn't know the available metric set up-front.
 *
 * Pure — same registry → same result ALWAYS.
 */
export function listKnownMetrics(registry: RuntimeMonitorRegistry): readonly string[] {
  const seen = new Set<string>();
  for (const s of registry.allSnapshots()) {
    for (const k of Object.keys(s.metrics)) seen.add(k);
  }
  return Object.freeze([...seen].sort(lexCompare));
}

// Re-export snapshot type for downstream typing convenience.
export type { RuntimeMonitorSnapshot };
