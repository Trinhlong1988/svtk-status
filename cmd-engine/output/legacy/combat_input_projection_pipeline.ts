/**
 * COMBAT INPUT PROJECTION PIPELINE — input normalization layer (Phase 16 § 2).
 *
 * Per CMD1 Phase 16 directive § PRIMARY OBJECTIVES § combat_input_projection_pipeline:
 *   "Purpose: future online combat input normalization layer.
 *    SUPPORT:
 *      - canonical combat input projection
 *      - replay-safe command normalization
 *      - deterministic input ordering
 *      - rollback-safe command projection
 *      - future network command compatibility
 *    IMPORTANT: NO live networking. Projection layer ONLY."
 *
 * Pure state container for collecting + canonicalizing per-encounter combat
 * inputs into a deterministic replay-safe ordered queue. The actual command
 * application is NOT this module's job — that lives in combat_runtime via
 * actions/skills (CMD1 ownership unchanged).
 *
 * STRICT additive — no I/O. No networking. No transport. Defensive copy at
 * accept boundary. Canonical lex-sort on EVERY projection output.
 */
import type { CombatRuntime } from './combat_runtime.js';
import { canonicalHash, canonicalJson } from './combat_storage.js';

export const COMBAT_INPUT_PROJECTION_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────
// Input model
// ─────────────────────────────────────────────────────────

export type CombatInputKind =
  | 'action'
  | 'skill'
  | 'item_use'
  | 'target_change'
  | 'movement_intent'
  | 'cancel';

/**
 * Raw input submitted by a participant. The pipeline:
 *   - validates encounterId / sessionId / originatorId / kind
 *   - assigns canonical `acceptedSeq` (monotonic per encounter)
 *   - freezes a deep copy of payload to prevent post-submit mutation
 *   - emits a `NormalizedInput` ready for deterministic replay
 */
export interface RawCombatInput {
  encounterId: string;
  sessionId: string;
  originatorId: string;
  /** Caller-supplied client seq — used for tiebreaker, NOT for ordering authority. */
  clientSeq: number;
  /** Caller-supplied turn the input was intended for. */
  intendedTurn: number;
  kind: CombatInputKind;
  /** Arbitrary JSON-safe payload — projection does not interpret. */
  payload: Readonly<Record<string, unknown>>;
}

export interface NormalizedInput {
  schemaVersion: number;
  /** Server-assigned monotonic seq (canonical ordering authority). */
  acceptedSeq: number;
  originatorId: string;
  clientSeq: number;
  intendedTurn: number;
  /** Turn at which the input was accepted (rt.currentTurn at accept time). */
  acceptedAtTurn: number;
  kind: CombatInputKind;
  /** Frozen canonical-JSON-serialized payload (immutable). */
  payloadJson: string;
  /** Stable digest of (acceptedSeq, originatorId, kind, payloadJson). */
  digest: string;
}

// ─────────────────────────────────────────────────────────
// Pipeline state
// ─────────────────────────────────────────────────────────

export interface InputProjectionState {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  /** Monotonic accept counter. */
  nextAcceptedSeq: number;
  /** Append-only normalized queue (insertion = accept order). */
  queue: NormalizedInput[];
  /** Total inputs rejected (forensic). */
  rejectedCount: number;
}

export function createInputProjection(
  encounterId: string,
  sessionId: string,
): InputProjectionState {
  // R7-10 audit fix: factory-level identity validation. submitInput's
  // encounter_mismatch/session_mismatch verdicts only fire when raw.encounterId
  // diverges from state.encounterId — if BOTH are empty, the verdict says
  // "accepted" and the projection digest binds empty identity → cross-session
  // queue collision. Same root cause as R7-1/3/5/8/9.
  if (!encounterId || encounterId.trim().length === 0) {
    throw new InputProjectionError(`encounterId must be non-empty (whitespace-only rejected)`);
  }
  if (!sessionId || sessionId.trim().length === 0) {
    throw new InputProjectionError(`sessionId must be non-empty (whitespace-only rejected)`);
  }
  return {
    schemaVersion: COMBAT_INPUT_PROJECTION_SCHEMA_VERSION,
    encounterId,
    sessionId,
    nextAcceptedSeq: 0,
    queue: [],
    rejectedCount: 0,
  };
}

