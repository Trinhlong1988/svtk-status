/**
 * SKILL MANA ENGINE — validate / consume / refund (Phase 3 spec § IX).
 *
 * Rules:
 *   - NO negative mana
 *   - NO overflow (cap maxMana)
 *   - Mana cost reduction modifier BP capped MANA_COST_REDUCTION_CAP_BP
 *   - Pure: mutates target.mana directly per R33 (caller direct mutation)
 */
import type { CombatChar } from './types.js';
import type { SkillTemplate } from './skill_types.js';
import { SkillConstants } from './skill_constants.js';
import { chainMul } from './constants.js';

/**
 * Compute final mana cost after reduction modifier.
 * @param baseCost — skill mana_cost_by_level[level-1]
 * @param costReductionBP — caster's flat reduction (10000 = no change, 12000 = +20% reduction)
 *                         CAP MANA_COST_REDUCTION_CAP_BP (max 75% reduction).
 */
export function computeFinalManaCost(baseCost: number, costReductionBP: number): number {
  if (baseCost <= 0) return 0;
  if (costReductionBP <= 10000) return baseCost;
  const reductionBP = Math.min(costReductionBP - 10000, SkillConstants.MANA_COST_REDUCTION_CAP_BP);
  const remainBP = 10000 - reductionBP;
  return Math.max(0, Math.floor(chainMul(baseCost, remainBP)));
}

/**
 * Get base mana cost for skill at level.
 */
export function getBaseManaCost(skill: SkillTemplate, level: number): number {
  const lvIdx = Math.max(0, Math.min(level - 1, skill.mana_cost_by_level.length - 1));
  return skill.mana_cost_by_level[lvIdx] ?? 0;
}

/**
 * Check caster can pay mana cost.
 */
export function canPay(caster: CombatChar, skill: SkillTemplate, level: number, costReductionBP: number = 10000): boolean {
  const baseCost = getBaseManaCost(skill, level);
  const finalCost = computeFinalManaCost(baseCost, costReductionBP);
  return caster.mana >= finalCost;
}

/**
 * Pay mana cost. Returns actual cost paid. Mutates caster.mana directly (R33).
 *
 * Caller MUST canPay() first. If insufficient, returns 0 and does NOT mutate.
 */
export function payMana(caster: CombatChar, skill: SkillTemplate, level: number, costReductionBP: number = 10000): number {
  const baseCost = getBaseManaCost(skill, level);
  const finalCost = computeFinalManaCost(baseCost, costReductionBP);
  if (caster.mana < finalCost) return 0;
  caster.mana = Math.max(0, caster.mana - finalCost);
  return finalCost;
}

/**
 * Refund mana (skill failure, passive proc). Capped at maxMana.
 */
export function refundMana(caster: CombatChar, amount: number): number {
  if (amount <= 0) return 0;
  const before = caster.mana;
  caster.mana = Math.min(caster.maxMana, caster.mana + amount);
  return caster.mana - before;
}

/**
 * Restore mana to full (vd post-encounter heal).
 */
export function restoreToMax(caster: CombatChar): number {
  const before = caster.mana;
  caster.mana = caster.maxMana;
  return caster.mana - before;
}
