/**
 * MECHANIC BUDGET + EVENT LIMITER — anti boss-mechanic explosion (Phase 6 FP FIX #2).
 *
 * PROBLEM (CMD1.docx Phase 6 Final Perfect Pass):
 *   Mechanic chain explosion example:
 *     summon → trigger region → trigger wipe → trigger summon → trigger aggro_reset → ...
 *
 *   Risks:
 *     - replay drift
 *     - infinite mechanic loop
 *     - server spike
 *     - boss chaos
 *
 * 3 ENFORCEMENT LAYERS:
 *
 *   1. MechanicBudget — per (encounter, turn) cap (FIX #2):
 *      MAX_MECHANIC_PER_TICK = 16 (default). Caller calls `tryConsumeMechanic()`
 *      before scheduling new mechanic. Overflow → reject deterministically.
 *
 *   2. ChainDepth — per chain depth (FIX #2):
 *      MAX_MECHANIC_CHAIN_DEPTH = 4. Mechanic dispatched from another mechanic's
 *      resolution carries `depth+1`. Caller passes depth at scheduling time.
 *
 *   3. SameTypeCap — per (turn, mechanicKind):
 *      MAX_SAME_TYPE_MECHANIC_PER_TICK = 4. Catches reflective loop like
 *      summon→summon spam.
 *
 * All reject paths deterministic — never throw. Telemetry-friendly outcomes.
 *
 * STRICT additive — caller (encounter_manager) integrates by checking outcome
 * before invoking `tickScheduler` / `placeDelayedAoe` / etc.
 *
 * KISS — NO behavior-tree engine, NO blackboard, just plain counters
 * (CMD1.docx § XIII: NO BOSS FRAMEWORK SYNDROME).
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

export const MAX_MECHANIC_PER_TICK = 16 as const;
export const MAX_MECHANIC_CHAIN_DEPTH = 4 as const;
export const MAX_SAME_TYPE_MECHANIC_PER_TICK = 4 as const;

// ─────────────────────────────────────────────────────────
// Outcomes
// ─────────────────────────────────────────────────────────

export const MechanicRejectReasonSchema = z.enum([
  'tick_budget_exhausted',
  'chain_depth_exceeded',
  'same_type_tick_cap',
]);
export type MechanicRejectReason = z.infer<typeof MechanicRejectReasonSchema>;

export type MechanicBudgetOutcome =
  | { ok: true; remaining: number }
  | { ok: false; reason: MechanicRejectReason; remaining: number };

// ─────────────────────────────────────────────────────────
// Budget state — per encounter
// ─────────────────────────────────────────────────────────

export interface MechanicBudgetState {
  encounterId: string;
  /** turn → consumed count. */
  perTurn: Map<number, number>;
  /** "turn:kind" → consumed count (sameTypeCap). */
  perTurnKind: Map<string, number>;
  /** "turn:rejReason" → count (telemetry). */
  rejectedByReason: Map<string, number>;
  /** Caps (overridable per encounter). */
  tickCap: number;
  sameTypeCap: number;
  chainCap: number;
}

export function createMechanicBudget(
  encounterId: string,
  overrides: Partial<{ tickCap: number; sameTypeCap: number; chainCap: number }> = {},
): MechanicBudgetState {
  return {
    encounterId,
    perTurn: new Map(),
    perTurnKind: new Map(),
    rejectedByReason: new Map(),
    tickCap: overrides.tickCap ?? MAX_MECHANIC_PER_TICK,
    sameTypeCap: overrides.sameTypeCap ?? MAX_SAME_TYPE_MECHANIC_PER_TICK,
    chainCap: overrides.chainCap ?? MAX_MECHANIC_CHAIN_DEPTH,
  };
}

// ─────────────────────────────────────────────────────────
// Consume check — caller invokes before scheduling each mechanic
// ─────────────────────────────────────────────────────────

export interface MechanicConsumeInput {
  /** Turn at which mechanic will be scheduled (NOT resolveTurn). */
  scheduledTurn: number;
  /** Mechanic kind (vd 'spatial_aoe', 'summon', 'aggro_reset'). */
  kind: string;
  /** Chain depth — 0 for root-scheduled, +1 for dispatched-by-another-mechanic. */
  chainDepth: number;
}

