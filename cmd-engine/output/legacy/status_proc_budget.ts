/**
 * STATUS PROC BUDGET + EVENT LIMITER — anti-explosion guard (Phase 2 FH FIX #2, #3).
 *
 * PROBLEM (CMD1.docx):
 *   Status proc chains can explode:
 *     burn → poison → reflect → aura → regen → passive → summon proc → ...
 *   Without a limiter:
 *     - infinite loop
 *     - server spike
 *     - replay divergence
 *     - PvP instability
 *
 * TWO ENFORCEMENT LAYERS:
 *
 *   1. ProcBudget — per-action cap (FIX #3):
 *      MAX_STATUS_PROC_PER_ACTION = 8 (default — overridable per-action).
 *      Caller calls `consumeProc()` before each proc fire; if budget exhausted,
 *      proc rejected deterministically. Remaining procs in chain TRUNCATED (not
 *      queued; not lottery — explicit drop with telemetry).
 *
 *   2. EventLimiter — per-tick throttle (FIX #2):
 *      Caps total status events per (encounter, turn) tuple. Catches runaway
 *      multi-action explosion (vd 5 attackers all chain-proc).
 *      MAX_STATUS_EVENTS_PER_TURN = 64 (default).
 *
 *   3. RecursionGuard — chain depth (existing MAX_EFFECT_CHAIN_DEPTH):
 *      Already enforced by StatusConstants. This module exposes a thin wrapper
 *      so all three guards have a unified API.
 *
 * ALL THREE produce a `BudgetOutcome` — never throw on overflow (deterministic
 * rejection). Telemetry caller observes `rejected` reason.
 */
import { z } from 'zod';
import { StatusConstants } from './status_constants.js';

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

/** CMD1.docx LOCK: per-action proc budget. */
export const MAX_STATUS_PROC_PER_ACTION = 8 as const;

/** Per-tick throttle (per encounter). */
export const MAX_STATUS_EVENTS_PER_TURN = 64 as const;

/**
 * Per-effect-type recursion sub-cap — within one chain depth, vd burn cannot
 * proc burn more than once. Catches reflective loops not caught by global depth.
 */
export const MAX_SAME_TYPE_PROCS_PER_ACTION = 2 as const;

// ─────────────────────────────────────────────────────────
// Outcomes
// ─────────────────────────────────────────────────────────

export const BudgetRejectReasonSchema = z.enum([
  'proc_budget_exhausted',
  'turn_event_cap',
  'recursion_depth',
  'same_type_cap',
]);
export type BudgetRejectReason = z.infer<typeof BudgetRejectReasonSchema>;

export type BudgetOutcome =
  | { ok: true; remaining: number }
  | { ok: false; reason: BudgetRejectReason; remaining: number };

// ─────────────────────────────────────────────────────────
// Proc budget — per-action
// ─────────────────────────────────────────────────────────

export interface ProcBudgetState {
  /** Caster + action correlation id (encounterId + actionSeq). */
  actionKey: string;
  /** Remaining proc slots. */
  remaining: number;
  /** Procs consumed grouped by effect type (for SAME_TYPE_CAP). */
  perTypeCount: Map<string, number>;
  /** Recursion depth (effect-chain depth from initiating action). */
  depth: number;
  /** Telemetry: rejected reason counts. */
  rejectedByReason: Map<BudgetRejectReason, number>;
}

export function createProcBudget(actionKey: string, capacity: number = MAX_STATUS_PROC_PER_ACTION): ProcBudgetState {
  return {
    actionKey,
    remaining: capacity,
    perTypeCount: new Map(),
    depth: 0,
    rejectedByReason: new Map(),
  };
}

/**
 * Attempt to consume 1 proc slot for an effect of `type` at chain `depth`.
 * Returns `ok: true` if approved; `ok: false` with reason + telemetry-side-effect
 * recorded.
 *
 * Pure relative to state mutation — no I/O, no rng.
 */
export function consumeProc(
  state: ProcBudgetState,
  effectType: string,
  depth: number = 0,
): BudgetOutcome {
  // Recursion depth check
  if (depth > StatusConstants.MAX_EFFECT_CHAIN_DEPTH) {
    return reject(state, 'recursion_depth');
  }
  // Same-type cap
  const sameType = state.perTypeCount.get(effectType) ?? 0;
  if (sameType >= MAX_SAME_TYPE_PROCS_PER_ACTION) {
    return reject(state, 'same_type_cap');
  }
  // Budget cap
  if (state.remaining <= 0) {
    return reject(state, 'proc_budget_exhausted');
  }
  // Accept
  state.remaining -= 1;
  state.perTypeCount.set(effectType, sameType + 1);
  if (depth > state.depth) state.depth = depth;
  return { ok: true, remaining: state.remaining };
}

