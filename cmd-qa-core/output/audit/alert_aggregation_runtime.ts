/**
 * ALERT AGGREGATION RUNTIME — CMD4 Phase 19 Module 2.
 *
 * Deterministic live MMO alert orchestration. Callers record alerts via a
 * monotonic-ordinal log; the aggregator groups related alerts into
 * incidents (same kind + same source) and emits canonical reports.
 *
 * Brief v19 §M2 responsibilities:
 *   1. replay-safe alert aggregation (append-only ordinal log)
 *   2. deterministic incident grouping (kind + source_id composite key)
 *   3. canonical alert hashing (FNV-1a chained)
 *   4. replay-independent alert projections (read-only)
 *   5. stable operational alert chains
 *
 * ★ CRITICAL RULE (brief v19 §M2) ★
 *   alert metadata MUST NEVER affect:
 *     - replay hash / archive checksum
 *     - deployment verification
 *     - forensic reconstruction
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence beyond append-only log
 * (caller-controlled monotonic ordinal sequence).
 *
 * Ownership: tooling/liveops layer (brief v19 §III).
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const ALERT_AGGREGATION_RUNTIME_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

/** Fixed severity ordinal — lower = more severe. Matches Commit #1 convention. */
export const ALERT_SEVERITY = Object.freeze({
  ERROR: 0,
  WARNING: 1,
  INFO: 2,
} as const);

export type AlertSeverity = (typeof ALERT_SEVERITY)[keyof typeof ALERT_SEVERITY];

export interface Alert {
  /** Logical clock ordinal (NOT wall time). Per-runtime monotonic. */
  readonly ordinal: number;
  readonly source_id: string;
  readonly severity: AlertSeverity;
  /** Stable category string. Used as composite key with source_id for incident grouping. */
  readonly kind: string;
  readonly message: string;
}

export interface AlertIncident {
  /** Composite identity for the incident: kind + source_id. */
  readonly group_kind: string;
  readonly source_id: string;
  readonly severity: AlertSeverity;
  readonly alert_count: number;
  readonly first_ordinal: number;
  readonly last_ordinal: number;
  /** FNV-1a fingerprint of (group_kind, source_id, first_ordinal, last_ordinal, alert_count). */
  readonly incident_hash: string;
}

export interface AlertAggregateReport {
  readonly runtime_version: number;
  readonly alert_count: number;
  /** Lex-sorted by (group_kind, source_id). */
  readonly incidents: readonly AlertIncident[];
  readonly severity_rollup: {
    readonly error: number;
    readonly warning: number;
    readonly info: number;
  };
  readonly deterministic_hash: string;
}

export interface AlertLineageEntry {
  readonly ordinal: number;
  readonly severity: AlertSeverity;
  readonly message: string;
}

export interface AlertLineageReport {
  readonly runtime_version: number;
  readonly group_kind: string;
  readonly source_id: string;
  readonly alert_count: number;
  /** Ordinal-ascending — full alert trail for the incident. */
  readonly alerts: readonly AlertLineageEntry[];
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

function compositeKey(kind: string, sourceId: string): string {
  // JSON.stringify tuple — collision-safe across separator-injection attacks
  // (caller cannot smuggle a separator into kind to alias source_id and vice versa).
  return JSON.stringify([kind, sourceId]);
}

// ═══════════════════════════════════════════════════════════════════════════
// AlertAggregationRuntime — append-only alert log with deterministic grouping
// ═══════════════════════════════════════════════════════════════════════════

export class AlertAggregationRuntime {
  private readonly alerts: Alert[] = [];
  private lastOrdinal: number | null = null;
  /** Composite (kind + source_id) → ordered alert list. */
  private readonly groups = new Map<string, Alert[]>();

  /**
   * Append a new alert. Ordinal MUST be strictly monotonic across all alerts
   * (caller-managed logical clock). Throws on caller bug.
   */
  recordAlert(alert: Alert): void {
    if (!Number.isSafeInteger(alert.ordinal)) {
      throw new Error(
        `alert_aggregation_runtime: ordinal must be safe integer, got ${String(alert.ordinal)}`,
      );
    }
    if (this.lastOrdinal !== null && alert.ordinal <= this.lastOrdinal) {
      throw new Error(
        `alert_aggregation_runtime: ordinal must be strictly monotonic (last=${String(this.lastOrdinal)}, got=${String(alert.ordinal)})`,
      );
    }
    if (typeof alert.source_id !== 'string' || alert.source_id.length === 0) {
      throw new Error('alert_aggregation_runtime: source_id must be non-empty string');
    }
    if (typeof alert.kind !== 'string' || alert.kind.length === 0) {
      throw new Error('alert_aggregation_runtime: kind must be non-empty string');
    }
    if (typeof alert.message !== 'string') {
      throw new Error('alert_aggregation_runtime: message must be string');
    }
    if (
      alert.severity !== ALERT_SEVERITY.ERROR &&
      alert.severity !== ALERT_SEVERITY.WARNING &&
      alert.severity !== ALERT_SEVERITY.INFO
    ) {
      throw new Error(
        `alert_aggregation_runtime: severity must be one of ALERT_SEVERITY enum, got ${String(alert.severity)}`,
      );
    }

    const frozen: Alert = Object.freeze({
      ordinal: alert.ordinal,
      source_id: alert.source_id,
      severity: alert.severity,
      kind: alert.kind,
      message: alert.message,
    });
    this.alerts.push(frozen);
    this.lastOrdinal = alert.ordinal;
    const key = compositeKey(alert.kind, alert.source_id);
    let bucket = this.groups.get(key);
    if (bucket === undefined) {
      bucket = [];
      this.groups.set(key, bucket);
    }
    bucket.push(frozen);
  }

