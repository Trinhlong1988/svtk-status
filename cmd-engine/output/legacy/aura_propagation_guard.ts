/**
 * AURA PROPAGATION GUARD — anti-recursion (Phase 2 FH FIX #7).
 *
 * PROBLEM (CMD1.docx):
 *   Block:
 *     - recursive aura spread        (A's aura grants target B's aura → grants target A)
 *     - companion aura loop          (owner ↔ companion infinite re-spread)
 *     - aura re-trigger spam         (same aura tick'ing N times in one resolution)
 *     - infinite passive propagation (passive that fires on apply → applies same passive)
 *
 * GUARDS (4 layers):
 *
 *   1. PER-SOURCE VISIT SET — within ONE propagation chain, an aura cannot re-visit
 *      the same source.
 *
 *   2. PER-AURA TICK BUDGET — within ONE turn, a given (auraType, sourceId) emits
 *      AT MOST `MAX_AURA_TICKS_PER_TURN` (default 1). Catches re-trigger spam.
 *
 *   3. CHAIN DEPTH CAP — propagation depth bounded by `MAX_AURA_PROPAGATION_DEPTH`
 *      (default 3). Companion / owner share counts toward depth.
 *
 *   4. OWNER-COMPANION PAIR DEDUP — once aura X applied to (owner, companion) pair
 *      within the current chain, blocked from re-application this chain.
 *
 * Pure data. Caller (encounter manager) holds 1 `AuraGuardState` per encounter.
 * `tryPropagateAura` returns approve/reject deterministically; never throws.
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

export const MAX_AURA_PROPAGATION_DEPTH = 3 as const;
export const MAX_AURA_TICKS_PER_TURN = 1 as const;

// ─────────────────────────────────────────────────────────
// Reject reasons
// ─────────────────────────────────────────────────────────

export const AuraRejectReasonSchema = z.enum([
  'visited_source',
  'tick_budget',
  'depth_exceeded',
  'pair_already_applied',
]);
export type AuraRejectReason = z.infer<typeof AuraRejectReasonSchema>;

export type AuraPropagateOutcome =
  | { ok: true }
  | { ok: false; reason: AuraRejectReason };

// ─────────────────────────────────────────────────────────
// Guard state
// ─────────────────────────────────────────────────────────

/**
 * Per-encounter aura guard. Caller resets each turn via `tickAuraGuard()`.
 */
export interface AuraGuardState {
  encounterId: string;
  /** Visited sources within current chain. Cleared by `endChain()`. */
  visitedSources: Set<string>;
  /** (auraType:sourceId) → tick count this turn. */
  ticksThisTurn: Map<string, number>;
  /** (auraType:ownerId:companionId) → applied this chain. */
  pairThisChain: Set<string>;
  /** Current chain depth. */
  chainDepth: number;
  /** Telemetry — rejected count by reason. */
  rejectedByReason: Map<AuraRejectReason, number>;
  /** Current turn (for tick budget keyed by turn). */
  currentTurn: number;
}

export function createAuraGuard(encounterId: string): AuraGuardState {
  return {
    encounterId,
    visitedSources: new Set(),
    ticksThisTurn: new Map(),
    pairThisChain: new Set(),
    chainDepth: 0,
    rejectedByReason: new Map(),
    currentTurn: 0,
  };
}

/** Turn boundary — reset per-turn caps. */
export function tickAuraGuard(state: AuraGuardState, currentTurn: number): void {
  if (currentTurn !== state.currentTurn) {
    state.ticksThisTurn.clear();
    state.currentTurn = currentTurn;
  }
  endChain(state);
}

/** Begin a propagation chain — caller invokes at root aura emit. */
export function beginChain(state: AuraGuardState): void {
  state.visitedSources.clear();
  state.pairThisChain.clear();
  state.chainDepth = 0;
}

/** End chain — clear per-chain dedup state. */
export function endChain(state: AuraGuardState): void {
  state.visitedSources.clear();
  state.pairThisChain.clear();
  state.chainDepth = 0;
}

// ─────────────────────────────────────────────────────────
// Propagation check
// ─────────────────────────────────────────────────────────

export interface AuraPropagateInput {
  auraType: string;
  sourceId: string;
  ownerId?: string;
  companionId?: string;
  /** Current chain depth (caller bumps each recursion). */
  depth: number;
}

/**
 * Check guards. Returns ok/false-with-reason. Side effects (commit to state)
 * happen on success.
 */
export function tryPropagateAura(
  state: AuraGuardState,
  input: AuraPropagateInput,
): AuraPropagateOutcome {
  // 1. Depth cap
  if (input.depth > MAX_AURA_PROPAGATION_DEPTH) {
    return rejectAura(state, 'depth_exceeded');
  }
  // 2. Visited source check
  if (state.visitedSources.has(input.sourceId)) {
    return rejectAura(state, 'visited_source');
  }
  // 3. Tick budget per (aura, source) per turn
  const tickKey = `${input.auraType}::${input.sourceId}`;
  const ticks = state.ticksThisTurn.get(tickKey) ?? 0;
  if (ticks >= MAX_AURA_TICKS_PER_TURN) {
    return rejectAura(state, 'tick_budget');
  }
  // 4. Owner-companion pair dedup
  if (input.ownerId && input.companionId) {
    const pairKey = `${input.auraType}::${input.ownerId}::${input.companionId}`;
    if (state.pairThisChain.has(pairKey)) {
      return rejectAura(state, 'pair_already_applied');
    }
    state.pairThisChain.add(pairKey);
  }
  // Commit
  state.visitedSources.add(input.sourceId);
  state.ticksThisTurn.set(tickKey, ticks + 1);
  if (input.depth > state.chainDepth) state.chainDepth = input.depth;
  return { ok: true };
}

function rejectAura(state: AuraGuardState, reason: AuraRejectReason): AuraPropagateOutcome {
  state.rejectedByReason.set(reason, (state.rejectedByReason.get(reason) ?? 0) + 1);
  return { ok: false, reason };
}

// ─────────────────────────────────────────────────────────
// Snapshot / restore (replay)
// ─────────────────────────────────────────────────────────

export function snapshotAuraGuard(state: AuraGuardState): AuraGuardState {
  return {
    encounterId: state.encounterId,
    visitedSources: new Set(state.visitedSources),
    ticksThisTurn: new Map(state.ticksThisTurn),
    pairThisChain: new Set(state.pairThisChain),
    chainDepth: state.chainDepth,
    rejectedByReason: new Map(state.rejectedByReason),
    currentTurn: state.currentTurn,
  };
}

export function restoreAuraGuard(snap: AuraGuardState): AuraGuardState {
  return snapshotAuraGuard(snap);
}
