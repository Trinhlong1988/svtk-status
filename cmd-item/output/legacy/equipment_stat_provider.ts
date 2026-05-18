/**
 * EQUIPMENT STAT PROVIDER — Contract #1 (Phase 7 interface-first batch).
 *
 * Single source of truth cho Combat Core đọc stat aggregated từ items equipped.
 *
 * Layer: Layer 2 LOGIC (pure function, deterministic, no I/O, no state).
 *
 * Combat Core ĐỌC `getAggregatedStats(charId)` để dùng trong:
 *   - resolveSkillCast() pipeline (12-step, KHÔNG sửa pipeline — R PHASE4 ownership lock)
 *   - applySoftCap() crit cap 50% từ 9 slot (R spec/08 Mục III + R24)
 *   - threat_engine threat_coef per char
 *
 * Combat Core KHÔNG được:
 *   - Mutate item state qua provider này (read-only)
 *   - Bypass provider để đọc raw item directly
 *   - Cache stat ngoài provider (provider tự cache, replay-safe)
 *
 * Phase 7 Mục IX/X (Stat Aggregation + Affix System).
 *
 * ⚠ NO IMPLEMENTATION trong file này — chỉ contract interface.
 *    Implementation sau khi Mr.Long ack contract: equipment_aggregate.ts.
 */
import { z } from 'zod';
import {
  type AggregatedStatBlock,
  AggregatedStatBlockSchema,
  type ItemStatBlock,
  type StatModifier,
} from './itemization_types.js';

// ───────── Char ID schema (consume từ runtime, CMD2.docx FINAL FIX #3 expanded) ─────────
/**
 * Char ID — expanded canonical schema. KHÔNG bypass schema validator.
 *
 * Convention:
 *  - Player: `char_<player_id>` (vd "char_p_01")
 *  - Companion: `companion_<npc_base>_<owner_player_id>` (vd "companion_yet_kieu_p_01")
 *  - NPC (non-player): `npc_<npc_base>` (vd "npc_tran_hung_dao")
 *  - Summon: `summon_<spawn_id>` (vd "summon_lac_long_quan_01")
 */
export const CharIdSchema = z.string().regex(/^(char_|companion_|npc_|summon_)[a-z0-9_]+$/);
export type CharId = z.infer<typeof CharIdSchema>;

// ───────── Equipped Item Map ─────────
/**
 * Map slot → item_id cho 1 char tại snapshot time.
 *
 * Slot vắng = char chưa equip. Item_id null không hợp lệ — slot phải omit hoặc có id.
 */
export const EquippedItemMapSchema = z.record(
  z.string(), // slot key — validate tại runtime qua EquipmentSlotSchema
  z.string().regex(/^item_/),
);
export type EquippedItemMap = z.infer<typeof EquippedItemMapSchema>;

// ───────── EquipmentStatProvider Contract ─────────
/**
 * CONTRACT — interface mà implementation `equipment_aggregate.ts` PHẢI satisfy.
 *
 * Combat Core consume contract này, KHÔNG biết internal aggregation logic.
 *
 * Determinism guarantee:
 *  - Cùng `(equipped, char_base_stats)` → cùng `AggregatedStatBlock` (replay-safe)
 *  - Modifier ordering deterministic theo `order_priority` field (R Phase 7 Mục VIII)
 *  - Set bonus resolution deterministic theo set_id alphabetical
 *  - Passive conflict resolved theo "stronger wins" rule (R spec/08 Mục VI)
 */
export interface EquipmentStatProvider {
  /**
   * Aggregate stat từ items equipped cho 1 char.
   *
   * Steps (pure function, no I/O):
   *   1. Load each item từ registry by id
   *   2. Collect base stats per item
   *   3. Collect modifiers per item (flat / pct / conditional / passive)
   *   4. Apply Bạo Kích cap 50% (R spec/08 Mục III) qua soft_cap helper
   *   5. Resolve passive conflict (stronger wins)
   *   6. Resolve set bonus (count pieces per set_id)
   *   7. Return AggregatedStatBlock pure data
   *
   * @param char_id           CharId — for debug/snapshot id
   * @param equipped          EquippedItemMap — slot → item_id
   * @param char_base_stats   Stat base char (level + class + Tinh Anh) trước khi apply item
   * @returns                 AggregatedStatBlock — Combat Core consume
   *
   * @throws Error nếu item_id không tồn tại trong registry
   * @throws Error nếu duplicate slot (security R Phase 7 Mục XVII)
   */
  getAggregatedStats(
    char_id: CharId,
    equipped: EquippedItemMap,
    char_base_stats: ItemStatBlock,
  ): AggregatedStatBlock;

  /**
   * Helper convenience: collect raw modifiers TRƯỚC khi aggregate.
   * Cho test/debug/audit.
   *
   * @returns ordered StatModifier[] — sorted by order_priority asc
   */
  collectModifiers(equipped: EquippedItemMap): StatModifier[];

  /**
   * Reset internal cache (test-only).
   * Production KHÔNG dùng — registry hot-reload qua reloadRegistry() riêng.
   */
  _resetCache(): void;
}

// ───────── Validation helper (re-export schema) ─────────
export { AggregatedStatBlockSchema };

// ───────── ★ NO IMPLEMENTATION ─────────
// Implementation file: equipment_aggregate.ts (sẽ ship sau Mr.Long ack contract).
// File này CHỈ contract interface + schema validate.