function reject(state: ProcBudgetState, reason: BudgetRejectReason): BudgetOutcome {
  state.rejectedByReason.set(reason, (state.rejectedByReason.get(reason) ?? 0) + 1);
  return { ok: false, reason, remaining: state.remaining };
}

/** Reset for next action (caller invokes at action boundary). */
export function resetProcBudget(state: ProcBudgetState, newActionKey: string, capacity: number = MAX_STATUS_PROC_PER_ACTION): void {
  state.actionKey = newActionKey;
  state.remaining = capacity;
  state.perTypeCount.clear();
  state.depth = 0;
  state.rejectedByReason.clear();
}

// ─────────────────────────────────────────────────────────
// Turn event limiter — per (encounter, turn)
// ─────────────────────────────────────────────────────────

export interface TurnEventLimiterState {
  encounterId: string;
  /** turn → count. */
  perTurn: Map<number, number>;
  /** Telemetry: per-turn rejected counts. */
  rejectedPerTurn: Map<number, number>;
  /** Cap per turn — defaults MAX_STATUS_EVENTS_PER_TURN. */
  capPerTurn: number;
}

export function createTurnEventLimiter(
  encounterId: string,
  capPerTurn: number = MAX_STATUS_EVENTS_PER_TURN,
): TurnEventLimiterState {
  return {
    encounterId,
    perTurn: new Map(),
    rejectedPerTurn: new Map(),
    capPerTurn,
  };
}

export function tryConsumeTurnEvent(
  limiter: TurnEventLimiterState,
  turn: number,
): BudgetOutcome {
  const cur = limiter.perTurn.get(turn) ?? 0;
  if (cur >= limiter.capPerTurn) {
    limiter.rejectedPerTurn.set(turn, (limiter.rejectedPerTurn.get(turn) ?? 0) + 1);
    return { ok: false, reason: 'turn_event_cap', remaining: 0 };
  }
  limiter.perTurn.set(turn, cur + 1);
  return { ok: true, remaining: limiter.capPerTurn - cur - 1 };
}

/** Total events recorded across all turns. */
export function totalTurnEvents(limiter: TurnEventLimiterState): number {
  let total = 0;
  for (const v of limiter.perTurn.values()) total += v;
  return total;
}

/** Total rejected. */
export function totalRejectedTurnEvents(limiter: TurnEventLimiterState): number {
  let total = 0;
  for (const v of limiter.rejectedPerTurn.values()) total += v;
  return total;
}

/** Cull turn entries older than `keepBeyond` turn (memory hygiene). */
export function pruneTurnEventLimiter(
  limiter: TurnEventLimiterState,
  keepBeyond: number,
): number {
  let pruned = 0;
  for (const turn of [...limiter.perTurn.keys()]) {
    if (turn < keepBeyond) {
      limiter.perTurn.delete(turn);
      limiter.rejectedPerTurn.delete(turn);
      pruned += 1;
    }
  }
  return pruned;
}

// ─────────────────────────────────────────────────────────
// Unified guard — wraps both proc + turn limit
// ─────────────────────────────────────────────────────────

export interface UnifiedBudgetContext {
  proc: ProcBudgetState;
  turn: TurnEventLimiterState;
  currentTurn: number;
}

/**
 * Combined check — caller invokes ONCE per proc fire. Order:
 *   1. recursion depth
 *   2. same-type cap
 *   3. per-action proc budget
 *   4. per-turn event cap
 *
 * Returns first failing reason. On success, consumes from BOTH counters.
 */
export function tryConsumeStatusBudget(
  ctx: UnifiedBudgetContext,
  effectType: string,
  depth: number = 0,
): BudgetOutcome {
  const procR = consumeProc(ctx.proc, effectType, depth);
  if (!procR.ok) return procR;
  const turnR = tryConsumeTurnEvent(ctx.turn, ctx.currentTurn);
  if (!turnR.ok) {
    // Compensate — release the proc slot we just took, since turn cap blocked.
    ctx.proc.remaining += 1;
    const sameType = ctx.proc.perTypeCount.get(effectType) ?? 1;
    if (sameType > 0) ctx.proc.perTypeCount.set(effectType, sameType - 1);
    return turnR;
  }
  return { ok: true, remaining: procR.remaining };
}