  get size(): number {
    return this.alerts.length;
  }

  /** O(1) frozen view of all alerts in insertion (ordinal) order. */
  allAlerts(): readonly Alert[] {
    return Object.freeze([...this.alerts]);
  }

  /**
   * Aggregate the full alert log into incidents grouped by (kind, source_id).
   * Incidents are lex-sorted by (group_kind, source_id). Per-incident
   * severity = the MOST SEVERE (lowest enum value) alert in the group.
   *
   * Pure — same alert log → same report bytes ALWAYS.
   */
  aggregateReport(): AlertAggregateReport {
    const incidents: AlertIncident[] = [];
    let errCount = 0;
    let warnCount = 0;
    let infoCount = 0;

    for (const [_compKey, bucket] of this.groups) {
      // Bucket is in insertion order = ordinal-ascending (per recordAlert contract).
      // Defensive: sort by ordinal anyway to insulate against future mutation.
      const sorted = [...bucket].sort((a, b) => intCompare(a.ordinal, b.ordinal));
      const first = sorted[0]!;
      const last = sorted[sorted.length - 1]!;
      // Most severe = lowest enum value.
      let worst: AlertSeverity = ALERT_SEVERITY.INFO;
      for (const a of sorted) {
        if (a.severity < worst) worst = a.severity;
      }
      const incidentCanonical = canonicalSerialize({
        group_kind: first.kind,
        source_id: first.source_id,
        first_ordinal: first.ordinal,
        last_ordinal: last.ordinal,
        alert_count: sorted.length,
      });
      incidents.push({
        group_kind: first.kind,
        source_id: first.source_id,
        severity: worst,
        alert_count: sorted.length,
        first_ordinal: first.ordinal,
        last_ordinal: last.ordinal,
        incident_hash: fnv1a32(incidentCanonical),
      });
    }
    incidents.sort((a, b) => {
      const k = lexCompare(a.group_kind, b.group_kind);
      if (k !== 0) return k;
      return lexCompare(a.source_id, b.source_id);
    });
    const frozenIncidents = Object.freeze(incidents.map((i) => Object.freeze(i)));

    for (const a of this.alerts) {
      if (a.severity === ALERT_SEVERITY.ERROR) errCount++;
      else if (a.severity === ALERT_SEVERITY.WARNING) warnCount++;
      else if (a.severity === ALERT_SEVERITY.INFO) infoCount++;
    }

    const canonical = canonicalSerialize({
      runtime_version: ALERT_AGGREGATION_RUNTIME_VERSION,
      alert_count: this.alerts.length,
      incidents: frozenIncidents.map((i) => ({
        group_kind: i.group_kind,
        source_id: i.source_id,
        severity: i.severity,
        alert_count: i.alert_count,
        first_ordinal: i.first_ordinal,
        last_ordinal: i.last_ordinal,
        incident_hash: i.incident_hash,
      })),
      severity_rollup: { error: errCount, warning: warnCount, info: infoCount },
    });

    return Object.freeze({
      runtime_version: ALERT_AGGREGATION_RUNTIME_VERSION,
      alert_count: this.alerts.length,
      incidents: frozenIncidents,
      severity_rollup: Object.freeze({ error: errCount, warning: warnCount, info: infoCount }),
      deterministic_hash: fnv1a32(canonical),
    });
  }

  /**
   * Full alert lineage for a single (kind, source_id) incident. Returns the
   * ordinal-ascending alert trail. If the incident has no alerts, returns
   * a frozen empty-trail report with deterministic hash.
   */
  traceLineage(kind: string, sourceId: string): AlertLineageReport {
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new Error('alert_aggregation_runtime: kind must be non-empty string');
    }
    if (typeof sourceId !== 'string' || sourceId.length === 0) {
      throw new Error('alert_aggregation_runtime: source_id must be non-empty string');
    }
    const bucket = this.groups.get(compositeKey(kind, sourceId)) ?? [];
    const sorted = [...bucket].sort((a, b) => intCompare(a.ordinal, b.ordinal));
    const entries: AlertLineageEntry[] = sorted.map((a) => ({
      ordinal: a.ordinal,
      severity: a.severity,
      message: a.message,
    }));
    const frozenEntries = Object.freeze(entries.map((e) => Object.freeze(e)));

    const canonical = canonicalSerialize({
      runtime_version: ALERT_AGGREGATION_RUNTIME_VERSION,
      group_kind: kind,
      source_id: sourceId,
      alert_count: frozenEntries.length,
      alerts: frozenEntries.map((e) => [e.ordinal, e.severity, e.message]),
    });

    return Object.freeze({
      runtime_version: ALERT_AGGREGATION_RUNTIME_VERSION,
      group_kind: kind,
      source_id: sourceId,
      alert_count: frozenEntries.length,
      alerts: frozenEntries,
      deterministic_hash: fnv1a32(canonical),
    });
  }
}
