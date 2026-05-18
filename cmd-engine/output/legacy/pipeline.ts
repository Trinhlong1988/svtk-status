/**
 * COMBAT PIPELINE — 12-step `resolveSkillCast()` (Module 1, spec/02 §III).
 *
 * Pure function (Layer 2): mutates caster.mana / target.hp / cooldowns trên reference truyền vào,
 * KHÔNG touch global state, KHÔNG I/O. Replay-safe: same input + same RNG seed → same output.
 *
 * 12-step (combat formula spec):
 *   1. CC check (silenced/stunned/frozen → cast_failed)
 *   2. Cooldown check
 *   3. Mana cost (deduct hoặc fail)
 *   4. Accuracy (rollHit) — miss → return early
 *   5-8. F-1 calcDamage (Element / Crit / Defense / Shield / Final mod chained INT)
 *   9. Apply effects — emit `effect_applied` cho Module 2 status handler subscribe
 *  10. Threat — delegate ThreatService nếu inject
 *  11. Death check — set hp=0, alive=false, emit `death`
 *  12. Passive trigger — emit cast/hit/death events; passive listener subscribe phase 'post_resolve'
 *
 * Module 3 sẽ wrap qua `SkillDB.get(skillId)` rồi gọi function này.
 */
import { calcDamage, calcHeal, rollHit } from './formula.js';
import { Constants } from './constants.js';
import type { EventBus } from './event_bus.js';
import type { CombatChar, CombatContext, SkillCombat, Role } from './types.js';
import type { ThreatService } from '../server/threat_service.js';
import type { StateMutation } from '../server/state_delta.js';

/**
 * Extended context cho pipeline: bus + optional ThreatService + optional mutationLog.
 *
 * Layer 3 ThreatService injection: caller (encounter manager) tạo + truyền qua.
 *
 * `mutationLog` (FIX #7): nếu inject → pipeline push StateMutation per direct mutation
 * (hp/mana/cooldown/alive). Backward compat: nếu undefined, mutation vẫn happen direct
 * — KHÔNG đổi semantics (per Mr.Long instruction). Module 10 Network sẽ wire để
 * rollback / netcode replay.
 */
export interface PipelineContext extends CombatContext {
  bus: EventBus;
  threat?: ThreatService;
  mutationLog?: StateMutation[];
}

/** Push mutation to log (if enabled). Returns next seq number. */
function logMutation(
  ctx: PipelineContext,
  path: readonly (string | number)[],
  oldValue: number | string | boolean | null,
  newValue: number | string | boolean | null,
): void {
  if (!ctx.mutationLog) return;
  ctx.mutationLog.push({
    seq: ctx.mutationLog.length,
    path,
    value: newValue,
    oldValue,
  });
}

export type CastFailReason =
  | 'cc_blocked'
  | 'on_cooldown'
  | 'no_mana'
  | 'miss'
  | 'invalid_target';

export type CastResolution =
  | {
      ok: true;
      damage?: number;
      heal?: number;
      isCrit?: boolean;
      targetDied?: boolean;
      effectsApplied?: number;
    }
  | { ok: false; reason: CastFailReason };

// ─────────────────────────────────────────────────────────
// Threat role multiplier — placeholder until Module 4 chốt
// ─────────────────────────────────────────────────────────

/**
 * Per-role threat multiplier BP (CLAUDE.md mục 14).
 *
 * spec/06 §III ghi "Tank ×2,5 / DPS ×1,0 / Summoner ×0,5 / Support ×1,2".
 * Module 4 sẽ extract vào `data/constants.json` THREAT_ROLE_MOD_<ROLE>_BP keys.
 * Phase 1 dùng default 10000 (×1.0 mọi role) — pipeline integration test không depend role.
 */
function getRoleThreatModBP(_role: Role): number {
  return 10000; // TODO Module 4: lookup THREAT_ROLE_MOD_<role>_BP
}

