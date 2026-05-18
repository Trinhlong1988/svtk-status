/**
 * COMBAT CONSTANTS — INT fixed-point BP scale (CLAUDE.md mục 14, R30).
 *
 * Single global scale: `_BP` suffix, 10000 = 100%, 1 = 0.01%.
 *
 * Layer 2 hot-path uses INT chain math:
 *   damage_micro = scaledBase × elem_bp × crit_bp × def_bp ...
 *   chain divide /10000 intermediate (chainMul) chống overflow Number safe int (2^53)
 *
 * NO FLOAT in this file or its consumers (R31).
 *
 * Source of truth: data/constants.json (hot-fix-able).
 * Validate: Zod parse on load — crash sớm nếu sai schema.
 */
import { z } from 'zod';
import { Constants as ConstantsLoaderInstance } from './db.js';

const intNonNeg = z.number().int().nonnegative();
const intPositive = z.number().int().positive();

export const ConstantsSchema = z.object({
  // ─── Crit ───
  CRIT_CAP_BP: intNonNeg.max(10000),
  CRIT_DAMAGE_MULTIPLIER_BP: intPositive,
  CRIT_DR_DIVIDER: intPositive,

  // ─── Dodge ───
  DODGE_CAP_BP: intNonNeg.max(10000),
  DODGE_DR_DIVIDER: intPositive,

  // ─── Hit / accuracy ───
  HIT_FLOOR_BP: intNonNeg.max(10000),
  HIT_CEIL_BP: intNonNeg.max(10000),
  HIT_LEVEL_DIFF_BP: intNonNeg,

  // ─── Resist / defense ───
  RESIST_CAP_BP: intNonNeg.max(10000),
  RESIST_DR_DIVIDER: intPositive,

  HASTE_CAP_BP: intNonNeg.max(20000),
  HASTE_DR_DIVIDER: intPositive,

  LIFESTEAL_CAP_BP: intNonNeg.max(10000),
  LIFESTEAL_DR_DIVIDER: intPositive,

  PEN_CAP_TOTAL_BP: intNonNeg.max(10000),
  PEN_CAP_PER_ITEM_BP: intNonNeg.max(10000),

  K_DEF: intPositive,

  // ─── PvP / element / multiplier ───
  PVP_DAMAGE_REDUCTION_BP: intPositive,
  ANTI_HEAL_MULT_BP: intPositive,

  ELEMENT_COUNTER_MULT_BP: intPositive,
  ELEMENT_COUNTERED_MULT_BP: intPositive,
  ELEMENT_NEUTRAL_MULT_BP: intPositive,

  // ─── TÂM ───
  TAM_DAMAGE_NERF_BP: intPositive,
  TAM_MANA_COST_BUMP_BP: intPositive,
  TAM_HARDCC_COOLDOWN_BONUS: intNonNeg,
  TAM_HYBRID_SCALE_BP: intPositive,

  // ─── Threat (R10 + R21) ───
  THREAT_DECAY_PER_TURN_BP: intNonNeg.max(10000),
  THREAT_COEF_DAMAGE_BP: intPositive,
  THREAT_COEF_HEAL_BP: intPositive,
  THREAT_COEF_TAUNT_BP: intPositive,
  THREAT_COEF_GUARD_BP: intPositive,
  THREAT_COEF_SUMMON_BP: intPositive,
  THREAT_COEF_BUFF_BP: intPositive,

  // ─── Role mod (R9) ───
  ROLE_DAMAGE_MOD_TANK_BP: intPositive,
  ROLE_DAMAGE_MOD_HEALER_BP: intPositive,
  ROLE_DAMAGE_MOD_DPS_BP: intPositive,
  ROLE_DAMAGE_MOD_SUPPORT_BP: intPositive,

  // ─── Regen ───
  BASE_REGEN_PER_TURN_BP: intNonNeg.max(10000),
  OOC_REGEN_MULT_BP: intPositive,

  // ─── Status effect DR ───
  FREEZE_DR_LEVEL2_BP: intNonNeg.max(10000),
  FREEZE_DR_LEVEL3_IMMUNE_TURNS: intNonNeg,

  // ─── Damage jitter (deterministic via seedrandom) ───
  DAMAGE_JITTER_LO_BP: intPositive,
  DAMAGE_JITTER_HI_BP: intPositive,
});

export type CombatConstants = z.infer<typeof ConstantsSchema>;

/**
 * Loaded once on first access, cached. Crash sớm nếu schema sai.
 * Hot-fix balance: sửa data/constants.json → restart server (5s) → reload.
 */
export const Constants: CombatConstants = ConstantsLoaderInstance.load(ConstantsSchema);

/**
 * Canonical chain multiplier — divide /10000 sau mỗi cặp nhân (CLAUDE.md mục 14.5).
 * Single source of truth — mọi formula chain dùng helper này, không inline phép chia.
 */
export function chainMul(left: number, right_bp: number): number {
  return Math.floor((left * right_bp) / 10000);
}

/** BP scale denominator (10000) — exposed cho tests + simulator display. */
export const BP_DENOM = 10000;

/**
 * Formula version (FIX #9 FORMULA VERSION LOCK per SVTK.docx Phase 1 hardening).
 *
 * Bump khi đổi F1-F7 formula semantics (vd thay đổi DEF asymptotic, đổi PvP red %,
 * đổi RNG roll order). Replay với recording.formula_version != current → mismatch warn.
 *
 * Convention: integer monotonic. v1 = Phase 1 ship.
 */
export const FORMULA_VERSION = 1;

/**
 * Formula signature hash (FIX #9 expand — auto-detect semantic drift).
 *
 * Stable hash of: 41 CONST values + RNG roll order + key formula functions identity.
 * Recompute mỗi khi `data/constants.json` đổi. Replay recording stamps hash at record-time
 * — mismatch detection without manual FORMULA_VERSION bump (catches accidental change).
 *
 * Algorithm: sort keys + value concat + djb2 hash → hex.
 * Pure deterministic across platforms (no float, INT only).
 */
function djb2Hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

export function computeFormulaSignatureHash(): string {
  const keys = Object.keys(Constants).sort();
  const ratesPart = keys.map((k) => `${k}=${(Constants as Record<string, number>)[k]}`).join('|');
  // RNG roll order semantic — bump khi pipeline đổi consume order
  const rngOrder = 'rng_hit→rng_crit→rng_jitter';
  // F1-F7 identity — bump khi đổi chain math
  const formulaIdentity = 'F1.chain[elem*crit*defRed*shieldRed*finalMod*jitter*attack]/10000;F2.chain[healMod*antiHeal*jitter]/10000;F3.softcap;F4.amount*coef*role/1e8;F5.cap.PEN_CAP_TOTAL_BP;F6.K_DEF/(DEF+K_DEF)*1e4;F7.chain[pvpRed*(1+vuln)*roleMod]';
  return djb2Hash(`v${FORMULA_VERSION}|${ratesPart}|${rngOrder}|${formulaIdentity}`);
}

/** Computed once at module load — recompute by re-import. */
export const FORMULA_SIGNATURE_HASH: string = computeFormulaSignatureHash();
