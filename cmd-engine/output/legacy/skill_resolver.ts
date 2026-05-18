/**
 * SKILL RESOLVER — main resolveSkillCast() Phase 3.
 *
 * Wraps Module 1 pipeline.ts với:
 *   - skill registry dispatch (NO hardcode skillId)
 *   - 9-mode targeting (skillTargeting)
 *   - typed validation (skillValidator)
 *   - cooldown engine (skillCooldown)
 *   - mana engine (skillMana)
 *   - status bridge (skillBridge — NOT direct status apply)
 *   - combo trigger (comboSystem with depth limit)
 *
 * Replay-safe: stable target iteration order, RNG substream per concern.
 *
 * Hot-path: returns SkillResolveResult — caller wires status_requests vào status pipeline
 * + emit cast events. Resolver does NOT call applyEffect directly (decoupled).
 */
import type { CombatChar } from './types.js';
import type {
  SkillCastRequest,
  SkillResolveResult,
  SkillResolveContext,
  ResolvedStatusRequest,
} from './skill_types.js';
import { skillRegistry } from './skill_registry.js';
import { resolveTargets, defaultIsAlly } from './skill_targeting.js';
import {
  validateCast,
  SkillValidationError,
  type SkillValidationContext,
} from './skill_validator.js';
import { startCooldown } from './skill_cooldown.js';
import { payMana } from './skill_mana.js';
import { resolveStatusRequests } from './skill_bridge.js';
import { calcDamage, calcHeal, rollHit } from './formula.js';
import { resolveScaling } from './skill_scaling.js';
import {
  evaluateCombos,
  buildComboCastRequest,
  type ComboCooldownState,
} from './combo_system.js';
import { SkillConstants } from './skill_constants.js';

export interface SkillResolverExtras {
  /** Caster mana cost reduction (default 10000 = no reduction). */
  manaCostReductionBP?: number;
  /** Equipped weapon tags. */
  equippedWeaponTags?: readonly string[];
  /** Distance to primary target. */
  distanceToPrimary?: number;
  /** isAlly predicate (default same playerId or both NPC). */
  isAlly?: (a: CombatChar, b: CombatChar) => boolean;
  /** Combo cooldown state per caster (optional — combo disabled if undefined). */
  comboCooldown?: ComboCooldownState;
  /** Tags currently active in encounter (combo input candidates). */
  presentComboTags?: ReadonlySet<string>;
}

/**
 * Main entry — resolve 1 skill cast end-to-end (Phase 3 wrapper).
 *
 * Returns SkillResolveResult including damage/heal per target + status_requests
 * (caller feeds into Status pipeline). Combo outputs returned as triggered_tags
 * (caller may recursively call resolveSkillCast with depth+1).
 */
