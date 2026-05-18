/**
 * COMBAT REPLAY VERIFICATION RUNTIME — production replay verification (Phase 14 § 4).
 *
 * Per CMD1 1.docx Phase 14 § 4:
 *   "Purpose: production replay verification runtime.
 *    SUPPORT:
 *      - server-vs-client replay compare
 *      - reconnect replay validation
 *      - forensic replay audit
 *      - drift detection report
 *      - deterministic replay verification
 *    TARGET: 0 replay divergence."
 *
 * Receives RunSnapshots from both server and client (or replay archive vs
 * live replay), compares via existing `combat_divergence_diagnostics` (Phase
 * 12 ADV), aggregates drift reports across multiple comparisons, and emits
 * a forensic audit.
 *
 * STRICT additive — no I/O. Composes existing forensic primitives.
 */
import type { RunSnapshot, CombatDivergenceReport } from './combat_divergence_diagnostics.js';
import {
  compareRunSnapshots,
} from './combat_divergence_diagnostics.js';
import { canonicalHash } from './combat_storage.js';

export const REPLAY_VERIFICATION_RUNTIME_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────
// Submission model
// ─────────────────────────────────────────────────────────

export type SubmissionRole = 'server' | 'client' | 'replay_archive';

export interface SubmittedSnapshot {
  /** Monotonic submission id within this verification runtime. */
  submissionSeq: number;
  role: SubmissionRole;
  /** Source descriptor (e.g. 'shard-3', 'player-77'). */
  sourceId: string;
  snapshot: RunSnapshot;
}

export interface VerificationRuntimeState {
  schemaVersion: number;
  encounterId: string;
  submissions: SubmittedSnapshot[];
  nextSubmissionSeq: number;
}

export function createVerificationRuntime(
  encounterId: string,
): VerificationRuntimeState {
  // R7-12 audit fix: factory-level identity validation. Without this, an
  // empty/whitespace encounterId state would silently match any snapshot
  // whose encounterId is also empty/whitespace → cross-encounter cross-
  // contamination in audit dashboard. Same root cause as R7-1/3/5/8/9/10/11.
  if (!encounterId || encounterId.trim().length === 0) {
    throw new ReplayVerificationError(`encounterId must be non-empty (whitespace-only rejected)`);
  }
  return {
    schemaVersion: REPLAY_VERIFICATION_RUNTIME_SCHEMA_VERSION,
    encounterId,
    submissions: [],
    nextSubmissionSeq: 0,
  };
}

// ─────────────────────────────────────────────────────────
// Submission API
// ─────────────────────────────────────────────────────────

export class ReplayVerificationError extends Error {
  constructor(message: string) {
    super(`[ReplayVerification] ${message}`);
    this.name = 'ReplayVerificationError';
  }
}

export function submitSnapshot(
  state: VerificationRuntimeState,
  role: SubmissionRole,
  sourceId: string,
  snapshot: RunSnapshot,
): SubmittedSnapshot {
  if (state.encounterId !== snapshot.encounterId) {
    throw new ReplayVerificationError(
      `encounterId mismatch: runtime='${state.encounterId}' snapshot='${snapshot.encounterId}'`,
    );
  }
  // R4-4 audit fix: reject empty sourceId — required for comparePair lookup
  // disambiguation. Empty sourceId would cause silent match-wrong-submission.
  if (!sourceId) {
    throw new ReplayVerificationError(`sourceId must be non-empty`);
  }
  // R6-5 audit fix: reject whitespace-only sourceId.
  if (sourceId.trim().length === 0) {
    throw new ReplayVerificationError(`sourceId must be non-empty (whitespace-only rejected)`);
  }
  // R6-2 audit fix: enforce unique sourceId. Without this, comparePair's
  // `find()` returns first match silently; compareAllAgainstReference produces
  // duplicate pairIds in output → caller can lose information.
  if (state.submissions.some((s) => s.sourceId === sourceId)) {
    throw new ReplayVerificationError(`sourceId '${sourceId}' already submitted (must be unique within verification runtime)`);
  }
  // Defensive freeze: captureRunSnapshot (Phase 12 ADV) aliases rt.replayStream.frames
  // and rt.replayStream.events directly. If the runtime continues to advance after
  // submit, those arrays would mutate and break later comparisons. Copy at the
  // verification boundary so submitted snapshots are immutable.
  //
  // R5-8 audit fix: also defensive-copy `payload.frameDigest` — that array is
  // marked `readonly` in TS but JS runtime allows caller to cast and mutate.
  // Without this copy, post-submit mutation would leak into verification view.
  const frozen: RunSnapshot = {
    encounterId: snapshot.encounterId,
    payload: { ...snapshot.payload, frameDigest: [...snapshot.payload.frameDigest] },
    payloadHash: snapshot.payloadHash,
    spectatorDigest: snapshot.spectatorDigest,
    frames: [...snapshot.frames],
    events: [...snapshot.events],
  };
  const entry: SubmittedSnapshot = {
    submissionSeq: state.nextSubmissionSeq++,
    role,
    sourceId,
    snapshot: frozen,
  };
  state.submissions.push(entry);
  return entry;
}

