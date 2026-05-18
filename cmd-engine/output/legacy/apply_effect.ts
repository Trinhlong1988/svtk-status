/**
 * APPLY EFFECT pipeline — 11-step deterministic (Phase 2 spec).
 *
 * Pipeline order:
 *   1. validate         (input shape)
 *   2. immunity check   (target immune category/type)
 *   3. resist check     (boss CC resist BP roll)
 *   4. DR check         (per-group multiplier; 0 = block)
 *   5. stack rule       (additive/refresh/strongest/capped/unique)
 *   6. overwrite rule   (handle replaced effect — onRemove + emit)
 *   7. apply            (push to target.debuffs/buffs/cc + onApply handler)
 *   8. emit event       (effect_applied / dr_triggered / cleanse_triggered)
 *   9. tick init        (lastTickTurn = currentTurn)
 *   10. expire schedule (remainingTurns set)
 *   11. remove (deferred — handled by tick / cleanse)
 *
 * Pure deterministic — no async, no Math.random, no Date.now.
 */
import type { CombatChar, CombatContext } from './types.js';
import type { EventBus } from './event_bus.js';
import type {
  StatusEffect,
  ApplyResult,
  DRTrackerEntry,
  EffectHandler,
} from './status_types.js';
import { effectRegistry } from './effect_registry.js';
import { getDRMultiplierBP, advanceDRTracker } from './diminishing_return.js';
import { applyStackRule } from './stack_rule.js';
import { StatusConstants } from './status_constants.js';
import { createProtectedView, assertNoProtectedMutation } from './status_protection.js';
import { validateStatusEffectMutation } from './status_validation.js';

// ─────────────────────────────────────────────────────────
// Phase 2 FH wire — guards (all OPTIONAL — backward compat)
// ─────────────────────────────────────────────────────────
import type {
  ProcBudgetState, TurnEventLimiterState,
} from './status_proc_budget.js';
import { tryConsumeStatusBudget } from './status_proc_budget.js';
import type { AuraGuardState } from './aura_propagation_guard.js';
import { tryPropagateAura } from './aura_propagation_guard.js';
import type { StatusTelemetryState } from './status_telemetry.js';
import { emitProcRejected, emitAuraRejected } from './status_telemetry.js';
import type { StatusEmitSeqState } from './status_ordering.js';
import { nextStatusEmitSeq } from './status_ordering.js';

export interface StatusApplyContext extends CombatContext {
  bus: EventBus;
  /** DR tracker per encounter — caller (encounter manager) owns Map<targetId, Map<DRGroup, DRTrackerEntry>>. */
  drTrackers?: Map<string, Map<string, DRTrackerEntry>>;
  /** Active status effects per target. Caller owns. */
  activeStatuses?: Map<string, StatusEffect[]>;
  /** Stack cap lookup by effect type. Default StatusConstants. */
  stackCapFor?: (type: string) => number;
  /** Boss flag — use BOSS_*_RESIST_BP. */
  isBoss?: (charId: string) => boolean;

  // ───── Phase 2 FH guards (all OPTIONAL — when present, applyEffect enforces them) ─────
  /** Per-action proc budget (FIX #2 + #3). */
  procBudget?: ProcBudgetState;
  /** Per-(encounter, turn) event limiter (FIX #2). */
  turnLimiter?: TurnEventLimiterState;
  /** Aura propagation guard (FIX #7) — required when current effect is aura kind. */
  auraGuard?: AuraGuardState;
  /** Telemetry sink (FIX #8) — receives reject anomaly events. */
  telemetry?: StatusTelemetryState;
  /** Per-encounter monotonic emit seq (FIX #5 ordering tiebreak). */
  emitSeq?: StatusEmitSeqState;
  /** Current chain depth (FIX #2 recursion). Caller bumps for cascaded applies. */
  chainDepth?: number;
  /** Aura propagation metadata — set when the effect is an aura emit. */
  auraContext?: {
    auraType: string;
    sourceId: string;
    ownerId?: string;
    companionId?: string;
    /** Chain depth in aura propagation (separate from procChain). */
    auraDepth?: number;
  };
}

function defaultStackCap(type: string): number {
  switch (type) {
    case 'dot':         return StatusConstants.STACK_CAP_DOT;
    case 'hot':         return StatusConstants.STACK_CAP_HOT;
    case 'debuff_stat': return StatusConstants.STACK_CAP_DEBUFF_STAT;
    case 'buff_stat':   return StatusConstants.STACK_CAP_BUFF_STAT;
    default:            return StatusConstants.STACK_CAP_DEFAULT;
  }
}

/**
 * Resist roll — boss CC resist (BP scale).
 *
 * FIX #1 (Phase 2 hardening): MUST use rng_status substream — independent từ
 * rng_hit/rng_crit/rng_proc. Adding new boss resist KHÔNG shift hit/crit replay
 * sequence. NO Math.random fallback. ctx.rng (deterministic seedrandom legacy)
 * accepted khi rngStream undefined cho backward compat tests.
 *
 * @returns true if RESISTED (block apply).
 */
