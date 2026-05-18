/**
 * COMBAT FORENSIC AUDIT RUNTIME — deep online incident reconstruction (Phase 16 § 4).
 *
 * Per CMD1 Phase 16 directive § PRIMARY OBJECTIVES § combat_forensic_audit_runtime:
 *   "Purpose: deep online combat incident reconstruction.
 *    SUPPORT:
 *      - replay divergence reconstruction
 *      - reconnect incident tracing
 *      - combat desync diagnostics
 *      - rollback incident audit
 *      - deterministic replay chain analysis
 *    STRICT RULE: READ-ONLY ONLY.
 *    FORBIDDEN:
 *      - runtime mutation
 *      - combat override
 *      - GM authority injection
 *      - replay mutation"
 *
 * STRICT READ-ONLY w/r/t CombatRuntime + RunSnapshot. The audit STATE itself
 * is mutated (incidents are appended), but no combat surface is mutated.
 *
 * Composes existing forensic primitives:
 *   - `combat_divergence_diagnostics.ts` (Phase 12 ADV) — `compareRunSnapshots`
 *   - `combat_session_sync.ts` (Phase 14) — `compareSyncSnapshots`
 *   - `combat_payload_compatibility.ts` (Phase 14 hardening) — `compareCrossVersionPayloads`
 *   - `combat_replay_verification_runtime.ts` (Phase 14) — already reuses divergence diagnostics
 *
 * STRICT additive — no I/O. Caller drives capture; audit aggregates.
 */
import type { CombatRuntime } from './combat_runtime.js';
import { canonicalHash } from './combat_storage.js';
import {
  compareRunSnapshots,
  type RunSnapshot,
  type CombatDivergenceReport,
  type DivergenceKind,
} from './combat_divergence_diagnostics.js';
import {
  compareSyncSnapshots,
  type SyncSnapshot,
  type SyncSnapshotDivergence,
} from './combat_session_sync.js';
import {
  compareCrossVersionPayloads,
  type CrossVersionParityReport,
} from './combat_payload_compatibility.js';
import {
  hashPayload,
  type CombatPayload,
} from './combat_payload_builder.js';
import { canonicalJson } from './combat_storage.js';

export const COMBAT_FORENSIC_AUDIT_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────
// Incident model
// ─────────────────────────────────────────────────────────

export type IncidentKind =
  | 'replay_divergence'
  | 'sync_snapshot_drift'
  | 'cross_version_payload'
  | 'reconnect_failure'
  | 'rollback_anomaly'
  | 'desync_observation';

export interface ForensicIncident {
  schemaVersion: number;
  /** Monotonic seq within this audit. */
  seq: number;
  kind: IncidentKind;
  /** Turn at which the incident was first observed (or -1 if not turn-bound). */
  observedAtTurn: number;
  /** Encounter id of the incident. */
  encounterId: string;
  /** Stable summary string for dashboard. */
  summary: string;
  /** Kind-specific detail (frozen JSON-safe). */
  detail: Readonly<Record<string, unknown>>;
  /** Stable digest of the incident (forensic identity). */
  digest: string;
}

// ─────────────────────────────────────────────────────────
// Audit state
// ─────────────────────────────────────────────────────────

export interface ForensicAuditState {
  schemaVersion: number;
  encounterId: string;
  /** Append-only incident log. */
  incidents: ForensicIncident[];
  /** Next incident seq. */
  nextSeq: number;
  /** Histogram of incident kinds for dashboard. */
  kindCounts: Record<IncidentKind, number>;
}

export function createForensicAudit(encounterId: string): ForensicAuditState {
  // R7-5 audit fix: validate encounterId at factory. Empty/whitespace ID would
  // silently match an empty rt.config.encounterId, producing forensic digests
  // bound to empty identity → cross-encounter collision in dashboard.
  if (!encounterId || encounterId.trim().length === 0) {
    throw new ForensicAuditError(`encounterId must be non-empty (whitespace-only rejected)`);
  }
  return {
    schemaVersion: COMBAT_FORENSIC_AUDIT_SCHEMA_VERSION,
    encounterId,
    incidents: [],
    nextSeq: 0,
    kindCounts: {
      replay_divergence: 0,
      sync_snapshot_drift: 0,
      cross_version_payload: 0,
      reconnect_failure: 0,
      rollback_anomaly: 0,
      desync_observation: 0,
    },
  };
}