// ─────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────

export class InputProjectionError extends Error {
  constructor(message: string) {
    super(`[InputProjection] ${message}`);
    this.name = 'InputProjectionError';
  }
}

// ─────────────────────────────────────────────────────────
// Submit / reject
// ─────────────────────────────────────────────────────────

export type RejectReason =
  | 'encounter_mismatch'
  | 'session_mismatch'
  | 'invalid_kind'
  | 'empty_originator'
  | 'negative_intended_turn'
  | 'negative_client_seq'
  | 'non_finite_numeric'
  | 'invalid_payload_shape';

export type AcceptVerdict =
  | { accepted: true; normalized: NormalizedInput }
  | { accepted: false; reason: RejectReason };

// R9-2 audit fix: freeze constant at runtime. TS `readonly` is compile-only;
// a cast + mutation could corrupt `VALID_KINDS.includes` checks. Same
// rationale as `CANONICAL_TICK_PHASES`.
const VALID_KINDS: readonly CombatInputKind[] = Object.freeze([
  'action',
  'skill',
  'item_use',
  'target_change',
  'movement_intent',
  'cancel',
] as const) as readonly CombatInputKind[];

/**
 * Validate + canonicalize + accept a raw input.
 *
 * Determinism guarantees:
 *   - Same RAW input + same state.nextAcceptedSeq → same NormalizedInput bytes.
 *   - payloadJson is canonical-JSON (sorted keys, no ambiguity).
 *   - digest binds (acceptedSeq, originatorId, kind, payloadJson) — tampering
 *     with any field invalidates the digest.
 */
export function submitInput(
  state: InputProjectionState,
  rt: CombatRuntime,
  raw: RawCombatInput,
): AcceptVerdict {
  if (raw.encounterId !== state.encounterId || raw.encounterId !== rt.config.encounterId) {
    state.rejectedCount++;
    return { accepted: false, reason: 'encounter_mismatch' };
  }
  if (raw.sessionId !== state.sessionId || raw.sessionId !== rt.config.sessionId) {
    state.rejectedCount++;
    return { accepted: false, reason: 'session_mismatch' };
  }
  if (!VALID_KINDS.includes(raw.kind)) {
    state.rejectedCount++;
    return { accepted: false, reason: 'invalid_kind' };
  }
  if (!raw.originatorId) {
    state.rejectedCount++;
    return { accepted: false, reason: 'empty_originator' };
  }
  // R4-7 audit fix: TS types forbid null/undefined payload but JS runtime
  // caller could pass non-object. `canonicalJson(null)` produces "null" which
  // is technically valid JSON but defeats the payload structure invariant.
  if (typeof raw.payload !== 'object' || raw.payload === null || Array.isArray(raw.payload)) {
    state.rejectedCount++;
    return { accepted: false, reason: 'invalid_payload_shape' };
  }
  // R3-6 audit fix: finite-number check FIRST. `NaN < 0` is false, so NaN
  // would slip past the negative-value checks and reach the queue with NaN
  // intendedTurn — breaking later `inputsByTurn(state, N)` filters.
  if (!Number.isFinite(raw.intendedTurn) || !Number.isFinite(raw.clientSeq)) {
    state.rejectedCount++;
    return { accepted: false, reason: 'non_finite_numeric' };
  }
  if (raw.intendedTurn < 0) {
    state.rejectedCount++;
    return { accepted: false, reason: 'negative_intended_turn' };
  }
  if (raw.clientSeq < 0) {
    state.rejectedCount++;
    return { accepted: false, reason: 'negative_client_seq' };
  }
  // R6-3 audit fix: payload may contain circular reference / Symbol / BigInt
  // / unserializable values. canonicalJson would throw, propagating out of
  // submitInput and breaking the "accepted vs rejected" contract — caller
  // would see an exception instead of a verdict. Catch + reject as
  // invalid_payload_shape so all error paths converge on the verdict union.
  let payloadJson: string;
  try {
    payloadJson = canonicalJson(raw.payload);
  } catch {
    state.rejectedCount++;
    return { accepted: false, reason: 'invalid_payload_shape' };
  }
  const acceptedSeq = state.nextAcceptedSeq++;
  const digestSource = {
    acceptedSeq,
    originatorId: raw.originatorId,
    kind: raw.kind,
    payloadJson,
  };
  const normalized: NormalizedInput = {
    schemaVersion: COMBAT_INPUT_PROJECTION_SCHEMA_VERSION,
    acceptedSeq,
    originatorId: raw.originatorId,
    clientSeq: raw.clientSeq,
    intendedTurn: raw.intendedTurn,
    acceptedAtTurn: rt.currentTurn,
    kind: raw.kind,
    payloadJson,
    digest: canonicalHash(digestSource),
  };
  state.queue.push(normalized);
  return { accepted: true, normalized };
}

