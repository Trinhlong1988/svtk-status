/**
 * OPERATOR WORKFLOW EXPERIENCE RUNTIME — CMD4 Phase 22 Module 1.
 *
 * Operator-readable incident explanation layer. Consumes Phase 19 alert
 * aggregation + operator incident reconstruction and emits structured
 * deterministic explanations: WHAT failed, WHY, SEVERITY level, SAFE
 * recovery path, EXPECTED vs DANGEROUS divergence.
 *
 * Brief v22 §M1 responsibilities:
 *   1. deterministic incident summaries
 *   2. replay-safe recovery guidance
 *   3. operational severity classification
 *   4. deployment audit explainability
 *   5. replay lineage readability
 *   6. structured operator diagnostics
 *
 * MANDATORY: operators MUST understand what failed / why / severity /
 * safe recovery path / expected vs dangerous divergence.
 *
 * FORBIDDEN: opaque boolean-only failures or ambiguous incident wording.
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence.
 *
 * Ownership: tooling/liveops/operator layer (brief v22 §III).
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';
import {
  ALERT_SEVERITY,
  type AlertSeverity,
  type AlertIncident,
  type AlertAggregateReport,
} from './alert_aggregation_runtime.js';
import type { OperatorIncidentReport } from './operator_incident_reconstruction_runtime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const OPERATOR_WORKFLOW_EXPERIENCE_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export const SEVERITY_GRADE = Object.freeze({
  CRITICAL: 'critical',
  MAJOR: 'major',
  MINOR: 'minor',
  ADVISORY: 'advisory',
} as const);
export type SeverityGrade = (typeof SEVERITY_GRADE)[keyof typeof SEVERITY_GRADE];

export const RECOVERY_KIND = Object.freeze({
  RESTART_REQUIRED: 'restart_required',
  ROLLBACK_RECOMMENDED: 'rollback_recommended',
  MONITOR_AND_WAIT: 'monitor_and_wait',
  INVESTIGATE_LOGS: 'investigate_logs',
  NO_ACTION_REQUIRED: 'no_action_required',
} as const);
export type RecoveryKind = (typeof RECOVERY_KIND)[keyof typeof RECOVERY_KIND];

export interface OperatorExplanation {
  readonly runtime_version: number;
  /** What component / incident is being explained. */
  readonly incident_kind: string;
  readonly source_id: string;
  /** Human-readable WHAT-FAILED. */
  readonly what_failed: string;
  /** Human-readable WHY-FAILED (severity + alert count summary). */
  readonly why_failed: string;
  /** Coarse severity grade (4 levels — see SEVERITY_GRADE). */
  readonly severity_grade: SeverityGrade;
  /** Discrete recovery kind enum. */
  readonly recovery_kind: RecoveryKind;
  /** Free-form safe recovery path string. */
  readonly safe_recovery_path: string;
  /** Whether the divergence/incident is expected or dangerous. */
  readonly divergence_class: 'expected' | 'dangerous';
  readonly deterministic_hash: string;
}

