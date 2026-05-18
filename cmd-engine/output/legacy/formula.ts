/**
 * COMBAT FORMULA — F1-F7 (Module 1) per spec/02_COMBAT_FORMULA.md.
 *
 * BP fixed-point GLOBAL (CLAUDE.md mục 14, R30): mọi ratio dùng `_bp` × 10000.
 * Pure functions, deterministic — RNG là parameter (R31).
 *
 * Math invariants:
 *   - Stat input INT (HP, mana, sat_luc, defense, ...)
 *   - Ratio input BP (crit_rate=2500 → 25%, accuracy=8500 → 85%)
 *   - Multiplier BP (×1.8 → 18000, ×0.85 → 8500)
 *   - Single intermediate division /10000 sau mỗi cặp nhân (chainMul) chống overflow
 *   - Math.floor cuối cho integer result deterministic cross-platform
 *
 * NO FLOAT trong file này (R31). Float OK ở Layer 3 simulator + Layer 5 client UI.
 */
import type { CombatChar, CombatContext, Role, SkillCombat } from './types.js';
import type { RNG } from './rng.js';
import type { RNGSubstreamKey } from './rng_stream.js';
import { Constants, chainMul, BP_DENOM } from './constants.js';
import { getElementModifierBP } from './element.js';
import { applySoftCap, clampInt } from './soft_cap.js';

/**
 * Pick substream from ctx.rngStream nếu có, else fall back caller-passed RNG (legacy single).
 * (FIX #1 — RNG SUBSTREAM MIGRATION, backward compatible.)
 */
function pickRng(ctx: CombatContext, key: RNGSubstreamKey, fallback: RNG): RNG {
  return ctx.rngStream ? ctx.rngStream.sub(key) : fallback;
}

// ─────────────────────────────────────────────────────────
// F-3 helpers — accuracy / crit roll
// ─────────────────────────────────────────────────────────

/**
 * Hit roll (F-3 spec/02 §II).
 * @returns true nếu hit, false nếu miss
 */
export function rollHit(
  caster: CombatChar,
  target: CombatChar,
  skill: SkillCombat,
  rng: RNG,
): boolean {
  const levelDiffBP = (caster.level - target.level) * Constants.HIT_LEVEL_DIFF_BP;
  const skillAccMod = skill.accuracy_mod_bp ?? 0;
  const raw = caster.accuracy - target.dodge + levelDiffBP + skillAccMod;
  const chance = clampInt(raw, Constants.HIT_FLOOR_BP, Constants.HIT_CEIL_BP);
  return rng() * BP_DENOM < chance;
}

/**
 * Crit roll với soft cap DR (F-3 + R24).
 *
 * Uses `ctx.rngStream.sub('rng_crit')` if available (FIX #1 substream migration),
 * else fall back to caller-passed `rng` (legacy single stream).
 */
export function rollCrit(
  caster: CombatChar,
  target: CombatChar,
  rng: RNG,
  ctx?: CombatContext,
): boolean {
  const raw = caster.crit_rate - target.anti_crit;
  const chance = applySoftCap(
    Math.max(0, raw),
    Constants.CRIT_CAP_BP,
    Constants.CRIT_DR_DIVIDER,
  );
  const r = ctx ? pickRng(ctx, 'rng_crit', rng) : rng;
  return r() * BP_DENOM < chance;
}

// ─────────────────────────────────────────────────────────
// F-5 + F-6 — Penetration + Defense reduction
// ─────────────────────────────────────────────────────────

/**
 * F-5 Penetration: giảm DEF mục tiêu theo penetration cap (R5).
 * @returns DEF effective sau penetration (integer)
 */
export function applyPenetrationToDef(targetDef: number, penBP: number): number {
  const cappedPen = Math.min(Math.max(0, penBP), Constants.PEN_CAP_TOTAL_BP);
  return Math.floor((targetDef * (BP_DENOM - cappedPen)) / BP_DENOM);
}

