/**
 * LIVE VISUALIZATION EXPORT RUNTIME — CMD4 Phase 22 Module 2.
 *
 * Wraps Phase 19 M1 visualization projections in a canonical wire-export
 * envelope for downstream dashboard/UI consumption. Pure read-only —
 * NEVER touches replay / archive / forensic state.
 *
 * Brief v22 §M2 responsibilities:
 *   1. deterministic operational exports
 *   2. replay-safe visualization projections (passthrough envelope)
 *   3. canonical visualization serialization (JSON wire format)
 *   4. replay-independent rendering snapshots
 *   5. stable export fingerprints
 *
 * ★ CRITICAL RULE (brief v22 §M2) ★
 *   visualization/export metadata MUST NEVER affect:
 *     - replay hash / archive checksum
 *     - deployment verification
 *     - forensic reconstruction
 *
 * Architectural isolation: this module is a PROJECTION ENVELOPE — it
 * wraps existing projection payloads in a versioned wire structure and
 * computes a stable export fingerprint. No mutation of upstream state.
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence.
 *
 * Ownership: tooling/visualization layer (brief v22 §III).
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';
import {
  LiveOpsVisualizationProjectionRuntime,
  type TimeSeriesProjection,
  type SourceHeatmapProjection,
  type MetricSummaryProjection,
} from './liveops_visualization_projection_runtime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const LIVE_VISUALIZATION_EXPORT_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export type VisualizationProjection =
  | TimeSeriesProjection
  | SourceHeatmapProjection
  | MetricSummaryProjection;

export interface VisualizationExportEnvelope {
  readonly export_version: number;
  readonly export_kind: 'visualization_bundle';
  readonly projection_count: number;
  /** Lex-sorted by (projection_kind, primary_key). */
  readonly projections: readonly {
    readonly projection_kind: string;
    readonly primary_key: string;
    readonly inner_hash: string;
  }[];
  /** FNV-1a over canonical(export_version, projection_count, projections). */
  readonly export_fingerprint: string;
}

export interface VisualizationExportJson {
  readonly export_version: number;
  readonly export_fingerprint: string;
  /** Canonical JSON wire bytes (suitable for HTTP body / file write). */
  readonly canonical_json: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function lexCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function primaryKeyOf(p: VisualizationProjection): string {
  if (p.projection_kind === 'time_series') return p.metric_name;
  if (p.projection_kind === 'source_heatmap') return '_heatmap_';
  if (p.projection_kind === 'metric_summary') {
    // Composite: JSON-encoded sorted metric-name array — collision-safe.
    // Bug #23 fix: previously used join('|'), which collided when a metric_name
    // contained '|' (e.g. ['a|b'] vs ['a','b'] both encoded to 'a|b').
    return JSON.stringify([...p.per_metric.map((m) => m.metric_name)].sort());
  }
  return '_unknown_';
}

// ═══════════════════════════════════════════════════════════════════════════
// LiveVisualizationExportRuntime — wrapper around Phase 19 M1 projections
// ═══════════════════════════════════════════════════════════════════════════

export class LiveVisualizationExportRuntime {
  readonly #viz: LiveOpsVisualizationProjectionRuntime;

  constructor(viz: LiveOpsVisualizationProjectionRuntime) {
    this.#viz = viz;
  }

  get vizRegistrySize(): number {
    return this.#viz.registrySize;
  }

  /**
   * Build an export envelope bundling multiple projections. The envelope
   * fingerprint depends ONLY on the inner projection hashes — so two
   * envelopes with the same projection set produce the same fingerprint
   * regardless of caller-provided projection order.
   *
   * Pure — same projection set → same envelope bytes ALWAYS.
   */
  exportBundle(projections: readonly VisualizationProjection[]): VisualizationExportEnvelope {
    if (!Array.isArray(projections) || projections.length === 0) {
      throw new Error(
        'live_visualization_export_runtime: projections must be non-empty array',
      );
    }
    // Reject duplicate (projection_kind, primary_key) — caller bug.
    const seen = new Set<string>();
    const rows: { projection_kind: string; primary_key: string; inner_hash: string }[] = [];
    for (const p of projections) {
      const key = JSON.stringify([p.projection_kind, primaryKeyOf(p)]);
      if (seen.has(key)) {
        throw new Error(
          `live_visualization_export_runtime: duplicate projection (kind="${p.projection_kind}", primary_key="${primaryKeyOf(p)}")`,
        );
      }
      seen.add(key);
      rows.push({
        projection_kind: p.projection_kind,
        primary_key: primaryKeyOf(p),
        inner_hash: p.deterministic_hash,
      });
    }
    rows.sort((a, b) => {
      const k = lexCompare(a.projection_kind, b.projection_kind);
      if (k !== 0) return k;
      return lexCompare(a.primary_key, b.primary_key);
    });
    const frozenRows = Object.freeze(rows.map((r) => Object.freeze(r)));

    const canonical = canonicalSerialize({
      export_version: LIVE_VISUALIZATION_EXPORT_VERSION,
      export_kind: 'visualization_bundle',
      projection_count: frozenRows.length,
      projections: frozenRows.map((r) => ({
        projection_kind: r.projection_kind,
        primary_key: r.primary_key,
        inner_hash: r.inner_hash,
      })),
    });

    return Object.freeze({
      export_version: LIVE_VISUALIZATION_EXPORT_VERSION,
      export_kind: 'visualization_bundle' as const,
      projection_count: frozenRows.length,
      projections: frozenRows,
      export_fingerprint: fnv1a32(canonical),
    });
  }

  /**
   * Serialize a projection envelope to canonical JSON. Suitable for wire
   * export to dashboards / file persistence.
   *
   * The `canonical_json` field is byte-stable: same envelope → same bytes.
   */
  exportEnvelopeAsJson(envelope: VisualizationExportEnvelope): VisualizationExportJson {
    const json = canonicalSerialize({
      export_version: envelope.export_version,
      export_kind: envelope.export_kind,
      projection_count: envelope.projection_count,
      projections: envelope.projections.map((p) => ({
        projection_kind: p.projection_kind,
        primary_key: p.primary_key,
        inner_hash: p.inner_hash,
      })),
      export_fingerprint: envelope.export_fingerprint,
    });
    return Object.freeze({
      export_version: envelope.export_version,
      export_fingerprint: envelope.export_fingerprint,
      canonical_json: json,
    });
  }
}
