/**
 * LEASH SYSTEM — chase / disengage / return-to-origin (Phase 5).
 *
 * Boss/NPC must not chase player indefinitely. When attacker exceeds
 * LEASH_CHASE_DISTANCE OR boss idle ≥ DISENGAGE_TURNS, leash fires:
 *   - threat wipe
 *   - companion reset
 *   - formation reset
 *   - boss returns to origin (movement scheduled per turn)
 *
 * Fully deterministic (no wall-clock).
 */
import type { Position } from './spatial_threat.js';
import { chebyshevDistance } from './spatial_threat.js';
import { NpcConstants } from './npc_constants.js';

export type LeashStatus = 'in_combat' | 'chasing' | 'disengaging' | 'returning' | 'reset';

export interface LeashState {
  bossId: string;
  origin: Position;
  currentPosition: Position;
  status: LeashStatus;
  /** Last turn boss took action (for disengage detect). */
  lastActionTurn: number;
  /** Override for chase distance (per-boss). */
  chaseDistanceOverride?: number;
  /** Override for disengage turns. */
  disengageOverride?: number;
}

export interface LeashUpdateResult {
  newStatus: LeashStatus;
  shouldWipeThreat: boolean;
  shouldResetFormation: boolean;
  shouldResetCompanion: boolean;
  returnedToOrigin: boolean;
}

/**
 * Update leash state per turn. Returns flags for caller to consume.
 *
 * Pure-ish: mutates `state.status` + `state.currentPosition` directly.
 */
export function updateLeash(state: LeashState, currentTurn: number): LeashUpdateResult {
  const chaseDist = state.chaseDistanceOverride ?? NpcConstants.LEASH_CHASE_DISTANCE;
  const disengageTurns = state.disengageOverride ?? NpcConstants.LEASH_DISENGAGE_TURNS;
  const distFromOrigin = chebyshevDistance(state.currentPosition, state.origin);
  const idleTurns = currentTurn - state.lastActionTurn;

  // Already at origin = reset state
  if (state.status === 'returning' && distFromOrigin === 0) {
    state.status = 'reset';
    return makeResult('reset', false, false, false, true);
  }

  // Returning — step toward origin
  if (state.status === 'returning') {
    stepToOrigin(state);
    return makeResult('returning', false, false, false, false);
  }

  // Detect chase distance exceeded
  if (distFromOrigin > chaseDist) {
    state.status = 'disengaging';
    return makeResult('disengaging', true, true, true, false);
  }

  // Detect idle disengage
  if (idleTurns >= disengageTurns && state.status === 'in_combat') {
    state.status = 'disengaging';
    return makeResult('disengaging', true, true, true, false);
  }

  // Disengaging → start return next turn
  if (state.status === 'disengaging') {
    state.status = 'returning';
    return makeResult('returning', false, false, false, false);
  }

  return makeResult(state.status, false, false, false, false);
}

function makeResult(
  newStatus: LeashStatus,
  wipeThreat: boolean,
  resetFormation: boolean,
  resetCompanion: boolean,
  returned: boolean,
): LeashUpdateResult {
  return {
    newStatus,
    shouldWipeThreat: wipeThreat,
    shouldResetFormation: resetFormation,
    shouldResetCompanion: resetCompanion,
    returnedToOrigin: returned,
  };
}

/** Move state.currentPosition toward state.origin by LEASH_RETURN_SPEED_PER_TURN cells. */
function stepToOrigin(state: LeashState): void {
  const speed = NpcConstants.LEASH_RETURN_SPEED_PER_TURN;
  const dx = signOf(state.origin.x - state.currentPosition.x);
  const dy = signOf(state.origin.y - state.currentPosition.y);
  const remainingX = Math.abs(state.origin.x - state.currentPosition.x);
  const remainingY = Math.abs(state.origin.y - state.currentPosition.y);
  state.currentPosition.x += dx * Math.min(speed, remainingX);
  state.currentPosition.y += dy * Math.min(speed, remainingY);
}

function signOf(n: number): number {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

/** Construct fresh state. */
export function createLeashState(bossId: string, origin: Position, currentTurn: number): LeashState {
  return {
    bossId,
    origin: { ...origin },
    currentPosition: { ...origin },
    status: 'in_combat',
    lastActionTurn: currentTurn,
  };
}
