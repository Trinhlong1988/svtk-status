/**
 * TICK EFFECT — DOT/HOT tick fire + expire (Phase 2 spec).
 *
 * Called per turn by encounter loop. Iterates active StatusEffect on target,
 * fires onTick handler khi (currentTurn - lastTickTurn) % tickInterval === 0,
 * decrements remainingTurns, marks for removal khi expired.
 *
 * Pure deterministic — no async. Direct mutation per R33.
 *
 * Phase 2 FH wire:
 *   - FIX #5: iterate via `sortStatusEffectsStable` (NOT Map insertion order)
 *   - FIX #8: emit `tick_double_fire` telemetry if same effect fires twice same turn
 */
import type { CombatChar, CombatContext } from './types.js';
import type { EventBus } from './event_bus.js';
import type { StatusEffect, EffectHandlerContext } from './status_types.js';
import { effectRegistry } from './effect_registry.js';
import { sortStatusEffectsStable } from './status_ordering.js';
import type { StatusTelemetryState } from './status_telemetry.js';
import { emitTimingConflict } from './status_telemetry.js';

export interface TickContext extends CombatContext {
  bus: EventBus;
  activeStatuses: Map<string, StatusEffect[]>;
  /** Phase 2 FH — optional telemetry sink (FIX #8). */
  telemetry?: StatusTelemetryState;
}

export interface TickResult {
  ticked: number;
  expired: number;
}

/**
 * Tick all active effects on target. Mutates ctx.activeStatuses + target reference
 * via handler.onTick (DOT damage / HOT heal direct).
 *
 * Phase 2 FH FIX #5 — iteration order is now the canonical stable comparator:
 *   turnApplied ASC → sourceId LEX → effectId LEX → emitSeq ASC
 * Replaces previous "array index order" reliance.
 *
 * @returns count of ticked + expired
 */
export function tickEffectsOnTarget(
  target: CombatChar,
  ctx: TickContext,
): TickResult {
  const active = ctx.activeStatuses.get(target.id) ?? [];
  if (active.length === 0) return { ticked: 0, expired: 0 };

  let ticked = 0;
  let expired = 0;
  const survivors: StatusEffect[] = [];

  // FIX #5 — stable comparator iteration (replaces Map insertion order).
  const ordered = sortStatusEffectsStable([...active]);
  // Track (type, sourceId) tuples that fired this turn for FIX #8 double-fire detection.
  const firedThisTurn = new Set<string>();

  for (const eff of ordered) {
    const handler = effectRegistry.get(eff.type);
    if (!handler) continue;

    // Tick fire check
    const sinceLast = ctx.turn - eff.lastTickTurn;
    if (sinceLast > 0 && sinceLast % eff.tickInterval === 0) {
      const fireKey = `${eff.type}::${eff.sourceId}::${eff.targetId}`;
      if (firedThisTurn.has(fireKey)) {
        // Double-fire anomaly — telemetry only, do NOT skip (caller behavior preserved).
        if (ctx.telemetry) {
          emitTimingConflict(ctx.telemetry, ctx.turn, 'tick_double_fire', target.id, eff.type);
        }
      }
      firedThisTurn.add(fireKey);
      handler.onTick?.(target, eff, ctx as EffectHandlerContext);
      eff.lastTickTurn = ctx.turn;
      ticked++;
    }

    // Decrement duration
    eff.remainingTurns -= 1;

    if (eff.remainingTurns <= 0) {
      // Expired
      handler.onRemove?.(target, eff, ctx as EffectHandlerContext);
      ctx.bus.emit({
        type: 'effect_expired',
        turn: ctx.turn,
        targetId: target.id,
        effectType: eff.type,
      });
      expired++;
    } else {
      survivors.push(eff);
    }
  }

  ctx.activeStatuses.set(target.id, survivors);
  return { ticked, expired };
}