/**
 * F-6 Defense reduction (asymptotic K_DEF formula).
 * `def_reduction_bp = K_DEF × 10000 / (DEF_eff + K_DEF)`
 * → DEF=0 → 10000 (no reduction); DEF=K_DEF → 5000 (50% reduction).
 *
 * @returns multiplier BP áp lên damage (sau reduction)
 */
export function calcDefenseReductionBP(target: CombatChar, penBP: number = 0): number {
  const defEff = applyPenetrationToDef(target.defense, penBP);
  return Math.floor((Constants.K_DEF * BP_DENOM) / (defEff + Constants.K_DEF));
}

/**
 * Shield absorb reduction.
 *  - shield=0 → 10000 BP (full damage through)
 *  - shield=5000 → 5000 BP (50% absorbed)
 *  - shield ≥ 10000 → 0 BP (full block)
 *
 * Shield value cùng scale với BP — designer dễ chuyển đổi.
 */
export function calcShieldReductionBP(shield: number): number {
  if (shield <= 0) return BP_DENOM;
  return Math.max(0, BP_DENOM - shield);
}

// ─────────────────────────────────────────────────────────
// F-7 — Final modifier (PvP red, vulnerability, role)
// ─────────────────────────────────────────────────────────

const ROLE_DAMAGE_MOD_BP: Record<Role, () => number> = {
  Tank: () => Constants.ROLE_DAMAGE_MOD_TANK_BP,
  Healer: () => Constants.ROLE_DAMAGE_MOD_HEALER_BP,
  DPS_VL: () => Constants.ROLE_DAMAGE_MOD_DPS_BP,
  DPS_PH: () => Constants.ROLE_DAMAGE_MOD_DPS_BP,
  Support: () => Constants.ROLE_DAMAGE_MOD_SUPPORT_BP,
  Control: () => Constants.ROLE_DAMAGE_MOD_TANK_BP,    // chưa chốt — Module 5 NPC
  Summoner: () => Constants.ROLE_DAMAGE_MOD_TANK_BP,   // chưa chốt — Module 5 NPC
};

function getRoleDamageModBP(role: Role): number {
  return (ROLE_DAMAGE_MOD_BP[role] ?? ROLE_DAMAGE_MOD_BP.Tank)();
}

function sumVulnerabilityBP(target: CombatChar): number {
  let sum = 0;
  for (const d of target.debuffs) {
    if (d.type === 'vulnerability') sum += d.value;
  }
  return sum;
}

/**
 * F-7 Final modifier — multiplier BP.
 * Chain: pvp_red × (10000 + vulnerability) × role_mod, intermediate /10000.
 */
export function calcFinalModifierBP(
  _caster: CombatChar,
  target: CombatChar,
  _skill: SkillCombat,
  ctx: CombatContext,
): number {
  const pvpRed = ctx.mode === 'pvp' ? Constants.PVP_DAMAGE_REDUCTION_BP : BP_DENOM;
  const vulnFactor = BP_DENOM + sumVulnerabilityBP(target);
  const roleMod = getRoleDamageModBP(target.role);

  let m = pvpRed;
  m = chainMul(m, vulnFactor);
  m = chainMul(m, roleMod);
  return m;
}

// ─────────────────────────────────────────────────────────
// Damage jitter — deterministic seeded
// ─────────────────────────────────────────────────────────

function rollJitterBP(rng: RNG, ctx?: CombatContext): number {
  const lo = Constants.DAMAGE_JITTER_LO_BP;
  const hi = Constants.DAMAGE_JITTER_HI_BP;
  const r = ctx ? pickRng(ctx, 'rng_jitter', rng) : rng;
  return lo + Math.floor(r() * (hi - lo + 1));
}

// ─────────────────────────────────────────────────────────
// F-1 — DAMAGE FORMULA
// ─────────────────────────────────────────────────────────

/**
 * Result của 1 lần resolve damage.
 * isCrit + jitter exposed cho EventBus + replay verification.
 */
export interface DamageBreakdown {
  damage: number;
  isCrit: boolean;
  jitter_bp: number;
  elementMod_bp: number;
  defReduction_bp: number;
  shieldReduction_bp: number;
  finalMod_bp: number;
}