// ─────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────

export class ForensicAuditError extends Error {
  constructor(message: string) {
    super(`[ForensicAudit] ${message}`);
    this.name = 'ForensicAuditError';
  }
}

// ─────────────────────────────────────────────────────────
// Incident capture (READ-ONLY against runtime / snapshots)
// ─────────────────────────────────────────────────────────

function appendIncident(
  state: ForensicAuditState,
  kind: IncidentKind,
  encounterId: string,
  observedAtTurn: number,
  summary: string,
  detail: Readonly<Record<string, unknown>>,
): ForensicIncident {
  if (encounterId !== state.encounterId) {
    throw new ForensicAuditError(
      `encounterId mismatch: audit='${state.encounterId}' incident='${encounterId}'`,
    );
  }
  // R7-6 audit fix: defensive canonical clone of `detail`. The interface marks
  // detail as `Readonly` but TS readonly is compile-only — caller can mutate
  // via cast (or simply mutate a non-typed reference held elsewhere). Without
  // this clone, post-record mutation diverges `incident.detail` from the
  // value used to compute `incident.digest` → forensic integrity broken.
  //
  // canonicalJson + JSON.parse round-trip produces a fresh plain-object tree
  // with stable canonical serialization. Also rejects unserializable values
  // (BigInt / Symbol / circular) at the boundary instead of allowing them to
  // poison the audit log.
  let frozenDetail: Readonly<Record<string, unknown>>;
  try {
    frozenDetail = JSON.parse(canonicalJson(detail)) as Record<string, unknown>;
  } catch (e) {
    throw new ForensicAuditError(
      `incident detail is not canonical-JSON serializable: ${(e as Error).message}`,
    );
  }
  const seq = state.nextSeq++;
  const incident: ForensicIncident = {
    schemaVersion: COMBAT_FORENSIC_AUDIT_SCHEMA_VERSION,
    seq,
    kind,
    observedAtTurn,
    encounterId,
    summary,
    detail: frozenDetail,
    digest: canonicalHash({ seq, kind, encounterId, observedAtTurn, summary, detail: frozenDetail }),
  };
  state.incidents.push(incident);
  state.kindCounts[kind]++;
  return incident;
}

/**
 * Reconstruct replay divergence between two RunSnapshots. Append an incident
 * if divergent. READ-ONLY w/r/t the snapshots.
 */
export function reconstructReplayDivergence(
  state: ForensicAuditState,
  a: RunSnapshot,
  b: RunSnapshot,
  observedAtTurn = -1,
): ForensicIncident | undefined {
  if (a.encounterId !== state.encounterId) {
    throw new ForensicAuditError(
      `snapshot A encounterId mismatch: audit='${state.encounterId}' snapshot='${a.encounterId}'`,
    );
  }
  if (b.encounterId !== state.encounterId) {
    throw new ForensicAuditError(
      `snapshot B encounterId mismatch: audit='${state.encounterId}' snapshot='${b.encounterId}'`,
    );
  }
  const report = compareRunSnapshots(a, b);
  if (!report.divergent) return undefined;
  return appendIncident(
    state,
    'replay_divergence',
    state.encounterId,
    observedAtTurn,
    report.summary,
    {
      kind: report.kind,
      encounterA: report.encounterA,
      encounterB: report.encounterB,
      reportDetail: report.detail ?? {},
    },
  );
}

/**
 * Trace a reconnect incident. The audit caller observed a reconnect failure
 * — record it for forensic chain analysis.
 */
export function traceReconnectFailure(
  state: ForensicAuditState,
  encounterId: string,
  observedAtTurn: number,
  failureReason: string,
  context: Readonly<Record<string, unknown>> = {},
): ForensicIncident {
  return appendIncident(
    state,
    'reconnect_failure',
    encounterId,
    observedAtTurn,
    `reconnect failed: ${failureReason}`,
    { failureReason, ...context },
  );
}

/**
 * Record a sync snapshot drift between two captures.
 */
