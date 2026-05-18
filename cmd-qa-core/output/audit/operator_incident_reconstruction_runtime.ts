/**
 * OPERATOR INCIDENT RECONSTRUCTION RUNTIME — CMD4 Phase 19 Module 4.
 *
 * Production operator incident reconstruction backend. Read-only consumer
 * of archive + alert aggregation + monitor data; emits deterministic
 * incident graphs for operator triage.
 *
 * Brief v19 §M4 responsibilities:
 *   1. replay divergence diagnostics (composes Phase 14 drift monitor)
 *   2. deployment incident tracing (archive lineage)
 *   3. alert lineage reconstruction (Phase 19 M2 trace)
 *   4. distributed replay diagnostics (Phase 15 M2 composes)
 *   5. deterministic incident graphs (lex-canonical nodes + edges)
 *
 * STRICT RULE (brief v19 §M4):
 *   READ-ONLY ONLY.
 * FORBIDDEN:
 *   replay mutation
 *   authority override
 *   operational patch injection
 *   forensic replay rewriting
 *
 * Encapsulation: every upstream reference held via ES `#private` field.
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence.
 *
 * Ownership: tooling/forensic/liveops layer (brief v19 §III).
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';
import { ImmutableSnapshotArchive } from './immutable_snapshot_archive.js';
import {
  AlertAggregationRuntime,
  type AlertLineageReport,
  type AlertIncident,
} from './alert_aggregation_runtime.js';
import { RuntimeMonitorRegistry } from './runtime_monitor_projection_runtime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const OPERATOR_INCIDENT_RECONSTRUCTION_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface IncidentRelatedArchiveEntry {
  readonly label: string;
  readonly ordinal: number;
  readonly artifact_hash: string;
}

export interface IncidentRelatedMonitorSample {
  readonly source_id: string;
  readonly ordinal: number;
  readonly snapshot_hash: string;
}

export interface OperatorIncidentReport {
  readonly runtime_version: number;
  readonly incident_kind: string;
  readonly source_id: string;
  readonly alert_count: number;
  readonly first_ordinal: number;
  readonly last_ordinal: number;
  readonly alert_lineage_hash: string;
  /** Archive entries within [first_ordinal, last_ordinal] window. Lex-sorted by label. */
  readonly related_archive_entries: readonly IncidentRelatedArchiveEntry[];
  /** Monitor samples for `source_id` within the same window. Ordinal-ascending. */
  readonly related_monitor_samples: readonly IncidentRelatedMonitorSample[];
  readonly deterministic_hash: string;
}

export interface IncidentGraphNode {
  readonly kind: string;
  readonly source_id: string;
  readonly alert_count: number;
  readonly severity: number;
}