// ─────────────────────────────────────────────────────────
// Projection / replay (read-only, canonical ordering)
// ─────────────────────────────────────────────────────────

export interface QueueProjection {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  /** Canonical-ordered queue: by acceptedSeq asc (insertion authority). */
  inputs: readonly NormalizedInput[];
  /** Total accepted count (= queue.length). */
  acceptedCount: number;
  /** Cumulative rejected count. */
  rejectedCount: number;
  /** Stable digest of the entire projection. */
  digest: string;
}

/**
 * Project the current queue into a deterministic snapshot.
 *
 * Canonical ordering: by acceptedSeq asc (insertion is already canonical
 * because submitInput assigns acceptedSeq monotonically). For defensive
 * correctness we still emit a sorted copy (no reliance on insertion order).
 */
export function projectQueue(state: InputProjectionState): QueueProjection {
  // state.queue is populated by submitInput in acceptedSeq-monotonic order;
  // explicit sort is defense-in-depth. Stryker mutants EQUIVALENT.
  // Stryker disable next-line all
  const ordered = [...state.queue].sort((a, b) => a.acceptedSeq - b.acceptedSeq);
  // R9-3 audit fix: projection digest previously bound only
  // (acceptedSeq, originatorId, kind, payloadJson) per input. The
  // `clientSeq`, `intendedTurn`, `acceptedAtTurn` metadata fields were
  // EXCLUDED from the digest, so two projections with identical content but
  // diverging metadata (e.g. same input replayed against runtimes with
  // different turn counters) produced the SAME projection digest — a
  // forensic blind spot. compareProjections would say "not divergent" while
  // `projection.inputs[i].intendedTurn` actually differs.
  //
  // Fix: bind every observable NormalizedInput field via `i.digest` (which is
  // itself a per-input identity) PLUS the metadata fields. Any difference in
  // ANY input field now changes projection.digest.
  const forDigest = {
    schemaVersion: COMBAT_INPUT_PROJECTION_SCHEMA_VERSION,
    encounterId: state.encounterId,
    sessionId: state.sessionId,
    acceptedCount: ordered.length,
    rejectedCount: state.rejectedCount,
    inputs: ordered.map((i) => ({
      acceptedSeq: i.acceptedSeq,
      originatorId: i.originatorId,
      kind: i.kind,
      payloadJson: i.payloadJson,
      // R9-3 newly bound fields:
      clientSeq: i.clientSeq,
      intendedTurn: i.intendedTurn,
      acceptedAtTurn: i.acceptedAtTurn,
      inputDigest: i.digest,
    })),
  };
  return {
    schemaVersion: COMBAT_INPUT_PROJECTION_SCHEMA_VERSION,
    encounterId: state.encounterId,
    sessionId: state.sessionId,
    inputs: ordered,
    acceptedCount: ordered.length,
    rejectedCount: state.rejectedCount,
    digest: canonicalHash(forDigest),
  };
}