export function recordSyncDrift(
  state: ForensicAuditState,
  expected: SyncSnapshot,
  actual: SyncSnapshot,
  observedAtTurn = -1,
): ForensicIncident | undefined {
  if (expected.encounterId !== actual.encounterId) {
    throw new ForensicAuditError(
      `sync snapshot pair encounterId mismatch: expected='${expected.encounterId}' actual='${actual.encounterId}'`,
    );
  }
  const div: SyncSnapshotDivergence = compareSyncSnapshots(expected, actual);
  if (!div.divergent) return undefined;
  return appendIncident(
    state,
    'sync_snapshot_drift',
    expected.encounterId,
    observedAtTurn,
    `sync snapshot drift on field '${div.field ?? 'unknown'}'`,
    {
      field: div.field ?? 'digest',
      expectedDigest: expected.digest,
      actualDigest: actual.digest,
    },
  );
}

/**
 * Record a cross-version payload incompatibility.
 */
export function recordCrossVersionMismatch(
  state: ForensicAuditState,
  a: CombatPayload,
  b: CombatPayload,
  observedAtTurn = -1,
): ForensicIncident | undefined {
  if (a.encounterId !== b.encounterId) {
    throw new ForensicAuditError(
      `cross-version payload pair encounterId mismatch: a='${a.encounterId}' b='${b.encounterId}'`,
    );
  }
  const report: CrossVersionParityReport = compareCrossVersionPayloads(a, b);
  if (report.parityHeld) return undefined;
  return appendIncident(
    state,
    'cross_version_payload',
    a.encounterId,
    observedAtTurn,
    `cross-version payload parity broken @ v${report.effectiveVersion}`,
    {
      effectiveVersion: report.effectiveVersion,
      versionsCompatible: report.versionsCompatible,
      divergenceField: report.divergence?.field ?? null,
      aHash: hashPayload(a),
      bHash: hashPayload(b),
    },
  );
}

/**
 * Record a rollback anomaly — e.g., rollback to a turn before any persisted
 * checkpoint, or rollback without matching audit-log entry.
 */
export function recordRollbackAnomaly(
  state: ForensicAuditState,
  encounterId: string,
  observedAtTurn: number,
  description: string,
  context: Readonly<Record<string, unknown>> = {},
): ForensicIncident {
  return appendIncident(
    state,
    'rollback_anomaly',
    encounterId,
    observedAtTurn,
    description,
    context,
  );
}

/**
 * Record a freestyle desync observation — generic capture for any combat
 * desync the caller observes that doesn't fit specific kinds above.
 */
export function recordDesyncObservation(
  state: ForensicAuditState,
  encounterId: string,
  observedAtTurn: number,
  description: string,
  context: Readonly<Record<string, unknown>> = {},
): ForensicIncident {
  return appendIncident(
    state,
    'desync_observation',
    encounterId,
    observedAtTurn,
    description,
    context,
  );
}

// ─────────────────────────────────────────────────────────
// Audit projection (canonical, deterministic)
// ─────────────────────────────────────────────────────────

export interface ForensicAuditProjection {
  schemaVersion: number;
  encounterId: string;
  totalIncidents: number;
  /** Canonical-ordered incidents by seq asc. */
  incidents: readonly ForensicIncident[];
  /** Histogram per IncidentKind. */
  kindCounts: Readonly<Record<IncidentKind, number>>;
  /** Stable forensic digest of the audit. */
  digest: string;
}

export function projectForensicAudit(
  state: ForensicAuditState,
): ForensicAuditProjection {
  // state.incidents populated by appendIncident in seq-monotonic order;
  // sort is defense-in-depth. Stryker mutants EQUIVALENT.
  // Stryker disable next-line all
  const ordered = [...state.incidents].sort((a, b) => a.seq - b.seq);
  const forDigest = {
    schemaVersion: COMBAT_FORENSIC_AUDIT_SCHEMA_VERSION,
    encounterId: state.encounterId,
    totalIncidents: ordered.length,
    kindCounts: state.kindCounts,
    incidentDigests: ordered.map((i) => i.digest),
  };
  return {
    schemaVersion: COMBAT_FORENSIC_AUDIT_SCHEMA_VERSION,
    encounterId: state.encounterId,
    totalIncidents: ordered.length,
    incidents: ordered,
    kindCounts: state.kindCounts,
    digest: canonicalHash(forDigest),
  };
}

// ─────────────────────────────────────────────────────────
// Deterministic replay chain analysis
// ─────────────────────────────────────────────────────────

export interface ReplayChainNode {
  encounterId: string;
  turn: number;
  payloadHash: string;
  spectatorDigest: string;
}

