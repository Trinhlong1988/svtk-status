/**
 * THREAT TARGET RESOLVER — Phase 4 § IX.
 *
 * 6 mode priority order (top to bottom):
 *   1. taunt_override         (forced target — wins always)
 *   2. scripted_override      (boss script forces target)
 *   3. mechanic_override      (boss mechanic — vd "lowest hp")
 *   4. highest_threat         (default — top of sorted table)
 *   5. nearest_threat         (when distance map provided)
 *   6. anti_exploit_fallback  (top threat ignored if exploited zero-aggro)
 *
 * Stable deterministic ordering. Hysteresis prevents target oscillation.
 */
import type {
  ThreatEntryV2,
  TauntStateEntry,
  TargetResolveContext,
  TargetResolveResult,
} from './threat_types.js';
import { sortedByThreat } from './threat_table.js';
import { forcedTarget } from './taunt_system.js';
import { ThreatConstants } from './threat_constants.js';

export interface ResolverInput {
  table: Map<string, ThreatEntryV2>;
  taunt?: TauntStateEntry;
  /** Current target (for hysteresis). undefined = no current. */
  currentTargetId?: string;
}

export function resolveTarget(
  input: ResolverInput,
  ctx: TargetResolveContext,
): TargetResolveResult {
  // Step 1 — taunt
  const tauntId = forcedTarget(input.taunt, ctx.currentTurn);
  if (tauntId && (ctx.isEligible?.(tauntId) ?? true)) {
    return { targetId: tauntId, mode: 'taunt_override' };
  }

  // Step 2 — scripted
  if (ctx.scriptedTargetId && (ctx.isEligible?.(ctx.scriptedTargetId) ?? true)) {
    return { targetId: ctx.scriptedTargetId, mode: 'scripted_override' };
  }

  // Step 3 — mechanic
  if (ctx.mechanicTargetId && (ctx.isEligible?.(ctx.mechanicTargetId) ?? true)) {
    return { targetId: ctx.mechanicTargetId, mode: 'mechanic_override' };
  }

  // Eligible-only filter
  const eligible = sortedByThreat(input.table).filter((e) => ctx.isEligible?.(e.attackerId) ?? true);
  if (eligible.length === 0) {
    return { targetId: null, mode: 'anti_exploit_fallback', reason: 'no_eligible' };
  }

  // Step 4 — highest threat with hysteresis
  const top = eligible[0];
  if (!top) return { targetId: null, mode: 'anti_exploit_fallback' };
  // Hysteresis: if currentTarget exists and is in eligible AND difference < threshold,
  // keep currentTarget (prevents oscillation).
  if (input.currentTargetId) {
    const cur = eligible.find((e) => e.attackerId === input.currentTargetId);
    if (cur && top.attackerId !== cur.attackerId) {
      const diff = top.threat - cur.threat;
      if (diff < ThreatConstants.TARGET_SWITCH_HYSTERESIS_BP) {
        return { targetId: cur.attackerId, mode: 'highest_threat', reason: 'hysteresis' };
      }
    }
  }

  // Step 5 — nearest if distanceMap provided AND top threat is contested
  if (ctx.distanceMap && eligible.length > 1) {
    const second = eligible[1]!;
    if (Math.abs(top.threat - second.threat) <= ThreatConstants.TARGET_SWITCH_HYSTERESIS_BP) {
      // Contested → pick nearer
      const dTop = ctx.distanceMap.get(top.attackerId) ?? Infinity;
      const dSecond = ctx.distanceMap.get(second.attackerId) ?? Infinity;
      if (dSecond < dTop) {
        return { targetId: second.attackerId, mode: 'nearest_threat' };
      }
    }
  }

  // Step 6 — anti-exploit: if top has 0 threat (suspicious), pick second
  if (top.threat === 0 && eligible.length > 1) {
    return {
      targetId: eligible[1]!.attackerId,
      mode: 'anti_exploit_fallback',
      reason: 'top_threat_zero',
    };
  }

  return { targetId: top.attackerId, mode: 'highest_threat' };
}