/**
 * Attempt to consume 1 mechanic slot. Pure mutation — no I/O / throw.
 *
 * Order of checks:
 *   1. Chain depth
 *   2. Same-type per-tick cap
 *   3. Tick budget cap
 */
export function tryConsumeMechanic(
  state: MechanicBudgetState,
  input: MechanicConsumeInput,
): MechanicBudgetOutcome {
  if (input.chainDepth > state.chainCap) {
    return rejectBudget(state, 'chain_depth_exceeded', input.scheduledTurn);
  }
  const sameKey = sameTypeKey(input.scheduledTurn, input.kind);
  const sameCount = state.perTurnKind.get(sameKey) ?? 0;
  if (sameCount >= state.sameTypeCap) {
    return rejectBudget(state, 'same_type_tick_cap', input.scheduledTurn);
  }
  const tickCount = state.perTurn.get(input.scheduledTurn) ?? 0;
  if (tickCount >= state.tickCap) {
    return rejectBudget(state, 'tick_budget_exhausted', input.scheduledTurn);
  }
  // Commit
  state.perTurn.set(input.scheduledTurn, tickCount + 1);
  state.perTurnKind.set(sameKey, sameCount + 1);
  return { ok: true, remaining: state.tickCap - tickCount - 1 };
}

function rejectBudget(
  state: MechanicBudgetState,
  reason: MechanicRejectReason,
  turn: number,
): MechanicBudgetOutcome {
  const key = `${turn}:${reason}`;
  state.rejectedByReason.set(key, (state.rejectedByReason.get(key) ?? 0) + 1);
  return { ok: false, reason, remaining: 0 };
}

function sameTypeKey(turn: number, kind: string): string {
  return `${turn}::${kind}`;
}

// ─────────────────────────────────────────────────────────
// Query helpers
// ─────────────────────────────────────────────────────────

export function consumedAtTurn(state: MechanicBudgetState, turn: number): number {
  return state.perTurn.get(turn) ?? 0;
}

export function consumedOfKindAtTurn(
  state: MechanicBudgetState,
  turn: number,
  kind: string,
): number {
  return state.perTurnKind.get(sameTypeKey(turn, kind)) ?? 0;
}

export function totalRejected(state: MechanicBudgetState): number {
  let total = 0;
  for (const v of state.rejectedByReason.values()) total += v;
  return total;
}

export function rejectedByReason(
  state: MechanicBudgetState,
  reason: MechanicRejectReason,
): number {
  let total = 0;
  for (const [key, v] of state.rejectedByReason) {
    if (key.endsWith(`:${reason}`)) total += v;
  }
  return total;
}

/** Prune turn entries older than `keepBeyond` (memory hygiene). */
export function pruneMechanicBudget(
  state: MechanicBudgetState,
  keepBeyond: number,
): number {
  let pruned = 0;
  for (const turn of [...state.perTurn.keys()]) {
    if (turn < keepBeyond) {
      state.perTurn.delete(turn);
      pruned += 1;
    }
  }
  for (const key of [...state.perTurnKind.keys()]) {
    const turnStr = key.split('::')[0]!;
    const turn = parseInt(turnStr, 10);
    if (turn < keepBeyond) state.perTurnKind.delete(key);
  }
  for (const key of [...state.rejectedByReason.keys()]) {
    const turnStr = key.split(':')[0]!;
    const turn = parseInt(turnStr, 10);
    if (turn < keepBeyond) state.rejectedByReason.delete(key);
  }
  return pruned;
}

// ─────────────────────────────────────────────────────────
// Snapshot / restore
// ─────────────────────────────────────────────────────────

export function snapshotMechanicBudget(state: MechanicBudgetState): MechanicBudgetState {
  return {
    encounterId: state.encounterId,
    perTurn: new Map(state.perTurn),
    perTurnKind: new Map(state.perTurnKind),
    rejectedByReason: new Map(state.rejectedByReason),
    tickCap: state.tickCap,
    sameTypeCap: state.sameTypeCap,
    chainCap: state.chainCap,
  };
}

export function restoreMechanicBudget(snap: MechanicBudgetState): MechanicBudgetState {
  return snapshotMechanicBudget(snap);
}
