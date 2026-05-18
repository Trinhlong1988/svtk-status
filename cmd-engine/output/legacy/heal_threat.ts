/**
 * HEAL THREAT — Phase 4 § V dedicated calc.
 *
 * Heal generates threat to nearby boss based on heal amount × THREAT_COEF_HEAL_BP.
 * Healer role gets +50% heal threat (registry).
 *
 * Pure function — caller (ThreatEngine) consumes delta.
 */
import { ThreatConstants } from './threat_constants.js';
import { BP_DENOM } from './constants.js';

/**
 * Compute heal threat delta. Pure INT BP.
 *
 * @param healAmount  base heal value INT
 * @param roleModBP   role multiplier BP (Healer 12000, default 10000)
 * @returns           threat delta INT ≥ 0
 */
export function calcHealThreatDelta(healAmount: number, roleModBP: number): number {
  if (healAmount <= 0) return 0;
  const coefBP = ThreatConstants.THREAT_COEF_HEAL_BP;
  return Math.floor((healAmount * coefBP * roleModBP) / (BP_DENOM * BP_DENOM));
}

/**
 * Compute HOT (heal-over-time) threat per tick. Same formula as heal but uses HOT coef.
 */
export function calcHotThreatDelta(healPerTick: number, stacks: number, roleModBP: number): number {
  if (healPerTick <= 0 || stacks <= 0) return 0;
  const total = healPerTick * stacks;
  const coefBP = ThreatConstants.THREAT_COEF_HOT_BP;
  return Math.floor((total * coefBP * roleModBP) / (BP_DENOM * BP_DENOM));
}

/**
 * Compute generic source-tagged threat delta.
 * Caller picks coef from ThreatConstants based on ThreatGenerationSource.
 */
export function calcSourceThreatDelta(amount: number, coefBP: number, roleModBP: number): number {
  if (amount <= 0) return 0;
  return Math.floor((amount * coefBP * roleModBP) / (BP_DENOM * BP_DENOM));
}