export function resolveSkillCast(
  request: SkillCastRequest,
  ctx: SkillResolveContext,
  extras: SkillResolverExtras = {},
): SkillResolveResult {
  // Step 0 — registry dispatch
  const skill = skillRegistry.get(request.skillId);
  if (!skill) return { outcome: 'unknown_skill', reason: `skill '${request.skillId}' not registered` };

  const caster = ctx.chars.get(request.casterId);
  if (!caster) return { outcome: 'invalid_target', reason: `caster '${request.casterId}' missing` };

  const cdState = ctx.cooldownStates.get(caster.id);
  if (!cdState) return { outcome: 'invalid_target', reason: `caster '${caster.id}' has no CooldownState` };

  // Step 1 — validate (typed errors)
  const valCtx: SkillValidationContext = {
    cooldown: cdState,
    manaCostReductionBP: extras.manaCostReductionBP,
    equippedWeaponTags: extras.equippedWeaponTags,
    distanceToPrimary: extras.distanceToPrimary,
  };
  try {
    validateCast(caster, skill, request, valCtx);
  } catch (e) {
    if (e instanceof SkillValidationError) {
      return mapValidationToOutcome(e);
    }
    throw e;
  }

  // Step 2 — target resolve
  const targeting = resolveTargets(request, skill, caster, {
    chars: ctx.chars,
    isAlly: extras.isAlly ?? defaultIsAlly,
  });
  if (targeting.error) {
    return { outcome: 'invalid_target', reason: targeting.error };
  }
  if (targeting.ids.length === 0 && skill.target_mode !== 'self') {
    return { outcome: 'invalid_target', reason: 'no_resolvable_target' };
  }

  // Step 3-4 — mana + cooldown already verified by validateCast; pay mana now.
  payMana(caster, skill, request.level, extras.manaCostReductionBP ?? 10000);

  // Step 5-6 — formula resolve + damage/heal apply per target
  const damagePerTarget = new Map<string, number>();
  const healPerTarget = new Map<string, number>();
  const scaling = resolveScaling(skill, request.level);

  // Build a synthetic SkillCombat for Module 1 formula re-use (compat shim).
  const combatSkill = toSkillCombat(skill, request.level, scaling);

  for (const tid of targeting.ids) {
    const target = ctx.chars.get(tid);
    if (!target) continue;

    if (skill.type === 'damage' || skill.category === 'damage') {
      const hitRng = ctx.rngStream ? ctx.rngStream.sub('rng_hit') : ctx.rng;
      if (!rollHit(caster, target, combatSkill, hitRng)) {
        damagePerTarget.set(tid, 0);
        continue;
      }
      const breakdown = calcDamage(caster, target, combatSkill, request.level, ctx, ctx.rng);
      target.hp = Math.max(0, target.hp - breakdown.damage);
      if (target.hp <= 0) target.alive = false;
      damagePerTarget.set(tid, breakdown.damage);
    } else if (skill.type === 'heal' || skill.category === 'heal') {
      const breakdown = calcHeal(caster, target, combatSkill, request.level, ctx, ctx.rng);
      target.hp = Math.min(target.maxHp, target.hp + breakdown.heal);
      healPerTarget.set(tid, breakdown.heal);
    }
  }

  // Step 7 — status request bridge (caller responsible to feed status engine)
  const statusRequests: ResolvedStatusRequest[] = resolveStatusRequests(skill, request, targeting.ids);

  // Step 8 — threat emit (delegated to caller via ctx.encounter.addThreat for now)
  for (const tid of targeting.ids) {
    const dmg = damagePerTarget.get(tid) ?? 0;
    const heal = healPerTarget.get(tid) ?? 0;
    if (dmg > 0 || heal > 0) {
      const target = ctx.chars.get(tid);
      if (target) ctx.encounter.addThreat(caster, target, dmg + heal);
    }
  }

  // Step 9 — telemetry / event emit
  ctx.bus.emit({
    type: 'cast',
    turn: ctx.turn,
    casterId: caster.id,
    skillId: skill.id,
    targetId: targeting.ids[0] ?? caster.id,
  });

  // Step 10 — replay record handled at higher level (recording layer subscribes to bus)
  // No explicit action here — pipeline emit covers replay observability.

  // Cooldown start (after successful resolve)
  startCooldown(cdState, skill, request.level);

  // Combo evaluation
  const comboTriggeredTags: string[] = [];
  if (extras.comboCooldown && extras.presentComboTags && skill.combo_output_tags && skill.combo_output_tags.length > 0) {
    const depth = (request.comboContext?.depth ?? 0);
    if (depth + 1 < SkillConstants.MAX_COMBO_DEPTH) {
      const merged = new Set(extras.presentComboTags);
      for (const t of skill.combo_output_tags) merged.add(t);
      const outcome = evaluateCombos(merged, depth + 1, extras.comboCooldown);
      for (const trigger of outcome.triggered) {
        comboTriggeredTags.push(...trigger.input_tags);
      }
      // Recursive cast (best-effort, capped by MAX_COMBO_DEPTH).
      for (const o of outcome.outputs) {
        const sub: SkillCastRequest = buildComboCastRequest(
          caster.id,
          o.outputSkillId,
          targeting.ids[0],
          o.rule.input_tags[0] ?? '',
          skill.id,
          depth + 1,
          request.level,
        );
        // Spawn sub-cast — caller may want to capture; we resolve in-line for determinism
        // and ignore output (recorded via bus).
        resolveSkillCast(sub, ctx, extras);
      }
    }
  }

  return {
    outcome: 'resolved',
    damage_per_target: damagePerTarget,
    heal_per_target: healPerTarget,
    status_requests: statusRequests,
    combo_triggered_tags: comboTriggeredTags.length > 0 ? comboTriggeredTags : undefined,
  };
}

/** Map validation error to typed outcome. */
function mapValidationToOutcome(e: SkillValidationError): SkillResolveResult {
  switch (e.code) {
    case 'no_mana':       return { outcome: 'no_mana', reason: e.code };
    case 'on_cooldown':   return { outcome: 'on_cooldown', reason: e.code };
    case 'silenced':
    case 'frozen':
    case 'stunned':       return { outcome: 'cc_blocked', reason: e.code };
    case 'invalid_target':
    case 'dead_target':
    case 'range_invalid': return { outcome: 'invalid_target', reason: e.code };
    case 'dead_caster':
    case 'level_restriction':
    case 'role_restriction':
    case 'weapon_restriction':
    case 'malformed_payload':
    default:              return { outcome: 'validation_failed', reason: e.code };
  }
}

/**
 * Convert SkillTemplate → SkillCombat (Module 1 shape) cho calcDamage/calcHeal re-use.
 * Synthesizes single-level array fields from resolved scaling.
 */
function toSkillCombat(
  skill: import('./skill_types.js').SkillTemplate,
  _level: number,
  scaling: ReturnType<typeof resolveScaling>,
): import('./types.js').SkillCombat {
  return {
    id: skill.id,
    type: skill.type,
    damage_type: skill.damage_type,
    element: skill.element,
    base_damage: scaling.baseDamage > 0 ? scaling.baseDamage : undefined,
    base_heal: scaling.baseHeal > 0 ? scaling.baseHeal : undefined,
    scaling_bp: scaling.scalingBP > 0 ? [scaling.scalingBP] : undefined,
    heal_scaling_bp: scaling.healScalingBP > 0 ? [scaling.healScalingBP] : undefined,
    accuracy_mod_bp: scaling.accuracyModBP || undefined,
    penetration_bp: scaling.penetrationBP || undefined,
    mana_cost_by_level: skill.mana_cost_by_level,
    cooldown: skill.cooldown_by_level[0],
    effects: skill.status_requests?.map((sr) => ({
      type: sr.effectType,
      amount: [sr.amount_by_level[0] ?? 0],
      duration_by_level: sr.duration_by_level,
      stack_limit: sr.initialStacks,
      tick_interval: sr.tickInterval,
    })),
  };
}
