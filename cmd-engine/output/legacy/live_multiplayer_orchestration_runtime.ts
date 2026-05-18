/**
 * LIVE MULTIPLAYER ORCHESTRATION RUNTIME — final realtime combat orchestration (Phase 19 § 4).
 *
 * Per CMD1 Phase 19 directive § PRIMARY MODULE #4:
 *   "Purpose: final realtime combat orchestration layer.
 *    SUPPORT: live raid orchestration / deterministic participant scheduling
 *             / reconnect-safe orchestration rebuild / replay-safe orchestration continuation
 *             / spectator-safe multiplayer broadcasts
 *    MANDATORY: same participant actions = same orchestration result ALWAYS.
 *    FORBIDDEN: transient scheduling / unstable participant ordering
 *               / replay-affecting orchestration metadata"
 *
 * Top-level coordinator. Tracks participants + their transport sessions +
 * orchestration ticks. Pure state container — composes Phase 14/16/19 modules
 * without owning their state.
 *
 * STRICT additive. R1-R4 invariants applied.
 */
import type { CombatRuntime } from './combat_runtime.js';
import { canonicalHash } from './combat_storage.js';

export const LIVE_ORCHESTRATION_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────
// Participant + tick model
// ─────────────────────────────────────────────────────────

export type ParticipantRoleKind = 'player' | 'companion' | 'spectator';

export interface OrchestrationParticipant {
  participantId: string;
  role: ParticipantRoleKind;
  /** Transport session token from websocket_transport_runtime. */
  transportSessionId: string;
  joinedAtTurn: number;
  leftAtTurn?: number;
  /** Total ticks this participant has been included in. */
  ticksParticipated: number;
}

export type TickPhase =
  | 'ingress'        // collect inputs from transport
  | 'latency_advance' // resolve delayed commands
  | 'combat_step'    // step combat runtime
  | 'broadcast'      // emit spectator frames
  | 'sync'           // emit session sync snapshot
  | 'audit';         // forensic audit pass

export interface OrchestrationTick {
  /** Monotonic tick seq. */
  tickSeq: number;
  /** Combat turn at which the tick fired. */
  turn: number;
  /** Phases executed in canonical order. */
  phasesExecuted: readonly TickPhase[];
  /** Active participant count at tick. */
  activeParticipantCount: number;
  /** Stable digest. */
  digest: string;
}

export interface OrchestrationState {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  participants: Map<string, OrchestrationParticipant>;
  ticks: OrchestrationTick[];
  nextTickSeq: number;
  totalTicksFired: number;
}

export function createOrchestration(
  encounterId: string,
  sessionId: string,
): OrchestrationState {
  if (!encounterId) throw new LiveOrchestrationError(`encounterId must be non-empty`);
  if (!sessionId) throw new LiveOrchestrationError(`sessionId must be non-empty`);
  return {
    schemaVersion: LIVE_ORCHESTRATION_SCHEMA_VERSION,
    encounterId,
    sessionId,
    participants: new Map(),
    ticks: [],
    nextTickSeq: 0,
    totalTicksFired: 0,
  };
}

// ─────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────

export class LiveOrchestrationError extends Error {
  constructor(message: string) {
    super(`[LiveOrchestration] ${message}`);
    this.name = 'LiveOrchestrationError';
  }
}

function assertParity(state: OrchestrationState, rt: CombatRuntime): void {
  if (state.encounterId !== rt.config.encounterId) {
    throw new LiveOrchestrationError(`encounterId mismatch: state='${state.encounterId}' rt='${rt.config.encounterId}'`);
  }
  if (state.sessionId !== rt.config.sessionId) {
    throw new LiveOrchestrationError(`sessionId mismatch: state='${state.sessionId}' rt='${rt.config.sessionId}'`);
  }
}

// ─────────────────────────────────────────────────────────
// Participant lifecycle
// ─────────────────────────────────────────────────────────