function resistRoll(
  target: CombatChar,
  handler: EffectHandler,
  ctx: StatusApplyContext,
): boolean {
  if (!ctx.isBoss?.(target.id)) return false;
  let resistBP = 0;
  if (handler.drGroup === 'hard_cc') resistBP = StatusConstants.BOSS_HARDCC_RESIST_BP;
  else if (handler.drGroup === 'soft_cc') resistBP = StatusConstants.BOSS_SOFTCC_RESIST_BP;
  if (resistBP === 0) return false;
  const rng = ctx.rngStream ? ctx.rngStream.sub('rng_status') : ctx.rng;
  return rng() * 10000 < resistBP;
}

/** Find existing instance of same type on target. */
function findExisting(
  active: StatusEffect[] | undefined,
  type: string,
): StatusEffect | undefined {
  return active?.find((e) => e.type === type);
}

/** Get/create DR tracker for (target, group). */
function getDRTracker(
  ctx: StatusApplyContext,
  targetId: string,
  group: string,
): DRTrackerEntry | undefined {
  const map = ctx.drTrackers?.get(targetId);
  return map?.get(group);
}

function setDRTracker(
  ctx: StatusApplyContext,
  targetId: string,
  group: string,
  entry: DRTrackerEntry,
): void {
  if (!ctx.drTrackers) return;
  let map = ctx.drTrackers.get(targetId);
  if (!map) {
    map = new Map();
    ctx.drTrackers.set(targetId, map);
  }
  map.set(group, entry);
}

/**
 * Main entry — apply 1 status effect to target.
 *
 * @param incoming — new StatusEffect instance (built by caller from skill data)
 * @param target — receiving char (mutated only via handler.onApply per R33)
 * @param ctx — pipeline context
 */
