/**
 * COMPANION EQUIPMENT HOOK — Contract #3 (Phase 7 interface-first batch).
 *
 * Bridge giữa Itemization Module (CMD2 ownership) và Companion / NPC Module 5 (CMD1 ownership).
 *
 * Layer: Layer 2 LOGIC — pure read-only contract.
 *
 * Phase 7 Mục XIII (Companion Equipment Prep):
 *   "Companion MUST use SAME item pipeline. NO special-case pet equipment engine."
 *
 * Strict ownership:
 *  - Itemization Module (CMD2/em): cung cấp item registry + stat aggregation
 *  - NPC/Companion Runtime (CMD1): own companion lifecycle + bond + AI
 *  - Hook = thin contract — Itemization KHÔNG mutate companion state
 *
 * R Phase 7 Mục XIII + R PHASE4 ownership lock (KHÔNG modify companion_runtime.ts).
 *
 * ⚠ NO IMPLEMENTATION — chỉ contract interface.
 */
import { z } from 'zod';
import {
  type AggregatedStatBlock,
  type ItemStatBlock,
  type StatModifier,
} from './itemization_types.js';
import {
  type EquippedItemMap,
  CharIdSchema,
} from './equipment_stat_provider.js';

// ───────── Companion ID schema ─────────
/**
 * Companion ID format: `companion_<npc_base>_<owner_player_id>`.
 * Vd: "companion_yet_kieu_p_01" — Yết Kiêu thuộc player p_01.
 */
export const CompanionIdSchema = z.string().regex(/^companion_[a-z0-9_]+$/);
export type CompanionId = z.infer<typeof CompanionIdSchema>;

// ───────── Owner-Companion Link ─────────
/**
 * Link giữa owner (player) và companion + bonus áp dụng 2 chiều.
 *
 * Phase 7 Mục VIII modifier kind `companion_linked`:
 *   - Companion equip item có affix "owner_link" → owner nhận bonus
 *   - Owner equip item có affix "companion_link" → companion nhận bonus
 *
 * Thường ngắn (1-2 item set bonus chuyên biệt).
 */
export const OwnerCompanionLinkSchema = z.object({
  owner_char_id: CharIdSchema,
  companion_id: CompanionIdSchema,
  /** Bond level 1-10 — affect link bonus magnitude (R memory bond_npc_capture_recruit). */
  bond_level: z.number().int().min(0).max(10),
});
export type OwnerCompanionLink = z.infer<typeof OwnerCompanionLinkSchema>;

// ───────── CompanionEquipmentHook Contract ─────────
/**
 * CONTRACT — Implementation `companion_equipment.ts` PHẢI satisfy.
 *
 * Phase 7 Mục XIII: "Companion MUST use SAME item pipeline."
 * → Hook chỉ là **wrapper** quanh EquipmentStatProvider, KHÔNG engine riêng.
 *
 * Determinism guarantee:
 *  - Cùng (link, equipped_owner, equipped_companion) → cùng output
 *  - Owner-link bonus deterministic (KHÔNG random)
 *  - Bond_level scaling theo lookup table (data-driven, KHÔNG hardcode)
 */
export interface CompanionEquipmentHook {
  /**
   * Aggregate stat cho companion — dùng SAME pipeline owner.
   *
   * @param companion_id           CompanionId
   * @param companion_equipped     EquippedItemMap (item companion đeo)
   * @param companion_base_stats   Stat base companion (NPC tier + bond bonus stat)
   * @param owner_link             OwnerCompanionLink — for companion_linked modifier resolve
   * @returns                      AggregatedStatBlock cho companion
   *
   * @throws Error nếu companion_id không match owner_link.companion_id
   */
  getCompanionAggregatedStats(
    companion_id: CompanionId,
    companion_equipped: EquippedItemMap,
    companion_base_stats: ItemStatBlock,
    owner_link: OwnerCompanionLink | null,
  ): AggregatedStatBlock;

  /**
   * Resolve owner-side bonus từ companion-linked modifier.
   *
   * Owner equipped item có affix `companion_link` → check companion exist + return modifier.
   * Companion KHÔNG → return [] (no bonus).
   *
   * @param owner_equipped     EquippedItemMap owner
   * @param owner_link         OwnerCompanionLink (null nếu không có companion)
   * @returns                  StatModifier[] đã filter, sorted by order_priority
   */
  resolveOwnerLinkedBonus(
    owner_equipped: EquippedItemMap,
    owner_link: OwnerCompanionLink | null,
  ): StatModifier[];

  /**
   * Resolve companion-side bonus từ owner-linked modifier (chiều ngược lại).
   */
  resolveCompanionLinkedBonus(
    companion_equipped: EquippedItemMap,
    owner_link: OwnerCompanionLink | null,
  ): StatModifier[];

  /**
   * Bond level multiplier cho linked bonus magnitude.
   *
   * Source of truth: data/companion_bond_table.json (sẽ ship sau).
   * Linear interpolation theo bond_level 0-10.
   *
   * @param bond_level     0-10
   * @returns              multiplier BP (vd 12000 = ×1.2 tại bond 5)
   */
  bondMultiplierBP(bond_level: number): number;
}

// ───────── ★ NO IMPLEMENTATION ─────────
// Implementation file: companion_equipment.ts (sẽ ship sau Mr.Long ack contract).
// File này CHỈ contract interface + schema validate.
//
// Cross-module dependency:
//   - NPC/Companion runtime (CMD1) inject CompanionId + base_stats vào hook này
//   - Hook KHÔNG đọc directly companion_runtime.ts (KHÔNG được R PHASE4 ownership)
//   - Bond data resolved by NPC module trước khi gọi hook
