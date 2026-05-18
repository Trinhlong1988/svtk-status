/**
 * STAT BUDGET RUNTIME — Contract #5 (CMD2.docx FIX #3).
 *
 * Prevent MMORPG stat inflation death.
 *
 * Validation budget per:
 *  - rarity (common ≤ X stat total, mythic ≤ Y stat total)
 *  - tier (Mob/Elite/.../Boss/Myth)
 *  - affix (max affix count + max stat per affix)
 *  - slot (vd vũ khí ≤ 10% crit_rate, ngọc ≤ 7% crit_rate per spec/08 Mục III)
 *  - companion (companion item budget thấp hơn owner)
 *
 * Block:
 *  - impossible stat combinations (vd ATK + INT cùng max)
 *  - overflow stat generation (raw int > MAX_INT_STAT)
 *  - crit/haste/penetration/lifesteal inflation
 *
 * Layer: Layer 2 LOGIC pure function.
 *
 * R31 INT + R30 BP + Bạo Kích cap 50% (spec/08 Mục III).
 *
 * ⚠ NO IMPLEMENTATION — chỉ contract.
 */
import { z } from 'zod';
import {
  type ItemStatBlock,
  type ItemAffix,
  type EquipmentSlot,
  type Rarity,
  EquipmentSlotSchema,
  RaritySchema,
} from './itemization_types.js';

// ───────── Budget Config (per rarity) ─────────
/**
 * Stat budget per rarity — source: data/stat_budget.json (TBD).
 *
 * Total stat power ≈ sum(weighted stat values), KHÔNG sum raw INT (vì BP scale khác stat scale).
 * Weight per stat trong data/stat_weight.json.
 */
export const RarityBudgetSchema = z.object({
  rarity: RaritySchema,
  /** Max total weighted stat power (INT). */
  max_stat_power: z.number().int().positive(),
  /** Max affix count cho rarity này. */
  max_affix_count: z.number().int().nonnegative(),
  /** Max stat power per affix. */
  max_affix_power: z.number().int().positive(),
});
export type RarityBudget = z.infer<typeof RarityBudgetSchema>;

// ───────── Slot Cap (per stat — spec/08 Mục III Bạo Kích phân bổ) ─────────
/**
 * Cap stat per slot — vd vũ khí 10% crit_rate (1000 BP), nhẫn 5%, ngọc 7%.
 *
 * Source: data/slot_cap.json (TBD, theo spec/08 Mục III table).
 */
export const SlotCapSchema = z.object({
  slot: EquipmentSlotSchema,
  /** Map stat key (vd "crit_rate_bp") → max value cho slot này. */
  caps_per_stat: z.record(z.string(), z.number().int().nonnegative()),
});
export type SlotCap = z.infer<typeof SlotCapSchema>;

// ───────── Validation Result ─────────
export const BudgetValidationResultSchema = z.object({
  /** Pass hay fail. */
  is_valid: z.boolean(),
  /** Vi phạm cụ thể (rỗng nếu pass). */
  violations: z.array(z.object({
    kind: z.enum([
      'over_rarity_budget',
      'over_slot_cap',
      'over_affix_count',
      'over_affix_power',
      'overflow_int',
      'impossible_combo',
      'companion_over_owner',
    ]),
    detail: z.string(),
    stat_key: z.string().optional(),
    measured: z.number().int().optional(),
    limit: z.number().int().optional(),
  })),
});
export type BudgetValidationResult = z.infer<typeof BudgetValidationResultSchema>;

// ───────── StatBudgetRuntime Contract ─────────
/**
 * CONTRACT — Implementation `stat_budget_runtime_impl.ts` PHẢI satisfy.
 *
 * Determinism: cùng (item, rarity, slot, affixes) → cùng validation result.
 *
 * Pure function — KHÔNG mutate item state.
 */
export interface StatBudgetRuntime {
  /**
   * Validate 1 item theo rarity + slot + affix budget.
   *
   * Steps:
   *  1. Compute total weighted stat power
   *  2. Check vs RarityBudget.max_stat_power
   *  3. Check per-stat cap vs SlotCap.caps_per_stat
   *  4. Check affix count + per-affix power
   *  5. Check overflow INT (R31 — values must fit safe int)
   *  6. Check impossible combo (vd ATK + INT cùng cap)
   *
   * @param item_id      For error reporting
   * @param rarity       Item rarity
   * @param slot         Item slot
   * @param stats        Base stat block
   * @param affixes      Affix list (rolled)
   * @param is_companion Boolean — companion gear has lower budget than owner
   * @returns            BudgetValidationResult
   */
  validateItem(
    item_id: string,
    rarity: Rarity,
    slot: EquipmentSlot,
    stats: ItemStatBlock,
    affixes: readonly ItemAffix[],
    is_companion: boolean,
  ): BudgetValidationResult;

  /**
   * Compute total weighted stat power cho 1 item.
   *
   * Weighted sum theo data/stat_weight.json.
   * Pure function, deterministic.
   */
  computeStatPower(stats: ItemStatBlock, affixes: readonly ItemAffix[]): number;

  /**
   * Get rarity budget config.
   */
  getRarityBudget(rarity: Rarity): RarityBudget;

  /**
   * Get slot cap config.
   */
  getSlotCap(slot: EquipmentSlot): SlotCap;

  /**
   * Bạo Kích cap 50% enforcement (spec/08 Mục III).
   *
   * Check tổng crit_rate_bp từ 9 slot ≤ 5000 BP (50%).
   * Apply trong aggregation pipeline (KHÔNG validate item-level — item level cap đủ qua slot cap).
   */
  validateAggregatedCritCap(total_crit_rate_bp: number): boolean;
}

// ───────── Schema re-exports ─────────
export {
  RarityBudgetSchema as _RarityBudgetSchema,
  SlotCapSchema as _SlotCapSchema,
  BudgetValidationResultSchema as _BudgetValidationResultSchema,
};