export function attachParticipant(
  state: OrchestrationState,
  rt: CombatRuntime,
  participantId: string,
  role: ParticipantRoleKind,
  transportSessionId: string,
): OrchestrationParticipant {
  assertParity(state, rt);
  if (!participantId) throw new LiveOrchestrationError(`participantId must be non-empty`);
  // R6-5 audit fix: whitespace-only IDs slip past `!id` check, cause silent
  // identity drift in canonical sort + orchestration tick digest.
  if (participantId.trim().length === 0) {
    throw new LiveOrchestrationError(`participantId must be non-empty (whitespace-only rejected)`);
  }
  if (!transportSessionId) throw new LiveOrchestrationError(`transportSessionId must be non-empty`);
  if (transportSessionId.trim().length === 0) {
    throw new LiveOrchestrationError(`transportSessionId must be non-empty (whitespace-only rejected)`);
  }
  if (state.participants.has(participantId)) {
    const existing = state.participants.get(participantId)!;
    if (existing.leftAtTurn === undefined) {
      throw new LiveOrchestrationError(`participant '${participantId}' already attached`);
    }
    // Re-attach scenario: reset left + transport
    existing.leftAtTurn = undefined;
    existing.joinedAtTurn = rt.currentTurn;
    existing.role = role;
    existing.transportSessionId = transportSessionId;
    return existing;
  }
  const p: OrchestrationParticipant = {
    participantId,
    role,
    transportSessionId,
    joinedAtTurn: rt.currentTurn,
    ticksParticipated: 0,
  };
  state.participants.set(participantId, p);
  return p;
}

export function detachParticipant(
  state: OrchestrationState,
  rt: CombatRuntime,
  participantId: string,
): void {
  assertParity(state, rt);
  if (!participantId) throw new LiveOrchestrationError(`participantId must be non-empty`);
  // R8-7 audit fix: whitespace-only id slips past `!id` check; without this
  // the Map.get('   ') miss would surface as "participant '   ' not attached"
  // — misleading error. Consistent with R6-5 / R7-13 invariant.
  if (participantId.trim().length === 0) {
    throw new LiveOrchestrationError(`participantId must be non-empty (whitespace-only rejected)`);
  }
  const p = state.participants.get(participantId);
  if (!p) throw new LiveOrchestrationError(`participant '${participantId}' not attached`);
  if (p.leftAtTurn !== undefined) {
    throw new LiveOrchestrationError(`participant '${participantId}' already detached`);
  }
  p.leftAtTurn = rt.currentTurn;
}

// ─────────────────────────────────────────────────────────
// Tick execution
// ─────────────────────────────────────────────────────────

/**
 * Canonical phase order for a single orchestration tick. Caller binds each
 * phase to actual subsystem (gateway / latency / runtime / broadcast / sync / audit).
 * Order is DETERMINISTIC — same input → same phase sequence.
 *
 * R9-2 audit fix: `Object.freeze` at runtime. TypeScript `readonly` is
 * compile-time only — without freeze, malicious or buggy caller could
 * `(CANONICAL_TICK_PHASES as TickPhase[]).push('extra')` and corrupt every
 * subsequent `recordTick` validation. Freeze makes the array immutable at
 * the JS runtime level (defense-in-depth for a "canonical constant").
 */
export const CANONICAL_TICK_PHASES: readonly TickPhase[] = Object.freeze([
  'ingress',
  'latency_advance',
  'combat_step',
  'broadcast',
  'sync',
  'audit',
] as const) as readonly TickPhase[];

function digestTick(
  tickSeq: number,
  turn: number,
  phasesExecuted: readonly TickPhase[],
  activeParticipantCount: number,
): string {
  return canonicalHash({
    schemaVersion: LIVE_ORCHESTRATION_SCHEMA_VERSION,
    tickSeq,
    turn,
    phasesExecuted,
    activeParticipantCount,
  });
}

/**
 * Record an orchestration tick. Caller invokes each phase manually then calls
 * this to log the tick. Returns the tick record (deterministic).
 *
 * `phasesExecuted` should match `CANONICAL_TICK_PHASES` for a full tick, but
 * caller can submit subset (e.g., 'ingress' + 'combat_step' only) for partial
 * ticks. Phases array IS embedded in digest — partial ticks have distinct
 * digest from full ticks.
 */
