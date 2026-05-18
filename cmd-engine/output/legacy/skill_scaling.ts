/**
 * SKILL SCALING — Lv1→Lv10 framework (Phase 3 spec § VII).
 *
 * RULES:
 *   - linear-friendly (no exponential explosion)
 *   - data-driven coefficient arrays per skill (length === SCALING_LV_MAX)
 *   - growth cap SCALING_LINEAR_MAX_GROWTH_BP (anti late-game power creep)
 *   - INT BP scale (R30/R31)
 */
import type { SkillTemplate } from './skill_types.js';
import { SkillConstants } from './skill_constants.js';

export interface ScalingResult {
  baseDamage: number;
  baseHeal: number;
  scalingBP: number;
  healScalingBP: number;
  accuracyModBP: number;
  penetrationBP: number;
}

/** Clamp level to valid range. */
export function clampLevel(level: number): number {
  if (!Number.isFinite(level) || level < SkillConstants.SCALING_LV_MIN) return SkillConstants.SCALING_LV_MIN;
  if (level > SkillConstants.SCALING_LV_MAX) return SkillConstants.SCALING_LV_MAX;
  return Math.floor(level);
}

/** Pick array element at level idx, with safe clamp. */
function pickAt<T>(arr: readonly T[] | undefined, level: number, fallback: T): T {
  if (!arr || arr.length === 0) return fallback;
  const idx = Math.max(0, Math.min(level - 1, arr.length - 1));
  return arr[idx] ?? fallback;
}

/**
 * Resolve all scaling values for skill at given level.
 * Pure deterministic.
 */
export function resolveScaling(skill: SkillTemplate, level: number): ScalingResult {
  const lv = clampLevel(level);
  return {
    baseDamage: pickAt(skill.base_damage_by_level, lv, 0),
    baseHeal: pickAt(skill.base_heal_by_level, lv, 0),
    scalingBP: pickAt(skill.scaling_bp_by_level, lv, 0),
    healScalingBP: pickAt(skill.heal_scaling_bp_by_level, lv, 0),
    accuracyModBP: pickAt(skill.accuracy_mod_bp_by_level, lv, 0),
    penetrationBP: pickAt(skill.penetration_bp_by_level, lv, 0),
  };
}

/**
 * Audit growth — check skill array doesn't exceed linear growth cap.
 * Returns list of violation skill ids. Caller (data validator) wires to CI.
 */
export function auditScalingGrowth(skill: SkillTemplate): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  const fields: ReadonlyArray<keyof SkillTemplate> = [
    'base_damage_by_level',
    'base_heal_by_level',
    'scaling_bp_by_level',
    'heal_scaling_bp_by_level',
  ];
  for (const f of fields) {
    const arr = skill[f] as number[] | undefined;
    if (!arr || arr.length < 2) continue;
    const first = arr[0] ?? 0;
    const last = arr[arr.length - 1] ?? 0;
    if (first <= 0) continue;
    const growthBP = Math.floor(((last - first) * 10000) / first);
    if (growthBP > SkillConstants.SCALING_LINEAR_MAX_GROWTH_BP) {
      violations.push(`${skill.id}.${String(f)}: growth=${growthBP}BP > cap ${SkillConstants.SCALING_LINEAR_MAX_GROWTH_BP}`);
    }
  }
  return { ok: violations.length === 0, violations };
}