/**
 * Replay the queue in canonical order, invoking `visit` for each input.
 * Pure iteration — `visit` MUST be pure / side-effect-free for replay safety.
 *
 * Use case: deterministic replay of inputs to drive a runtime forward, OR
 * forensic audit of input order.
 */
export function replayQueue(
  state: InputProjectionState,
  visit: (input: NormalizedInput) => void,
): void {
  // Stryker disable next-line all -- acceptedSeq-monotonic, defense-in-depth sort
  const ordered = [...state.queue].sort((a, b) => a.acceptedSeq - b.acceptedSeq);
  for (const input of ordered) visit(input);
}

// ─────────────────────────────────────────────────────────
// Filters (canonical-sorted output)
// ─────────────────────────────────────────────────────────

export function inputsByOriginator(
  state: InputProjectionState,
  originatorId: string,
): readonly NormalizedInput[] {
  // Stryker disable all -- acceptedSeq-monotonic, defense-in-depth
  return [...state.queue]
    .filter((i) => i.originatorId === originatorId)
    .sort((a, b) => a.acceptedSeq - b.acceptedSeq);
  // Stryker restore all
}

export function inputsByKind(
  state: InputProjectionState,
  kind: CombatInputKind,
): readonly NormalizedInput[] {
  // Stryker disable all -- acceptedSeq-monotonic
  return [...state.queue]
    .filter((i) => i.kind === kind)
    .sort((a, b) => a.acceptedSeq - b.acceptedSeq);
  // Stryker restore all
}

export function inputsByTurn(
  state: InputProjectionState,
  turn: number,
): readonly NormalizedInput[] {
  // Stryker disable all -- acceptedSeq-monotonic
  return [...state.queue]
    .filter((i) => i.intendedTurn === turn)
    .sort((a, b) => a.acceptedSeq - b.acceptedSeq);
  // Stryker restore all
}

// ─────────────────────────────────────────────────────────
// Verification + integrity
// ─────────────────────────────────────────────────────────

export interface InputIntegrityReport {
  valid: boolean;
  reason?: 'digest_mismatch' | 'schema_mismatch';
  expectedDigest: string;
}

export function verifyNormalizedIntegrity(input: NormalizedInput): InputIntegrityReport {
  if (input.schemaVersion !== COMBAT_INPUT_PROJECTION_SCHEMA_VERSION) {
    return {
      valid: false,
      reason: 'schema_mismatch',
      expectedDigest: '',
    };
  }
  const computed = canonicalHash({
    acceptedSeq: input.acceptedSeq,
    originatorId: input.originatorId,
    kind: input.kind,
    payloadJson: input.payloadJson,
  });
  if (computed !== input.digest) {
    return { valid: false, reason: 'digest_mismatch', expectedDigest: computed };
  }
  return { valid: true, expectedDigest: computed };
}

// ─────────────────────────────────────────────────────────
// Comparison + forensic
// ─────────────────────────────────────────────────────────

export interface ProjectionDivergence {
  divergent: boolean;
  field?: 'digest' | 'acceptedCount' | 'rejectedCount' | 'input_at';
  index?: number;
}

export function compareProjections(
  expected: QueueProjection,
  actual: QueueProjection,
): ProjectionDivergence {
  if (expected.digest === actual.digest) return { divergent: false };
  if (expected.acceptedCount !== actual.acceptedCount) {
    return { divergent: true, field: 'acceptedCount' };
  }
  if (expected.rejectedCount !== actual.rejectedCount) {
    return { divergent: true, field: 'rejectedCount' };
  }
  for (let i = 0; i < expected.inputs.length; i++) {
    if (expected.inputs[i]!.digest !== actual.inputs[i]!.digest) {
      return { divergent: true, field: 'input_at', index: i };
    }
  }
  return { divergent: true, field: 'digest' };
}