// ─────────────────────────────────────────────────────────
// Pairwise comparison
// ─────────────────────────────────────────────────────────

export interface PairComparison {
  pairId: string;       // "sourceA::sourceB"
  divergent: boolean;
  divergenceReport: CombatDivergenceReport;
}

/**
 * Compare two specific submissions by sourceId. Throws if either not found.
 */
export function comparePair(
  state: VerificationRuntimeState,
  sourceA: string,
  sourceB: string,
): PairComparison {
  const a = state.submissions.find((s) => s.sourceId === sourceA);
  const b = state.submissions.find((s) => s.sourceId === sourceB);
  if (!a) throw new ReplayVerificationError(`submission '${sourceA}' not found`);
  if (!b) throw new ReplayVerificationError(`submission '${sourceB}' not found`);
  const report = compareRunSnapshots(a.snapshot, b.snapshot);
  return {
    pairId: `${sourceA}::${sourceB}`,
    divergent: report.divergent,
    divergenceReport: report,
  };
}

/**
 * Compare ALL submissions to a single reference (typically server-side).
 * Returns array of pair comparisons.
 */
export function compareAllAgainstReference(
  state: VerificationRuntimeState,
  referenceSourceId: string,
): readonly PairComparison[] {
  const ref = state.submissions.find((s) => s.sourceId === referenceSourceId);
  if (!ref) {
    throw new ReplayVerificationError(`reference '${referenceSourceId}' not found`);
  }
  const out: PairComparison[] = [];
  for (const sub of state.submissions) {
    if (sub.sourceId === referenceSourceId) continue;
    const report = compareRunSnapshots(ref.snapshot, sub.snapshot);
    out.push({
      pairId: `${referenceSourceId}::${sub.sourceId}`,
      divergent: report.divergent,
      divergenceReport: report,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────
// Aggregate verification report
// ─────────────────────────────────────────────────────────

export interface VerificationAuditReport {
  schemaVersion: number;
  encounterId: string;
  totalSubmissions: number;
  /** Number of submission pairs compared. */
  totalPairsCompared: number;
  /** Number of divergent pairs. */
  divergentPairs: number;
  /** Detail per divergent pair. */
  divergences: readonly PairComparison[];
  /** Aggregated divergence kinds histogram. */
  divergenceKindCounts: Readonly<Record<string, number>>;
  /** Stable forensic digest of the audit. */
  digest: string;
}

/**
 * Run full audit — compare EVERY submission against the first server-role
 * submission (or first submission if no server present). Returns aggregate
 * report ready for forensic dashboard.
 */
export function runVerificationAudit(
  state: VerificationRuntimeState,
): VerificationAuditReport {
  if (state.submissions.length === 0) {
    return emptyAuditReport(state.encounterId);
  }
  // Pick reference: first 'server' submission OR first overall
  const ref = state.submissions.find((s) => s.role === 'server') ?? state.submissions[0]!;
  const comparisons = compareAllAgainstReference(state, ref.sourceId);

  const divergenceKindCounts: Record<string, number> = {};
  for (const c of comparisons) {
    if (c.divergent) {
      const kind = c.divergenceReport.kind;
      divergenceKindCounts[kind] = (divergenceKindCounts[kind] ?? 0) + 1;
    }
  }

  const divergentPairs = comparisons.filter((c) => c.divergent);
  // R9-6 audit fix: bind divergent pair IDs into the audit digest. Previously
  // the digest source aggregated only COUNTS + kind histogram — so two audits
  // with the same count of divergent pairs but DIFFERENT specific source IDs
  // diverging (e.g. audit A flags client_1, audit B flags client_2) produced
  // IDENTICAL digests. Forensic chain analysis treating digest as audit
  // identity would mistake them for the same audit.
  //
  // Adding sorted divergent pair IDs makes the digest distinguish which pairs
  // diverged while preserving determinism (codepoint sort, no ordering
  // dependence on insertion).
  const divergentPairIds = divergentPairs
    .map((p) => p.pairId)
    .slice()
    .sort();
  const reportForDigest = {
    schemaVersion: REPLAY_VERIFICATION_RUNTIME_SCHEMA_VERSION,
    encounterId: state.encounterId,
    totalSubmissions: state.submissions.length,
    totalPairsCompared: comparisons.length,
    divergentPairs: divergentPairs.length,
    divergenceKindCounts,
    divergentPairIds,
  };
  return {
    schemaVersion: REPLAY_VERIFICATION_RUNTIME_SCHEMA_VERSION,
    encounterId: state.encounterId,
    totalSubmissions: state.submissions.length,
    totalPairsCompared: comparisons.length,
    divergentPairs: divergentPairs.length,
    divergenceKindCounts,
    divergences: divergentPairs,
    digest: canonicalHash(reportForDigest),
  };
}

function emptyAuditReport(encounterId: string): VerificationAuditReport {
  const base = {
    schemaVersion: REPLAY_VERIFICATION_RUNTIME_SCHEMA_VERSION,
    encounterId,
    totalSubmissions: 0,
    totalPairsCompared: 0,
    divergentPairs: 0,
    divergenceKindCounts: {} as Readonly<Record<string, number>>,
  };
  return {
    ...base,
    divergences: [],
    digest: canonicalHash(base),
  };
}

// ─────────────────────────────────────────────────────────
// Drift detection — quick boolean gate
// ─────────────────────────────────────────────────────────

/**
 * Quick gate: returns true iff ANY pair diverges.
 * Use case: server-side anti-cheat — kick client if any drift detected.
 */
export function hasReplayDrift(state: VerificationRuntimeState): boolean {
  if (state.submissions.length < 2) return false;
  const ref = state.submissions.find((s) => s.role === 'server') ?? state.submissions[0]!;
  for (const sub of state.submissions) {
    if (sub.sourceId === ref.sourceId) continue;
    if (compareRunSnapshots(ref.snapshot, sub.snapshot).divergent) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────
// Query helpers
// ─────────────────────────────────────────────────────────

export function submissionCount(state: VerificationRuntimeState): number {
  return state.submissions.length;
}

export function submissionsByRole(
  state: VerificationRuntimeState,
  role: SubmissionRole,
): readonly SubmittedSnapshot[] {
  return state.submissions.filter((s) => s.role === role);
}

export function findSubmission(
  state: VerificationRuntimeState,
  sourceId: string,
): SubmittedSnapshot | undefined {
  return state.submissions.find((s) => s.sourceId === sourceId);
}

/**
 * Stable hash of submission sequence — forensic comparison across runs.
 * Same submission sequence (role + sourceId + snapshot payloadHash) → same hash.
 */
export function submissionSequenceHash(state: VerificationRuntimeState): string {
  let h = 0x811c9dc5 >>> 0;
  const eat = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const sub of state.submissions) {
    eat(`${sub.submissionSeq}|${sub.role}|${sub.sourceId}|${sub.snapshot.payloadHash}`);
  }
  return h.toString(16).padStart(8, '0');
}
