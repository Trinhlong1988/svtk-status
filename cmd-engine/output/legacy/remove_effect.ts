/**
 * REMOVE EFFECT — explicit removal (cleanse / dispel / overwrite consequence).
 *
 * Different from tick-expire: this is caller-triggered removal, not turn-driven.
 *
 * Pure: handler.onRemove + emit event + filter active list.
 */
import type { CombatChar } from './types.js';
import type { EventBus } from './event_bus.js';
import type { StatusEffect, EffectHandlerContext } from './status_types.js';
import { effectRegistry } from './effect_registry.js';

export interface RemoveContext extends EffectHandlerContext {
  bus: EventBus;
  activeStatuses: Map<string, StatusEffect[]>;
}

/**
 * Remove specific effect instances from target. Fires handler.onRemove + emit event.
 *
 * @returns count actually removed
 */
export function removeEffects(
  target: CombatChar,
  toRemove: readonly StatusEffect[],
  ctx: RemoveContext,
): number {
  if (toRemove.length === 0) return 0;
  const active = ctx.activeStatuses.get(target.id) ?? [];
  const removeIds = new Set(toRemove.map((e) => e.effectId));
  const survivors: StatusEffect[] = [];
  let removed = 0;

  for (const eff of active) {
    if (removeIds.has(eff.effectId)) {
      const handler = effectRegistry.get(eff.type);
      handler?.onRemove?.(target, eff, ctx);
      ctx.bus.emit({
        type: 'effect_expired',
        turn: ctx.turn,
        targetId: target.id,
        effectType: eff.type,
      });
      removed++;
    } else {
      survivors.push(eff);
    }
  }

  ctx.activeStatuses.set(target.id, survivors);
  return removed;
}
