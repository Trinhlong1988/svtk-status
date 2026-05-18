/**
 * SKILL COOLDOWN ENGINE — local + global + shared group + haste (Phase 3 spec § VIII).
 *
 * State per caster:
 *   - perSkill: Map<skillId, remainingTurns>
 *   - perGroup: Map<cooldown_group, remainingTurns>
 *   - global:   global cooldown remaining
 *   - hasteBP:  caster's haste (10000 = no change)
 *
 * Pure functions. Caller (encounter manager) calls tickCooldown() per turn end.
 */
import type { SkillTemplate, CooldownState } from './skill_types.js';
import { SkillConstants } from './skill_constants.js';
import { chainMul } from './constants.js';

/**
 * Apply haste reduction to base cooldown.
 * haste BP > 10000 → faster (reduce); BP < 10000 → slower (extend).
 *
 * Cap: HASTE_COOLDOWN_REDUCTION_CAP_BP (max reduction 50%).
 */
export function applyHasteToCooldown(baseTurns: number, hasteBP: number): number {
  if (baseTurns <= 0) return 0;
  if (hasteBP === 10000) return baseTurns;
  if (hasteBP > 10000) {
    const reductionBP = Math.min(hasteBP - 10000, SkillConstants.HASTE_COOLDOWN_REDUCTION_CAP_BP);
    // newCD = base × (10000 - reduction) / 10000
    const factor = 10000 - reductionBP;
    return Math.max(0, Math.floor(chainMul(baseTurns, factor)));
  }
  // Slower (hasteBP < 10000)
  const slowFactor = chainMul(baseTurns, hasteBP);
  return Math.max(baseTurns, Math.floor(slowFactor));
}

/**
 * Boss cooldown modifier (FIX PHASE 3 § XVIII).
 *
 * Boss có cooldown khác player (vd boss enrage phase = 50% cooldown).
 * Composes with haste:  effectiveHaste = haste + bossCooldownModBP (cap reductionCap).
 *
 * @param baseHasteBP    caster's intrinsic haste (10000 = no change)
 * @param isBoss         true if entity is BOSS sub-type
 * @param bossModBP      boss-specific haste delta BP (data-driven per encounter)
 * @returns              effective haste BP (caller passes to applyHasteToCooldown)
 */
export function applyBossCooldownMod(
  baseHasteBP: number,
  isBoss: boolean,
  bossModBP: number,
): number {
  if (!isBoss || bossModBP === 0) return baseHasteBP;
  // Combine: deltas added; cap by HASTE_COOLDOWN_REDUCTION_CAP_BP relative to 10000
  const combined = baseHasteBP + bossModBP;
  // Allow extension (combined < 10000 OK), allow reduction up to cap.
  const maxHaste = 10000 + SkillConstants.HASTE_COOLDOWN_REDUCTION_CAP_BP;
  return Math.min(combined, maxHaste);
}

/**
 * Check if skill can be cast (no cooldown blocking).
 */
export function canCast(state: CooldownState, skill: SkillTemplate): boolean {
  if (state.global > 0) return false;
  if ((state.perSkill.get(skill.id) ?? 0) > 0) return false;
  if (skill.cooldown_group && (state.perGroup.get(skill.cooldown_group) ?? 0) > 0) return false;
  return true;
}

/**
 * Start cooldown after successful cast. Mutates state.
 */
export function startCooldown(
  state: CooldownState,
  skill: SkillTemplate,
  level: number,
): void {
  const lvIdx = Math.max(0, Math.min(level - 1, skill.cooldown_by_level.length - 1));
  const baseCD = skill.cooldown_by_level[lvIdx] ?? 0;
  const cd = applyHasteToCooldown(baseCD, state.hasteBP);
  if (cd > 0) state.perSkill.set(skill.id, cd);
  if (skill.cooldown_group && cd > 0) {
    // Group CD = max of group's existing remaining and new cd
    const cur = state.perGroup.get(skill.cooldown_group) ?? 0;
    state.perGroup.set(skill.cooldown_group, Math.max(cur, cd));
  }
  // Global CD
  state.global = Math.max(state.global, applyHasteToCooldown(SkillConstants.GLOBAL_COOLDOWN_TURNS, state.hasteBP));
}

/**
 * Tick all cooldowns by 1 turn. Mutates state. Call at end of turn for each caster.
 *
 * Stable iteration: uses Map iteration order (insertion order in JS spec).
 */
export function tickCooldown(state: CooldownState): void {
  if (state.global > 0) state.global -= 1;
  for (const [k, v] of state.perSkill) {
    if (v <= 1) state.perSkill.delete(k);
    else state.perSkill.set(k, v - 1);
  }
  for (const [k, v] of state.perGroup) {
    if (v <= 1) state.perGroup.delete(k);
    else state.perGroup.set(k, v - 1);
  }
}

/**
 * Reduce specific skill cooldown by N turn (passive proc / skill effect).
 */
export function reduceCooldown(
  state: CooldownState,
  skillId: string,
  turns: number,
): void {
  if (turns <= 0) return;
  const cur = state.perSkill.get(skillId);
  if (!cur) return;
  const next = Math.max(0, cur - turns);
  if (next <= 0) state.perSkill.delete(skillId);
  else state.perSkill.set(skillId, next);
}

/**
 * Get current cooldown for skill (0 = ready).
 */
export function getCooldownRemaining(state: CooldownState, skillId: string): number {
  return state.perSkill.get(skillId) ?? 0;
}