// ─────────────────────────────────────────────────────────
// Resolve
// ─────────────────────────────────────────────────────────

function setCooldown(
  caster: CombatChar,
  skill: SkillCombat,
  currentTurn: number,
  ctx: PipelineContext,
): void {
  if (skill.cooldown && skill.cooldown > 0) {
    const newCd = currentTurn + skill.cooldown;
    const oldCd = caster.cooldowns[skill.id] ?? 0;
    caster.cooldowns[skill.id] = newCd;
    logMutation(ctx, ['chars', caster.id, 'cooldowns', skill.id], oldCd, newCd);
  }
}

function manaCostFor(skill: SkillCombat, skillLevel: number): number {
  return skill.mana_cost_by_level?.[skillLevel - 1] ?? 0;
}

function emitEffects(
  bus: EventBus,
  turn: number,
  targetId: string,
  skill: SkillCombat,
  skillLevel: number,
): number {
  const effs = skill.effects ?? [];
  for (const eff of effs) {
    const duration = eff.duration_by_level?.[skillLevel - 1] ?? 1;
    bus.emit({
      type: 'effect_applied',
      turn,
      targetId,
      effectType: eff.type,
      duration,
    });
  }
  return effs.length;
}

/**
 * Resolve 1 skill cast end-to-end.
 *
 * @param skill        SkillCombat data (Module 3 sẽ load qua SkillDB.get(id))
 * @param skillLevel   1..10
 * @param caster       mutable — mana + cooldowns updated
 * @param target       mutable — hp + alive updated
 * @param ctx          PipelineContext (encounter + bus + threat service)
 */