export interface IncidentGraphReport {
  readonly runtime_version: number;
  readonly graph_kind: 'operator_incident_graph';
  readonly node_count: number;
  /** Lex-sorted by (kind, source_id). */
  readonly nodes: readonly IncidentGraphNode[];
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

function intCompare(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// OperatorIncidentReconstructionRuntime — READ-ONLY reconstruction backend
// ═══════════════════════════════════════════════════════════════════════════

export class OperatorIncidentReconstructionRuntime {
  readonly #archive: ImmutableSnapshotArchive;
  readonly #alerts: AlertAggregationRuntime;
  readonly #monitor: RuntimeMonitorRegistry;

  constructor(
    archive: ImmutableSnapshotArchive,
    alerts: AlertAggregationRuntime,
    monitor: RuntimeMonitorRegistry,
  ) {
    this.#archive = archive;
    this.#alerts = alerts;
    this.#monitor = monitor;
  }

  /**
   * Reconstruct a single incident by (kind, source_id). The reconstruction
   * joins:
   *   - the alert lineage (Phase 19 M2)
   *   - archive entries whose ordinal falls within
   *     [first_alert_ordinal, last_alert_ordinal]
   *   - monitor samples for the SAME source_id within the same window
   *
   * If the (kind, source_id) incident has no alerts, returns a frozen
   * empty-incident report with deterministic hash.
   *
   * Pure — same upstream state + same args → same report bytes ALWAYS.
   */
  reconstructIncident(kind: string, sourceId: string): OperatorIncidentReport {
    const lineage: AlertLineageReport = this.#alerts.traceLineage(kind, sourceId);

    if (lineage.alert_count === 0) {
      const canonicalEmpty = canonicalSerialize({
        runtime_version: OPERATOR_INCIDENT_RECONSTRUCTION_VERSION,
        incident_kind: kind,
        source_id: sourceId,
        alert_count: 0,
        alert_lineage_hash: lineage.deterministic_hash,
        first_ordinal: 0,
        last_ordinal: 0,
        related_archive_entries: [],
        related_monitor_samples: [],
      });
      return Object.freeze({
        runtime_version: OPERATOR_INCIDENT_RECONSTRUCTION_VERSION,
        incident_kind: kind,
        source_id: sourceId,
        alert_count: 0,
        first_ordinal: 0,
        last_ordinal: 0,
        alert_lineage_hash: lineage.deterministic_hash,
        related_archive_entries: Object.freeze([] as IncidentRelatedArchiveEntry[]),
        related_monitor_samples: Object.freeze([] as IncidentRelatedMonitorSample[]),
        deterministic_hash: fnv1a32(canonicalEmpty),
      });
    }

    const first = lineage.alerts[0]!.ordinal;
    const last = lineage.alerts[lineage.alerts.length - 1]!.ordinal;

    // Archive entries within [first, last]
    const archiveMatches: IncidentRelatedArchiveEntry[] = [];
    for (const e of this.#archive.allEntries()) {
      if (intCompare(e.ordinal, first) >= 0 && intCompare(e.ordinal, last) <= 0) {
        archiveMatches.push({
          label: e.label,
          ordinal: e.ordinal,
          artifact_hash: e.artifact.deterministic_hash,
        });
      }
    }
    archiveMatches.sort((a, b) => lexCompare(a.label, b.label));
    const frozenArchive = Object.freeze(archiveMatches.map((e) => Object.freeze(e)));

    // Monitor samples for `sourceId` within [first, last]
    const monitorMatches: IncidentRelatedMonitorSample[] = [];
    for (const s of this.#monitor.allSnapshots()) {
      if (
        s.source_id === sourceId &&
        intCompare(s.timestamp_ordinal, first) >= 0 &&
        intCompare(s.timestamp_ordinal, last) <= 0
      ) {
        monitorMatches.push({
          source_id: s.source_id,
          ordinal: s.timestamp_ordinal,
          snapshot_hash: s.deterministic_hash,
        });
      }
    }
    monitorMatches.sort((a, b) => intCompare(a.ordinal, b.ordinal));
    const frozenMonitor = Object.freeze(monitorMatches.map((s) => Object.freeze(s)));

    const canonical = canonicalSerialize({
      runtime_version: OPERATOR_INCIDENT_RECONSTRUCTION_VERSION,
      incident_kind: kind,
      source_id: sourceId,
      alert_count: lineage.alert_count,
      alert_lineage_hash: lineage.deterministic_hash,
      first_ordinal: first,
      last_ordinal: last,
      related_archive_entries: frozenArchive.map((e) => [e.label, e.ordinal, e.artifact_hash]),
      related_monitor_samples: frozenMonitor.map((s) => [s.source_id, s.ordinal, s.snapshot_hash]),
    });

    return Object.freeze({
      runtime_version: OPERATOR_INCIDENT_RECONSTRUCTION_VERSION,
      incident_kind: kind,
      source_id: sourceId,
      alert_count: lineage.alert_count,
      first_ordinal: first,
      last_ordinal: last,
      alert_lineage_hash: lineage.deterministic_hash,
      related_archive_entries: frozenArchive,
      related_monitor_samples: frozenMonitor,
      deterministic_hash: fnv1a32(canonical),
    });
  }

  /**
   * Build a deterministic operator incident graph from the alert aggregator.
   * One node per (kind, source_id) incident; nodes lex-sorted by composite.
   *
   * Pure — same alert state → same graph bytes ALWAYS.
   */
  buildIncidentGraph(): IncidentGraphReport {
    const report = this.#alerts.aggregateReport();
    const nodes: IncidentGraphNode[] = report.incidents.map((i: AlertIncident) => ({
      kind: i.group_kind,
      source_id: i.source_id,
      alert_count: i.alert_count,
      severity: i.severity,
    }));
    nodes.sort((a, b) => {
      const k = lexCompare(a.kind, b.kind);
      if (k !== 0) return k;
      return lexCompare(a.source_id, b.source_id);
    });
    const frozenNodes = Object.freeze(nodes.map((n) => Object.freeze(n)));

    const canonical = canonicalSerialize({
      runtime_version: OPERATOR_INCIDENT_RECONSTRUCTION_VERSION,
      graph_kind: 'operator_incident_graph',
      node_count: frozenNodes.length,
      nodes: frozenNodes.map((n) => ({
        kind: n.kind,
        source_id: n.source_id,
        alert_count: n.alert_count,
        severity: n.severity,
      })),
    });

    return Object.freeze({
      runtime_version: OPERATOR_INCIDENT_RECONSTRUCTION_VERSION,
      graph_kind: 'operator_incident_graph' as const,
      node_count: frozenNodes.length,
      nodes: frozenNodes,
      deterministic_hash: fnv1a32(canonical),
    });
  }
}
