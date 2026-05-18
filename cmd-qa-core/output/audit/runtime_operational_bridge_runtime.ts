/**
 * RUNTIME OPERATIONAL BRIDGE — CMD4 Phase 19 Module 3.
 *
 * Read-only unified bridge that exposes runtime monitor + archive + alert
 * aggregation state as a single canonical operational snapshot. Provides
 * a one-stop deterministic view for live MMO operational dashboards.
 *
 * Brief v19 §M3 responsibilities:
 *   1. deterministic runtime exports (frozen snapshot)
 *   2. replay-safe operational snapshots (no archive write)
 *   3. canonical runtime serialization (FNV-1a fingerprint)
 *   4. replay-independent monitoring exports (READ-ONLY consumer)
 *   5. stable operational replay tracing
 *
 * STRICT RULE (brief v19 §M3):
 *   READ-ONLY ONLY.
 * FORBIDDEN:
 *   replay contamination
 *   unstable metric ordering
 *   transient runtime aggregation
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence.
 *
 * Ownership: tooling/liveops layer (brief v19 §III).
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';
import { RuntimeMonitorRegistry } from './runtime_monitor_projection_runtime.js';
import { ImmutableSnapshotArchive } from './immutable_snapshot_archive.js';
import { AlertAggregationRuntime } from './alert_aggregation_runtime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const RUNTIME_OPERATIONAL_BRIDGE_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface OperationalSnapshot {
  readonly runtime_version: number;
  readonly monitor_snapshot_count: number;
  readonly monitor_view_hash: string;
  readonly archive_entry_count: number;
  readonly archive_snapshot_hash: string;
  readonly alert_count: number;
  readonly alert_report_hash: string;
  /** FNV-1a of canonical(monitor_view_hash + archive_snapshot_hash + alert_report_hash). */
  readonly unified_hash: string;
}

export interface OperationalDeltaReport {
  readonly runtime_version: number;
  readonly delta_kind: 'between_snapshots';
  readonly monitor_view_match: boolean;
  readonly archive_snapshot_match: boolean;
  readonly alert_report_match: boolean;
  readonly unified_hash_match: boolean;
  readonly deterministic_hash: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// RuntimeOperationalBridge — engine-private read-only references
// ═══════════════════════════════════════════════════════════════════════════

export class RuntimeOperationalBridge {
  /** ES private — engine-enforced read-only closure. */
  readonly #monitor: RuntimeMonitorRegistry;
  readonly #archive: ImmutableSnapshotArchive;
  readonly #alerts: AlertAggregationRuntime;

  constructor(
    monitor: RuntimeMonitorRegistry,
    archive: ImmutableSnapshotArchive,
    alerts: AlertAggregationRuntime,
  ) {
    this.#monitor = monitor;
    this.#archive = archive;
    this.#alerts = alerts;
  }

  get monitorSize(): number {
    return this.#monitor.size;
  }
  get archiveSize(): number {
    return this.#archive.size;
  }
  get alertSize(): number {
    return this.#alerts.size;
  }

  /**
   * Build a unified operational snapshot — frozen + deterministic.
   *
   * Aggregates 3 layer hashes:
   *   - monitor registry view hash (Phase 16 M2)
   *   - archive snapshot hash (Phase 15 M3)
   *   - alert aggregate report hash (Phase 19 M2)
   *
   * The unified_hash is FNV-1a over canonical([mon, arc, alert]) — providing
   * a single-point fingerprint of the entire operational state at this moment.
   *
   * Pure — same (monitor, archive, alerts) state → same snapshot bytes ALWAYS.
   */
  exportOperationalSnapshot(): OperationalSnapshot {
    const monView = this.#monitor.exportRegistryView();
    const arcSnap = this.#archive.exportSnapshot();
    const alertReport = this.#alerts.aggregateReport();

    const unifiedCanonical = canonicalSerialize({
      runtime_version: RUNTIME_OPERATIONAL_BRIDGE_VERSION,
      monitor_view_hash: monView.deterministic_hash,
      archive_snapshot_hash: arcSnap.deterministic_hash,
      alert_report_hash: alertReport.deterministic_hash,
    });

    return Object.freeze({
      runtime_version: RUNTIME_OPERATIONAL_BRIDGE_VERSION,
      monitor_snapshot_count: this.#monitor.size,
      monitor_view_hash: monView.deterministic_hash,
      archive_entry_count: this.#archive.size,
      archive_snapshot_hash: arcSnap.deterministic_hash,
      alert_count: this.#alerts.size,
      alert_report_hash: alertReport.deterministic_hash,
      unified_hash: fnv1a32(unifiedCanonical),
    });
  }

  /**
   * Compare two `OperationalSnapshot`s field-by-field. Useful for detecting
   * which layer changed between two operational checkpoints.
   *
   * Pure — same pair → same delta report bytes ALWAYS.
   */
  static compareSnapshots(a: OperationalSnapshot, b: OperationalSnapshot): OperationalDeltaReport {
    const monMatch = a.monitor_view_hash === b.monitor_view_hash;
    const arcMatch = a.archive_snapshot_hash === b.archive_snapshot_hash;
    const alertMatch = a.alert_report_hash === b.alert_report_hash;
    const unifiedMatch = a.unified_hash === b.unified_hash;

    const canonical = canonicalSerialize({
      runtime_version: RUNTIME_OPERATIONAL_BRIDGE_VERSION,
      delta_kind: 'between_snapshots',
      monitor_view_match: monMatch,
      archive_snapshot_match: arcMatch,
      alert_report_match: alertMatch,
      unified_hash_match: unifiedMatch,
    });

    return Object.freeze({
      runtime_version: RUNTIME_OPERATIONAL_BRIDGE_VERSION,
      delta_kind: 'between_snapshots' as const,
      monitor_view_match: monMatch,
      archive_snapshot_match: arcMatch,
      alert_report_match: alertMatch,
      unified_hash_match: unifiedMatch,
      deterministic_hash: fnv1a32(canonical),
    });
  }
}

/**
 * Convenience standalone — compare two `OperationalSnapshot`s without
 * needing a bridge instance. Same input pair → same output bytes ALWAYS.
 */
export function compareOperationalSnapshots(
  a: OperationalSnapshot,
  b: OperationalSnapshot,
): OperationalDeltaReport {
  return RuntimeOperationalBridge.compareSnapshots(a, b);
}
