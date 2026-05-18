/**
 * SKILL VALIDATOR — typed errors only (Phase 3 spec § X).
 *
 * Validate caster + target + state BEFORE pipeline resolve.
 * Throws typed `SkillValidationError` (caller catch + map to telemetry / response).
 */
import type { CombatChar } from './types.js';
import type { SkillTemplate, SkillCastRequest } from './skill_types.js';
import { canPay, getBaseManaCost, computeFinalManaCost } from './skill_mana.js';
import { canCast, getCooldownRemaining } from './skill_cooldown.js';
import type { CooldownState } from './skill_types.js';

export type SkillValidationCode =
  | 'silenced'
  | 'frozen'
  | 'stunned'
  | 'dead_caster'
  | 'invalid_target'
  | 'no_mana'
  | 'on_cooldown'
  | 'weapon_restriction'
  | 'role_restriction'
  | 'level_restriction'
  | 'range_invalid'
  | 'dead_target'
  | 'malformed_payload';

export class SkillValidationError extends Error {
  constructor(
    public readonly code: SkillValidationCode,
    public readonly skillId: string,
    public readonly casterId: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(`[SkillValidation] code=${code} skill=${skillId} caster=${casterId} meta=${JSON.stringify(meta ?? {})}`);
    this.name = 'SkillValidationError';
  }
}

export interface SkillValidationContext {
  cooldown: CooldownState;
  /** Optional caster cost reduction (default 10000). */
  manaCostReductionBP?: number;
  /** Optional caster equipped weapon tags (e.g. ['sword', 'two_handed']). */
  equippedWeaponTags?: readonly string[];
  /** Distance to primary target (for range check). undefined = skip check. */
  distanceToPrimary?: number;
}

/**
 * Validate cast pre-resolve. Throws SkillValidationError on first failure.
 *
 * Order matters (cheap → expensive):
 *   1. dead_caster
 *   2. cc (frozen / stunned / silenced — silenced ONLY blocks "skill" type, NOT basic attack)
 *   3. role/level/weapon (cheap lookup)
 *   4. mana
 *   5. cooldown
 *   6. target shape (primary id present nếu non-self/aoe-list)
 *   7. range
 */
export function validateCast(
  caster: CombatChar,
  skill: SkillTemplate,
  request: SkillCastRequest,
  ctx: SkillValidationContext,
): void {
  // 1. Dead caster
  if (!caster.alive) {
    throw new SkillValidationError('dead_caster', skill.id, caster.id);
  }
  // 2. CC checks
  if (caster.cc.frozen && caster.cc.frozen > 0) {
    throw new SkillValidationError('frozen', skill.id, caster.id, { remaining: caster.cc.frozen });
  }
  if (caster.cc.stunned && caster.cc.stunned > 0) {
    throw new SkillValidationError('stunned', skill.id, caster.id, { remaining: caster.cc.stunned });
  }
  // Silence blocks any non-utility/non-self skill (typical MMO rule).
  if (caster.cc.silenced && caster.cc.silenced > 0 && skill.target_mode !== 'self') {
    throw new SkillValidationError('silenced', skill.id, caster.id, { remaining: caster.cc.silenced });
  }
  // 3. Role/level/weapon
  if (skill.requires_min_level && caster.level < skill.requires_min_level) {
    throw new SkillValidationError('level_restriction', skill.id, caster.id, {
      required: skill.requires_min_level, actual: caster.level,
    });
  }
  if (skill.requires_role && skill.requires_role.length > 0 && !skill.requires_role.includes(caster.role)) {
    throw new SkillValidationError('role_restriction', skill.id, caster.id, {
      required: skill.requires_role, actual: caster.role,
    });
  }
  if (skill.requires_weapon && skill.requires_weapon.length > 0) {
    const equipped = ctx.equippedWeaponTags ?? [];
    if (!skill.requires_weapon.some((w) => equipped.includes(w))) {
      throw new SkillValidationError('weapon_restriction', skill.id, caster.id, {
        required: skill.requires_weapon, equipped,
      });
    }
  }
  // 4. Mana
  if (!canPay(caster, skill, request.level, ctx.manaCostReductionBP ?? 10000)) {
    const baseCost = getBaseManaCost(skill, request.level);
    const finalCost = computeFinalManaCost(baseCost, ctx.manaCostReductionBP ?? 10000);
    throw new SkillValidationError('no_mana', skill.id, caster.id, {
      required: finalCost, current: caster.mana,
    });
  }
  // 5. Cooldown
  if (!canCast(ctx.cooldown, skill)) {
    throw new SkillValidationError('on_cooldown', skill.id, caster.id, {
      remaining: getCooldownRemaining(ctx.cooldown, skill.id),
      global: ctx.cooldown.global,
    });
  }
  // 6. Target shape
  if (skill.target_mode !== 'self' && skill.target_mode !== 'ally_team' && skill.target_mode !== 'enemy_team') {
    if (skill.target_mode === 'aoe_circle' || skill.target_mode === 'aoe_line') {
      if (!request.resolvedTargetIds || request.resolvedTargetIds.length === 0) {
        throw new SkillValidationError('invalid_target', skill.id, caster.id, { reason: 'aoe_no_resolved' });
      }
    } else if (!request.primaryTargetId) {
      throw new SkillValidationError('invalid_target', skill.id, caster.id, { reason: 'missing_primary' });
    }
  }
  // 7. Range
  if (skill.range !== undefined && ctx.distanceToPrimary !== undefined) {
    if (ctx.distanceToPrimary > skill.range) {
      throw new SkillValidationError('range_invalid', skill.id, caster.id, {
        max: skill.range, actual: ctx.distanceToPrimary,
      });
    }
  }
}
