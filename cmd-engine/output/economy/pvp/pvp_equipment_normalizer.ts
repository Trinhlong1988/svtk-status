/**
 * PVP EQUIPMENT NORMALIZER — Contract (Phase 11 Mục IX).
 *
 * Cap stats trước combat trong PvP modes.
 * Anti one-shot scaling + tactical PvP feel.
 *
 * Layer: Layer 2 LOGIC pure function transform.
 *
 * GOAL:
 *  - PvP remains tactical (KHÔNG stat explosion)
 *  - Companion vẫn meaningful nhưng cap nặng hơn (chống 2v1 disguise)
 *  - Proc normalization (block instakill_bonus / infinite_lifesteal trong PvP)
 *  - Damage cap per hit (chống one-shot)
 *
 * Anti-pattern:
 *  - NO mutate combat result post-hoc
 *  - NO mutate equipped item state
 *  - Pure transform: input ItemStatBlock → output normalized ItemStatBlock
 *
 * ⚠ NO IMPLEMENTATION — chỉ contract interface.
 */
import { z } from 'zod';
import type { ItemStatBlock } from '../../../../cmd-item/output/legacy/itemization_types.js';

// ───────── PvP Modes ─────────
export const PvPModeSchema = z.enum(['arena_1v1', 'arena_3v3', 'battleground', 'open_pvp']);
export type PvPMode = z.infer<typeof PvPModeSchema>;

// ───────── PvP Caps Config ─────────
// NOTE Batch 5.4 A1.b: `hp_floor_pct_bp` PRESERVED per CMD2.docx Batch 5.4 Mục IV.
// Config update (data/pvp_normalization.json): mode loose (open_pvp) có cap cao đủ
// để floor THỰC SỰ trigger. Mode strict (arena_1v1/3v3/battleground) cap đủ chặt → set
// hp_floor=0 cho explicit "cap-only guard" semantics.
export const PvPCapsSchema = z.object({
  max_crit_rate_bp: z.number().int().nonnegative(),
  max_crit_dmg_bp: z.number().int().nonnegative(),
  max_penetration_bp: z.number().int().nonnegative(),
  max_lifesteal_bp: z.number().int().nonnegative(),
  max_dodge_bp: z.number().int().nonnegative(),
  max_proc_chance_bp: z.number().int().nonnegative(),
  damage_cap_per_hit_pct_bp: z.number().int().nonnegative(),
  hp_floor_pct_bp: z.number().int().nonnegative(),
  stat_scaling_bp: z.number().int().positive(),
});
export type PvPCaps = z.infer<typeof PvPCapsSchema>;

// ───────── PvP Normalization Context ─────────
export const PvPNormalizationContextSchema = z.object({
  mode: PvPModeSchema,
  /** Player's equipped loadout (for proc validation). */
  player_id: z.string(),
  /** Server tick. */
  tick: z.number().int().nonnegative(),
});
export type PvPNormalizationContext = z.infer<typeof PvPNormalizationContextSchema>;

// ───────── Validation Result ─────────
export interface PvPValidationResult {
  is_valid: boolean;
  blocked_passives: string[];
  capped_stats: { stat_key: string; raw: number; capped: number }[];
}

// ───────── Damage Audit ─────────
export interface PvPDamageAudit {
  raw_damage: number;
  capped_damage: number;
  cap_hit: boolean;
  hp_floor_protected: boolean;
}

// ───────── PvPEquipmentNormalizer Contract ─────────
/**
 * CONTRACT — Implementation `pvp_equipment_normalizer_impl.ts` PHẢI satisfy.
 *
 * Pure transform: same input → same output (deterministic).
 * Caller invoke trước khi enter PvP encounter (cache result per match).
 */
export interface PvPEquipmentNormalizer {
  /**
   * Normalize stats per mode caps.
   * Crit/pen/lifesteal/dodge/proc capped tại max_*.
   * Other stats scaled by stat_scaling_bp.
   *
   * @returns NEW ItemStatBlock (immutable input preserved).
   */
  normalize(stats: ItemStatBlock, context: PvPNormalizationContext): ItemStatBlock;

  /**
   * Normalize companion stats (extra reduction by companion_pvp_ratio_bp).
   */
  normalizeCompanion(companion_stats: ItemStatBlock, context: PvPNormalizationContext): ItemStatBlock;

  /**
   * Normalize 1 proc value per mode.
   * Apply proc_value_scaling_bp + cap nếu vượt max_proc_chance_bp.
   */
  normalizeProc(proc_value: number, context: PvPNormalizationContext): number;

  /**
   * Audit 1 damage event — apply damage_cap_per_hit + hp_floor protection.
   */
  auditDamage(
    raw_damage: number,
    target_max_hp: number,
    context: PvPNormalizationContext,
  ): PvPDamageAudit;

  /**
   * Validate loadout (block listed passives, audit caps).
   */
  validateLoadout(
    equipped_passives: readonly string[],
    stats: ItemStatBlock,
    context: PvPNormalizationContext,
  ): PvPValidationResult;

  /**
   * Get caps config for mode.
   */
  getCaps(mode: PvPMode): PvPCaps;
}

// ───────── ★ NO IMPLEMENTATION ─────────
// Implementation file: pvp_equipment_normalizer_impl.ts (Batch 5.2).