export function resolveSkillCast(
  skill: SkillCombat,
  skillLevel: number,
  caster: CombatChar,
  target: CombatChar,
  ctx: PipelineContext,
): CastResolution {
  // Step 1 — CC
  if (caster.cc.silenced || caster.cc.stunned || caster.cc.frozen) {
    ctx.bus.emit({ type: 'cast_failed', turn: ctx.turn, casterId: caster.id, reason: 'cc_blocked' });
    return { ok: false, reason: 'cc_blocked' };
  }

  // Step 2 — Cooldown
  const cdReady = caster.cooldowns[skill.id] ?? 0;
  if (cdReady > ctx.turn) {
    ctx.bus.emit({ type: 'cast_failed', turn: ctx.turn, casterId: caster.id, reason: 'on_cooldown' });
    return { ok: false, reason: 'on_cooldown' };
  }

  // Step 3 — Mana
  const manaCost = manaCostFor(skill, skillLevel);
  if (caster.mana < manaCost) {
    ctx.bus.emit({ type: 'cast_failed', turn: ctx.turn, casterId: caster.id, reason: 'no_mana' });
    return { ok: false, reason: 'no_mana' };
  }
  const oldMana = caster.mana;
  caster.mana -= manaCost;
  logMutation(ctx, ['chars', caster.id, 'mana'], oldMana, caster.mana);

  // Cast event (Module 2/5 passive listener subscribes phase 'post_resolve')
  ctx.bus.emit({
    type: 'cast',
    turn: ctx.turn,
    casterId: caster.id,
    skillId: skill.id,
    targetId: target.id,
  });

  // Branch by skill type
  if (skill.type === 'damage') {
    // Step 4 — Hit roll (F-3) — substream rng_hit if available (FIX #1)
    const hitRng = ctx.rngStream ? ctx.rngStream.sub('rng_hit') : ctx.rng;
    if (!rollHit(caster, target, skill, hitRng)) {
      ctx.bus.emit({
        type: 'miss',
        turn: ctx.turn,
        casterId: caster.id,
        targetId: target.id,
        reason: 'accuracy',
      });
      setCooldown(caster, skill, ctx.turn, ctx);
      return { ok: false, reason: 'miss' };
    }

    // Step 5-8 — F-1 chain (Element / Crit / Defense / Shield / Final mod)
    const breakdown = calcDamage(caster, target, skill, skillLevel, ctx, ctx.rng);
    const oldHp = target.hp;
    target.hp -= breakdown.damage;
    logMutation(ctx, ['chars', target.id, 'hp'], oldHp, target.hp);
    ctx.bus.emit({
      type: 'hit',
      turn: ctx.turn,
      casterId: caster.id,
      targetId: target.id,
      damage: breakdown.damage,
      isCrit: breakdown.isCrit,
    });

    // Step 9 — Effects (Module 2 status handler subscribes 'effect_applied' phase 'resolve')
    const effectsApplied = emitEffects(ctx.bus, ctx.turn, target.id, skill, skillLevel);

    // Step 10 — Threat (delegate Layer 3 ThreatService nếu inject)
    if (ctx.threat && breakdown.damage > 0) {
      const delta = ctx.threat.addThreat(
        ctx.encounterId,
        caster.id,
        { type: 'damage', amount: breakdown.damage, isCrit: breakdown.isCrit },
        ctx.turn,
        Constants.THREAT_COEF_DAMAGE_BP,
        getRoleThreatModBP(caster.role),
      );
      ctx.bus.emit({
        type: 'threat_change',
        turn: ctx.turn,
        targetId: caster.id,
        casterId: caster.id,
        delta,
      });
    }

    // Step 11 — Death
    let died = false;
    if (target.hp <= 0) {
      const oldHp2 = target.hp;
      target.hp = 0;
      target.alive = false;
      died = true;
      logMutation(ctx, ['chars', target.id, 'hp'], oldHp2, 0);
      logMutation(ctx, ['chars', target.id, 'alive'], true, false);
      ctx.bus.emit({
        type: 'death',
        turn: ctx.turn,
        victimId: target.id,
        killerId: caster.id,
      });
    }

    // Step 12 — Passive trigger handled qua EventBus subscribers (post_resolve phase),
    // không có invocation tường minh trong pipeline.

    setCooldown(caster, skill, ctx.turn, ctx);
    return {
      ok: true,
      damage: breakdown.damage,
      isCrit: breakdown.isCrit,
      targetDied: died,
      effectsApplied,
    };
  }

  if (skill.type === 'heal') {
    // Heal: skip hit/crit (R5 — heal hits all), straight to F-2
    const breakdown = calcHeal(caster, target, skill, skillLevel, ctx, ctx.rng);
    const oldHpHeal = target.hp;
    target.hp += breakdown.heal;
    logMutation(ctx, ['chars', target.id, 'hp'], oldHpHeal, target.hp);
    ctx.bus.emit({
      type: 'heal',
      turn: ctx.turn,
      casterId: caster.id,
      targetId: target.id,
      heal: breakdown.heal,
    });

    const effectsApplied = emitEffects(ctx.bus, ctx.turn, target.id, skill, skillLevel);

    if (ctx.threat && breakdown.heal > 0) {
      const delta = ctx.threat.addThreat(
        ctx.encounterId,
        caster.id,
        { type: 'heal', amount: breakdown.heal },
        ctx.turn,
        Constants.THREAT_COEF_HEAL_BP,
        getRoleThreatModBP(caster.role),
      );
      ctx.bus.emit({
        type: 'threat_change',
        turn: ctx.turn,
        targetId: caster.id,
        casterId: caster.id,
        delta,
      });
    }

    setCooldown(caster, skill, ctx.turn, ctx);
    return { ok: true, heal: breakdown.heal, effectsApplied };
  }

  // Step 9 only — non-damage/heal skills (cc / buff / debuff / shield / utility) emit effects
  // Module 2 status handler resolves actual state mutation.
  const effectsApplied = emitEffects(ctx.bus, ctx.turn, target.id, skill, skillLevel);
  setCooldown(caster, skill, ctx.turn, ctx);
  return { ok: true, effectsApplied };
}