export function applyEffect(
  incoming: StatusEffect,
  target: CombatChar,
  ctx: StatusApplyContext,
): ApplyResult {
  // Step 1 — validate (Zod schema validates effect shape at construction; here check basic invariants)
  if (incoming.remainingTurns < 0 || incoming.stacks < 1) {
    return { outcome: 'immune' };   // Treat as no-op
  }

  const handler = effectRegistry.get(incoming.type);
  if (!handler) {
    // Unknown effect — caller responsible to register, fall back as no-op
    return { outcome: 'immune' };
  }

  // ───── Phase 2 FH guard checks (only fire when context provides corresponding state) ─────
  // FIX #2 + #3 — proc budget + turn event limiter (gate BEFORE any side-effect).
  if (ctx.procBudget && ctx.turnLimiter) {
    const r = tryConsumeStatusBudget(
      { proc: ctx.procBudget, turn: ctx.turnLimiter, currentTurn: ctx.turn },
      incoming.type,
      ctx.chainDepth ?? 0,
    );
    if (!r.ok) {
      if (ctx.telemetry) {
        emitProcRejected(ctx.telemetry, ctx.turn,
          r.reason === 'turn_event_cap' ? 'turn_event_cap'
          : r.reason === 'recursion_depth' ? 'recursion_depth'
          : r.reason === 'same_type_cap' ? 'same_type_cap'
          : 'proc_budget_exhausted',
          incoming.type, incoming.sourceId);
      }
      return { outcome: 'immune' };
    }
  }
  // FIX #7 — aura propagation guard (only when effect emits as aura).
  if (ctx.auraGuard && ctx.auraContext) {
    const r = tryPropagateAura(ctx.auraGuard, {
      auraType: ctx.auraContext.auraType,
      sourceId: ctx.auraContext.sourceId,
      ownerId: ctx.auraContext.ownerId,
      companionId: ctx.auraContext.companionId,
      depth: ctx.auraContext.auraDepth ?? 0,
    });
    if (!r.ok) {
      if (ctx.telemetry) {
        emitAuraRejected(ctx.telemetry, ctx.turn,
          r.reason === 'depth_exceeded' ? 'aura_depth_exceeded'
          : r.reason === 'visited_source' ? 'aura_visited_source'
          : r.reason === 'pair_already_applied' ? 'aura_pair_already_applied'
          : 'aura_tick_budget',
          ctx.auraContext.auraType, ctx.auraContext.sourceId);
      }
      return { outcome: 'immune' };
    }
  }
  // FIX #5 — assign monotonic emit seq (caller may stash for ordering).
  if (ctx.emitSeq) {
    void nextStatusEmitSeq(ctx.emitSeq);
  }

  // Step 2 — immunity check (target.cc.frozen blocks new freeze, etc. Future Module 2+ extend)
  // Phase 2 baseline: no per-target immunity tags — caller wire qua isBoss + handler.

  // Step 3 — resist check (boss CC resist)
  if (resistRoll(target, handler, ctx)) {
    return { outcome: 'resisted' };
  }

  // Step 4 — DR check
  const drTracker = getDRTracker(ctx, target.id, handler.drGroup);
  const drBP = getDRMultiplierBP(handler.drGroup, ctx.turn, drTracker);
  if (drBP === 0) {
    // Immune from DR
    ctx.bus.emit({
      type: 'effect_applied',
      turn: ctx.turn,
      targetId: target.id,
      effectType: incoming.type,
      duration: 0,
    });
    return { outcome: 'dr_blocked' };
  }
  // Apply DR scaling to duration (BP)
  const adjustedDuration = Math.max(1, Math.floor((incoming.remainingTurns * drBP) / 10000));
  const drIncoming: StatusEffect = { ...incoming, remainingTurns: adjustedDuration };

  // Advance DR tracker (only if drGroup !== 'none')
  if (handler.drGroup !== 'none') {
    setDRTracker(ctx, target.id, handler.drGroup, advanceDRTracker(handler.drGroup, ctx.turn, drTracker));
  }

  // Step 5 — stack rule
  const active = ctx.activeStatuses?.get(target.id);
  const existing = findExisting(active, incoming.type);
  const stackCap = (ctx.stackCapFor ?? defaultStackCap)(incoming.type);
  const stackResult = applyStackRule(existing, drIncoming, handler.stackBehavior, stackCap);

  // Step 6 — TRANSACTIONAL overwrite (FIX #6 anti-flicker).
  //
  // Old order: onRemove(old) → push new → onApply(new). Risk: onRemove zero-out shield
  // BEFORE onApply set new shield → 0-frame UI glimpse of zero shield.
  //
  // New transactional order:
  //   1. snapshot old state value (for combat log audit)
  //   2. push new effect to active list FIRST (state visible = new effect)
  //   3. handler.onApply set new mutation (overwrites old via Math.max / direct set)
  //   4. handler.onRemove of OLD effect ONLY if its mutation pattern doesn't auto-stomp
  //      (eg shield: new max(old, eff.amount) already covers; explicit onRemove skipped
  //       to prevent flicker).
  //
  // Implementation: set a flag suppressRemoveOnApply on stackResult — pipeline reads
  // and conditionally fires onRemove. For 'strongest' (shield-style), we SKIP onRemove
  // entirely because the new onApply has already supplanted the field.
  const removedEffects: StatusEffect[] = [];
  const isTransactionalOverwrite = stackResult.outcome === 'overwritten';
  if (stackResult.removed) {
    removedEffects.push(stackResult.removed);
    if (!isTransactionalOverwrite) {
      handler.onRemove?.(target, stackResult.removed, ctx);
    }
    // For transactional overwrite: onRemove fires AFTER onApply (Step 7) — see below.
  }

  // Step 7 — apply (push to active list + onApply hook)
  if (stackResult.outcome === 'duplicate_unique' || stackResult.outcome === 'stack_capped') {
    // No new instance — return early
    return { outcome: stackResult.outcome === 'stack_capped' ? 'stack_capped' : 'duplicate_unique', effect: stackResult.effect };
  }

  if (stackResult.effect) {
    // FIX #3 — Zod re-validate post-merge (security clamp + NaN/Infinity guard)
    validateStatusEffectMutation(stackResult.effect);

    if (ctx.activeStatuses) {
      let list = ctx.activeStatuses.get(target.id);
      if (!list) {
        list = [];
        ctx.activeStatuses.set(target.id, list);
      }
      // Replace existing of same type if present (after stack merge / refresh / overwrite)
      const idx = list.findIndex((e) => e.type === incoming.type);
      if (idx >= 0) list[idx] = stackResult.effect;
      else list.push(stackResult.effect);
    }
    // FIX #2 — Snapshot identity fields BEFORE handler, assert NO mutation AFTER.
    // Proxy view also blocks live writes into protected fields (defense in depth).
    const snapshot: StatusEffect = { ...stackResult.effect };
    const protectedView = createProtectedView(stackResult.effect);
    handler.onApply?.(target, protectedView, ctx);
    assertNoProtectedMutation(snapshot, stackResult.effect);

    // FIX #6 — transactional overwrite tail: fire onRemove of old AFTER new onApply.
    // For 'strongest' (shield), new onApply already maxed shield with new amount —
    // calling onRemove of old here is no-op for shield (target.shield already > old.amount).
    // For OTHER overwrite kinds (unique/refresh do not produce 'overwritten'), the
    // tail emit ensures combat log preserves removal record without UI flicker.
    if (isTransactionalOverwrite && stackResult.removed) {
      handler.onRemove?.(target, stackResult.removed, ctx);
    }
  }

  // Step 8 — emit event (combat event)
  ctx.bus.emit({
    type: 'effect_applied',
    turn: ctx.turn,
    targetId: target.id,
    effectType: incoming.type,
    duration: stackResult.effect?.remainingTurns ?? 0,
  });

  // Step 9-10 already covered by initial StatusEffect.lastTickTurn + remainingTurns
  // Step 11 deferred — tick/expire/cleanse handle removal.

  // Map stackOutcome → ApplyOutcome
  const outcome = stackResult.outcome === 'apply_new' ? 'applied'
                : stackResult.outcome === 'refreshed' ? 'refreshed'
                : stackResult.outcome === 'overwritten' ? 'overwritten'
                : 'applied';

  return { outcome, effect: stackResult.effect, removed: removedEffects };
}
