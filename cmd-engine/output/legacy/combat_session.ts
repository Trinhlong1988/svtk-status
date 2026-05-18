/**
 * COMBAT SESSION — combat lifecycle envelope (Phase 5).
 *
 * Extends EncounterManager with session boundary tracking:
 *   - session id (UUID-like, deterministic from encounterId + start turn + counter)
 *   - duration cap (anti zombie session)
 *   - heartbeat (telemetry interval)
 *   - state machine: idle → active → wipe/leashed/disengaged/ended
 *
 * CMD1 FIX #3 — session id format includes sessionCounter to avoid collision
 * when same encounter restarts at same turn (rollback / reconnect / world boss reset).
 * Format: `${encounterId}@t${startTurn}#${sessionCounter}` (e.g., `e1@t5#2`).
 *
 * Pure data + helpers. EncounterManager holds CombatSession in context.
 */
import { NpcConstants } from './npc_constants.js';

export type CombatSessionState =
  | 'idle'
  | 'active'
  | 'wipe'
  | 'leashed'
  | 'disengaged'
  | 'ended';

export interface CombatSession {
  /** Deterministic session id. */
  sessionId: string;
  /** Owner encounter id. */
  encounterId: string;
  /** Session state. */
  state: CombatSessionState;
  /** Start turn. */
  startTurn: number;
  /** Session counter (CMD1 FIX #3 — anti-collision when restarting at same turn). */
  sessionCounter: number;
  /** End turn (set on transition to wipe/leashed/disengaged/ended). */
  endTurn?: number;
  /** Last heartbeat turn (for telemetry interval). */
  lastHeartbeatTurn: number;
  /** Reason for end (telemetry). */
  endReason?: 'wipe' | 'leash' | 'disengage' | 'victory' | 'timeout';
}

/**
 * Create deterministic sessionId from encounterId + start turn + counter.
 * Format: `${encounterId}@t${startTurn}#${sessionCounter}` (CMD1 FIX #3).
 *
 * sessionCounter MUST be unique per (encounterId, startTurn) tuple to avoid
 * collision across rollback / reconnect / replay archive / world boss reset.
 */
export function makeSessionId(
  encounterId: string,
  startTurn: number,
  sessionCounter: number = 0,
): string {
  return `${encounterId}@t${startTurn}#${sessionCounter}`;
}

export function createCombatSession(
  encounterId: string,
  startTurn: number,
  sessionCounter: number = 0,
): CombatSession {
  return {
    sessionId: makeSessionId(encounterId, startTurn, sessionCounter),
    encounterId,
    state: 'idle',
    startTurn,
    sessionCounter,
    lastHeartbeatTurn: startTurn,
  };
}

/**
 * Per-encounter session counter — caller (EncounterManager / world runtime)
 * owns the state and increments before each createCombatSession call.
 */
export interface SessionCounterState {
  /** Next counter value per encounterId. */
  byEncounter: Map<string, number>;
}

export function createSessionCounterState(): SessionCounterState {
  return { byEncounter: new Map() };
}

export function nextSessionCounter(state: SessionCounterState, encounterId: string): number {
  const cur = state.byEncounter.get(encounterId) ?? 0;
  state.byEncounter.set(encounterId, cur + 1);
  return cur;
}

export function startSession(session: CombatSession, currentTurn: number): void {
  session.state = 'active';
  session.startTurn = currentTurn;
  session.lastHeartbeatTurn = currentTurn;
}

export function transitionSession(
  session: CombatSession,
  to: CombatSessionState,
  currentTurn: number,
  reason?: CombatSession['endReason'],
): void {
  session.state = to;
  if (to === 'wipe' || to === 'leashed' || to === 'disengaged' || to === 'ended') {
    session.endTurn = currentTurn;
    if (reason) session.endReason = reason;
  }
}

/** Check session timeout (anti zombie). */
export function isSessionTimedOut(session: CombatSession, currentTurn: number): boolean {
  if (session.state !== 'active') return false;
  return currentTurn - session.startTurn >= NpcConstants.COMBAT_SESSION_MAX_DURATION_TURNS;
}

/** Should fire heartbeat telemetry? */
export function isHeartbeatDue(session: CombatSession, currentTurn: number): boolean {
  return currentTurn - session.lastHeartbeatTurn >= NpcConstants.COMBAT_SESSION_HEARTBEAT_TURNS;
}

export function recordHeartbeat(session: CombatSession, currentTurn: number): void {
  session.lastHeartbeatTurn = currentTurn;
}

/** Snapshot for replay. */
export function snapshotSession(session: CombatSession): CombatSession {
  return { ...session };
}

/** Restore from snapshot. */
export function restoreSession(snap: CombatSession): CombatSession {
  return { ...snap };
}