export interface ChainAnalysisReport {
  schemaVersion: number;
  encounterId: string;
  nodes: readonly ReplayChainNode[];
  /** First-divergent index between expected[i] and actual[i] (-1 if none). */
  firstDivergentIndex: number;
  /** True if chains match across all nodes. */
  chainParity: boolean;
  /** Stable digest covering the comparison. */
  digest: string;
}

/**
 * Analyze a chain of (expected, actual) RunSnapshots across a sequence of
 * turns. Returns the first divergent index, or -1 if chains match.
 *
 * Use case: forensic reconstruction of WHEN replay drift began across a
 * multi-turn server-client comparison.
 */
export function analyzeReplayChain(
  state: ForensicAuditState,
  expected: readonly RunSnapshot[],
  actual: readonly RunSnapshot[],
): ChainAnalysisReport {
  if (expected.length !== actual.length) {
    throw new ForensicAuditError(
      `chain length mismatch: expected=${expected.length} actual=${actual.length}`,
    );
  }
  const nodes: ReplayChainNode[] = [];
  let firstDivergentIndex = -1;
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i]!;
    const a = actual[i]!;
    if (e.encounterId !== state.encounterId || a.encounterId !== state.encounterId) {
      throw new ForensicAuditError(
        `chain node[${i}] encounterId mismatch: audit='${state.encounterId}' expected='${e.encounterId}' actual='${a.encounterId}'`,
      );
    }
    nodes.push({
      encounterId: e.encounterId,
      turn: i,
      payloadHash: e.payloadHash,
      spectatorDigest: e.spectatorDigest,
    });
    if (firstDivergentIndex === -1) {
      const cmp: CombatDivergenceReport = compareRunSnapshots(e, a);
      if (cmp.divergent) firstDivergentIndex = i;
    }
  }
  const chainParity = firstDivergentIndex === -1;
  const forDigest = {
    schemaVersion: COMBAT_FORENSIC_AUDIT_SCHEMA_VERSION,
    encounterId: state.encounterId,
    nodeCount: nodes.length,
    firstDivergentIndex,
    chainParity,
  };
  return {
    schemaVersion: COMBAT_FORENSIC_AUDIT_SCHEMA_VERSION,
    encounterId: state.encounterId,
    nodes,
    firstDivergentIndex,
    chainParity,
    digest: canonicalHash(forDigest),
  };
}

// ─────────────────────────────────────────────────────────
// Query helpers (canonical-sorted)
// ─────────────────────────────────────────────────────────

export function incidentsByKind(
  state: ForensicAuditState,
  kind: IncidentKind,
): readonly ForensicIncident[] {
  // Stryker disable all -- seq-monotonic, defense-in-depth sort
  return [...state.incidents]
    .filter((i) => i.kind === kind)
    .sort((a, b) => a.seq - b.seq);
  // Stryker restore all
}

export function totalIncidents(state: ForensicAuditState): number {
  return state.incidents.length;
}

/** Stable hash of incident sequence — forensic comparison. */
export function forensicHistoryHash(state: ForensicAuditState): string {
  let h = 0x811c9dc5 >>> 0;
  const eat = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const inc of state.incidents) {
    eat(`${inc.seq}|${inc.kind}|${inc.observedAtTurn}|${inc.digest}`);
  }
  return h.toString(16).padStart(8, '0');
}

// ─────────────────────────────────────────────────────────
// READ-ONLY contract verification
// ─────────────────────────────────────────────────────────

/**
 * Verify that calling forensic APIs does NOT mutate the runtime. Use for
 * test harness validation only — checks invariants on the runtime side.
 *
 * Returns true if read-only invariant held (no detectable mutation).
 */
export function verifyReadOnlyContract(
  rt: CombatRuntime,
  fn: () => void,
): boolean {
  const beforeTurn = rt.currentTurn;
  const beforeFrames = rt.replayStream.frames.length;
  const beforeEvents = rt.replayStream.events.length;
  const beforeSessionId = rt.config.sessionId;
  const beforeEncounterId = rt.config.encounterId;
  fn();
  return (
    rt.currentTurn === beforeTurn &&
    rt.replayStream.frames.length === beforeFrames &&
    rt.replayStream.events.length === beforeEvents &&
    rt.config.sessionId === beforeSessionId &&
    rt.config.encounterId === beforeEncounterId
  );
}