export interface OperatorExplanationDigest {
  readonly runtime_version: number;
  readonly explanation_count: number;
  /** Lex-sorted by (incident_kind, source_id). */
  readonly explanations: readonly OperatorExplanation[];
  /** Per-severity rollup. */
  readonly severity_rollup: {
    readonly critical: number;
    readonly major: number;
    readonly minor: number;
    readonly advisory: number;
  };
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

/**
 * Map (severity, alert_count) → coarse severity grade. Deterministic.
 */
function gradeSeverity(severity: AlertSeverity, alertCount: number): SeverityGrade {
  if (severity === ALERT_SEVERITY.ERROR) {
    return alertCount >= 10 ? SEVERITY_GRADE.CRITICAL : SEVERITY_GRADE.MAJOR;
  }
  if (severity === ALERT_SEVERITY.WARNING) {
    return alertCount >= 50 ? SEVERITY_GRADE.MAJOR : SEVERITY_GRADE.MINOR;
  }
  return SEVERITY_GRADE.ADVISORY;
}

/**
 * Map severity grade → recommended recovery kind. Deterministic.
 */
function recoveryFor(grade: SeverityGrade): RecoveryKind {
  if (grade === SEVERITY_GRADE.CRITICAL) return RECOVERY_KIND.RESTART_REQUIRED;
  if (grade === SEVERITY_GRADE.MAJOR) return RECOVERY_KIND.ROLLBACK_RECOMMENDED;
  if (grade === SEVERITY_GRADE.MINOR) return RECOVERY_KIND.INVESTIGATE_LOGS;
  return RECOVERY_KIND.MONITOR_AND_WAIT;
}

/**
 * Map recovery kind → safe recovery path text. Deterministic.
 */
function recoveryPathText(kind: RecoveryKind, incidentKind: string, sourceId: string): string {
  if (kind === RECOVERY_KIND.RESTART_REQUIRED) {
    return `Restart "${sourceId}" service. Re-verify "${incidentKind}" metric is below threshold within 5 monitor cycles.`;
  }
  if (kind === RECOVERY_KIND.ROLLBACK_RECOMMENDED) {
    return `Roll back the most recent release on "${sourceId}". Inspect "${incidentKind}" trend in monitor history.`;
  }
  if (kind === RECOVERY_KIND.INVESTIGATE_LOGS) {
    return `Investigate forensic logs for "${incidentKind}" on "${sourceId}". No immediate action; watch for escalation.`;
  }
  if (kind === RECOVERY_KIND.MONITOR_AND_WAIT) {
    return `Monitor "${sourceId}" passively. No action unless severity escalates.`;
  }
  return `No action required for "${incidentKind}" on "${sourceId}".`;
}

function divergenceClass(severity: AlertSeverity, alertCount: number): 'expected' | 'dangerous' {
  if (severity === ALERT_SEVERITY.ERROR) return 'dangerous';
  if (severity === ALERT_SEVERITY.WARNING && alertCount >= 50) return 'dangerous';
  return 'expected';
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — explainIncident
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a deterministic operator explanation from an `OperatorIncidentReport`
 * (Phase 19 M4) PLUS the alert-level severity (Phase 19 M2).
 *
 * `incidentSeverity` is the WORST alert severity in the incident (lowest
 * AlertSeverity enum value). Callers typically extract this from
 * `aggregateReport().incidents[i].severity` for the matching (kind, source).
 *
 * Pure — same inputs → same explanation bytes ALWAYS.
 */
export function explainIncident(
  incident: OperatorIncidentReport,
  incidentSeverity: AlertSeverity,
): OperatorExplanation {
  // Bug #24 fix: when alert_count === 0 the recon trace is empty regardless of
  // the severity hint the caller supplies. Force ADVISORY / NO_ACTION_REQUIRED
  // so the human-readable explanation, severity grade, recovery kind, and
  // divergence class all stay internally consistent. Prevents the
  // "No alerts recorded" + "ROLLBACK_RECOMMENDED" contradiction.
  const isEmpty = incident.alert_count === 0;
  const grade = isEmpty ? SEVERITY_GRADE.ADVISORY : gradeSeverity(incidentSeverity, incident.alert_count);
  const recovery = isEmpty ? RECOVERY_KIND.NO_ACTION_REQUIRED : recoveryFor(grade);
  const path = recoveryPathText(recovery, incident.incident_kind, incident.source_id);
  const divergence = isEmpty ? 'expected' : divergenceClass(incidentSeverity, incident.alert_count);

  const what =
    incident.alert_count === 0
      ? `No alerts recorded for "${incident.incident_kind}" on "${incident.source_id}". Incident reconstruction returned empty trace.`
      : `${String(incident.alert_count)} alerts of kind "${incident.incident_kind}" raised by "${incident.source_id}" between ordinal ${String(incident.first_ordinal)} and ${String(incident.last_ordinal)}.`;
  const why =
    incident.alert_count === 0
      ? 'No incident detected — explanation generated for absent state.'
      : `Worst severity observed: ${incidentSeverity === ALERT_SEVERITY.ERROR ? 'ERROR' : incidentSeverity === ALERT_SEVERITY.WARNING ? 'WARNING' : 'INFO'}. ${String(incident.related_archive_entries.length)} archive entries and ${String(incident.related_monitor_samples.length)} monitor samples fall within the incident window.`;

  const canonical = canonicalSerialize({
    runtime_version: OPERATOR_WORKFLOW_EXPERIENCE_VERSION,
    incident_kind: incident.incident_kind,
    source_id: incident.source_id,
    what_failed: what,
    why_failed: why,
    severity_grade: grade,
    recovery_kind: recovery,
    safe_recovery_path: path,
    divergence_class: divergence,
  });

  return Object.freeze({
    runtime_version: OPERATOR_WORKFLOW_EXPERIENCE_VERSION,
    incident_kind: incident.incident_kind,
    source_id: incident.source_id,
    what_failed: what,
    why_failed: why,
    severity_grade: grade,
    recovery_kind: recovery,
    safe_recovery_path: path,
    divergence_class: divergence,
    deterministic_hash: fnv1a32(canonical),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — buildExplanationDigest
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a deterministic digest of operator explanations for ALL incidents
 * in an `AlertAggregateReport`. The digest is the operator's primary
 * triage surface — lex-sorted, severity-rolled, frozen.
 *
 * `incidentByCompositeKey` lets the caller pre-fetch
 * `OperatorIncidentReport` per (kind, source_id) once and pass them in,
 * avoiding O(N) re-reconstruction per call.
 *
 * Pure — same inputs → same digest bytes ALWAYS.
 */
export function buildExplanationDigest(
  alertReport: AlertAggregateReport,
  incidentByCompositeKey: ReadonlyMap<string, OperatorIncidentReport>,
): OperatorExplanationDigest {
  const explanations: OperatorExplanation[] = [];
  let critical = 0;
  let major = 0;
  let minor = 0;
  let advisory = 0;

  for (const inc of alertReport.incidents) {
    const compKey = JSON.stringify([inc.group_kind, inc.source_id]);
    const report = incidentByCompositeKey.get(compKey);
    if (report === undefined) continue; // caller didn't supply this incident — skip
    const exp = explainIncident(report, inc.severity);
    explanations.push(exp);
    if (exp.severity_grade === SEVERITY_GRADE.CRITICAL) critical++;
    else if (exp.severity_grade === SEVERITY_GRADE.MAJOR) major++;
    else if (exp.severity_grade === SEVERITY_GRADE.MINOR) minor++;
    else advisory++;
  }
  explanations.sort((a, b) => {
    const k = lexCompare(a.incident_kind, b.incident_kind);
    if (k !== 0) return k;
    return lexCompare(a.source_id, b.source_id);
  });
  const frozen = Object.freeze(explanations.map((e) => e));

  const canonical = canonicalSerialize({
    runtime_version: OPERATOR_WORKFLOW_EXPERIENCE_VERSION,
    explanation_count: frozen.length,
    explanations: frozen.map((e) => ({
      incident_kind: e.incident_kind,
      source_id: e.source_id,
      what_failed: e.what_failed,
      why_failed: e.why_failed,
      severity_grade: e.severity_grade,
      recovery_kind: e.recovery_kind,
      safe_recovery_path: e.safe_recovery_path,
      divergence_class: e.divergence_class,
    })),
    severity_rollup: { critical, major, minor, advisory },
  });

  return Object.freeze({
    runtime_version: OPERATOR_WORKFLOW_EXPERIENCE_VERSION,
    explanation_count: frozen.length,
    explanations: frozen,
    severity_rollup: Object.freeze({ critical, major, minor, advisory }),
    deterministic_hash: fnv1a32(canonical),
  });
}

// Re-export imports for downstream typing convenience.
export type { AlertIncident, AlertAggregateReport, OperatorIncidentReport };