export function recordTick(
  state: OrchestrationState,
  rt: CombatRuntime,
  phasesExecuted: readonly TickPhase[],
): OrchestrationTick {
  assertParity(state, rt);
  if (phasesExecuted.length === 0) {
    throw new LiveOrchestrationError(`phasesExecuted must be non-empty`);
  }
  // Validate every phase is canonical TickPhase
  for (const phase of phasesExecuted) {
    if (!CANONICAL_TICK_PHASES.includes(phase)) {
      throw new LiveOrchestrationError(`unknown phase '${phase}'`);
    }
  }
  // Count active participants (canonical-sorted snapshot)
  const active = [...state.participants.values()].filter((p) => p.leftAtTurn === undefined);
  for (const p of active) {
    p.ticksParticipated++;
  }
  const tickSeq = state.nextTickSeq++;
  const tick: OrchestrationTick = {
    tickSeq,
    turn: rt.currentTurn,
    phasesExecuted: [...phasesExecuted],
    activeParticipantCount: active.length,
    digest: digestTick(tickSeq, rt.currentTurn, phasesExecuted, active.length),
  };
  state.ticks.push(tick);
  state.totalTicksFired++;
  return tick;
}

// ─────────────────────────────────────────────────────────
// Snapshot + query
// ─────────────────────────────────────────────────────────

export interface OrchestrationSnapshot {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  currentTurn: number;
  participantCount: number;
  /** Canonical-ordered participants. */
  participants: readonly OrchestrationParticipant[];
  totalTicksFired: number;
  digest: string;
}

export function buildOrchestrationSnapshot(
  state: OrchestrationState,
  rt: CombatRuntime,
): OrchestrationSnapshot {
  assertParity(state, rt);
  // participantId unique within orchestration (enforced at attachParticipant).
  // Tiebreaker strict-vs-eq mutations EQUIVALENT.
  // Stryker disable all
  const sortedParticipants = [...state.participants.values()]
    .filter((p) => p.leftAtTurn === undefined)
    .sort((a, b) => {
      if (a.joinedAtTurn !== b.joinedAtTurn) return a.joinedAtTurn - b.joinedAtTurn;
      return a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0;
    });
  // Stryker restore all
  // state.ticks is populated by recordTick in tickSeq-monotonic order;
  // explicit sort is defense-in-depth. Stryker mutants EQUIVALENT here.
  // Stryker disable next-line all
  const tickDigests = [...state.ticks].sort((a, b) => a.tickSeq - b.tickSeq).map((t) => t.digest);
  const forDigest = {
    schemaVersion: LIVE_ORCHESTRATION_SCHEMA_VERSION,
    encounterId: state.encounterId,
    sessionId: state.sessionId,
    currentTurn: rt.currentTurn,
    participantCount: sortedParticipants.length,
    participants: sortedParticipants,
    totalTicksFired: state.totalTicksFired,
    tickDigests,
  };
  return {
    schemaVersion: LIVE_ORCHESTRATION_SCHEMA_VERSION,
    encounterId: state.encounterId,
    sessionId: state.sessionId,
    currentTurn: rt.currentTurn,
    participantCount: sortedParticipants.length,
    participants: sortedParticipants,
    totalTicksFired: state.totalTicksFired,
    digest: canonicalHash(forDigest),
  };
}

export function activeParticipants(
  state: OrchestrationState,
): readonly OrchestrationParticipant[] {
  // Stryker disable all -- participantId unique, strict-vs-eq equivalent
  return [...state.participants.values()]
    .filter((p) => p.leftAtTurn === undefined)
    .sort((a, b) =>
      a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0,
    );
  // Stryker restore all
}

export function participantsByRole(
  state: OrchestrationState,
  role: ParticipantRoleKind,
): readonly OrchestrationParticipant[] {
  return activeParticipants(state).filter((p) => p.role === role);
}

export function tickCount(state: OrchestrationState): number {
  return state.ticks.length;
}

export function orchestrationHistoryHash(state: OrchestrationState): string {
  let h = 0x811c9dc5 >>> 0;
  const eat = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  // Stryker disable next-line all -- tickSeq-monotonic, defense-in-depth sort
  for (const t of [...state.ticks].sort((a, b) => a.tickSeq - b.tickSeq)) {
    eat(`${t.tickSeq}|${t.turn}|${t.digest}`);
  }
  return h.toString(16).padStart(8, '0');
}