/**
 * F-1 Damage Formula — INT BP, deterministic.
 *
 * @returns DamageBreakdown — damage integer + intermediates cho debug/log
 */
export function calcDamage(
  caster: CombatChar,
  target: CombatChar,
  skill: SkillCombat,
  skillLevel: number,
  ctx: CombatContext,
  rng: RNG,
): DamageBreakdown {
  const baseDmg = skill.base_damage ?? 0;
  const scalingBP = skill.scaling_bp?.[skillLevel - 1] ?? BP_DENOM;

  const isPhysical = (skill.damage_type ?? 'physical') !== 'magical';
  const stat = isPhysical ? caster.sat_luc : caster.phap_luc;
  // attack_mod = stat / 100 → BP = stat × 100 (vì /100 × 10000 = ×100)
  const attackModBP = stat * 100;

  const isCrit = rollCrit(caster, target, rng, ctx);
  const elementModBP = getElementModifierBP(skill.element, target.element);
  const critModBP = isCrit ? Constants.CRIT_DAMAGE_MULTIPLIER_BP : BP_DENOM;
  const defRedBP = calcDefenseReductionBP(target, skill.penetration_bp ?? 0);
  const shieldRedBP = calcShieldReductionBP(target.shield);
  const finalModBP = calcFinalModifierBP(caster, target, skill, ctx);
  const jitterBP = rollJitterBP(rng, ctx);

  // Scaled base = baseDmg * scaling / 10000
  const scaledBase = Math.floor((baseDmg * scalingBP) / BP_DENOM);

  // Chain multipliers BP — keep result BP between steps
  let mult = elementModBP;
  mult = chainMul(mult, critModBP);
  mult = chainMul(mult, defRedBP);
  mult = chainMul(mult, shieldRedBP);
  mult = chainMul(mult, finalModBP);
  mult = chainMul(mult, jitterBP);
  mult = chainMul(mult, attackModBP);

  const damage = Math.max(0, Math.floor((scaledBase * mult) / BP_DENOM));

  return {
    damage,
    isCrit,
    jitter_bp: jitterBP,
    elementMod_bp: elementModBP,
    defReduction_bp: defRedBP,
    shieldReduction_bp: shieldRedBP,
    finalMod_bp: finalModBP,
  };
}

// ─────────────────────────────────────────────────────────
// F-2 — HEAL FORMULA
// ─────────────────────────────────────────────────────────

export interface HealBreakdown {
  heal: number;
  jitter_bp: number;
  antiHeal_bp: number;
}

/**
 * F-2 Heal Formula — INT BP.
 * Cap overheal: heal ≤ target.maxHp - target.hp.
 */
export function calcHeal(
  caster: CombatChar,
  target: CombatChar,
  skill: SkillCombat,
  skillLevel: number,
  _ctx: CombatContext,    // used for rng_jitter substream pick
  rng: RNG,
): HealBreakdown {
  const baseHeal = skill.base_heal ?? 0;
  const scalingBP = skill.heal_scaling_bp?.[skillLevel - 1] ?? BP_DENOM;

  const healModBP = caster.phap_luc * 100;   // /100 × 10000 = ×100
  const hasAntiHeal = target.debuffs.some((d) => d.type === 'anti_heal');
  const antiHealBP = hasAntiHeal ? Constants.ANTI_HEAL_MULT_BP : BP_DENOM;
  const jitterBP = rollJitterBP(rng, _ctx);

  const scaledBase = Math.floor((baseHeal * scalingBP) / BP_DENOM);
  let mult = healModBP;
  mult = chainMul(mult, antiHealBP);
  mult = chainMul(mult, jitterBP);

  const rawHeal = Math.max(0, Math.floor((scaledBase * mult) / BP_DENOM));
  const room = Math.max(0, target.maxHp - target.hp);
  const heal = Math.min(rawHeal, room);

  return { heal, jitter_bp: jitterBP, antiHeal_bp: antiHealBP };
}
