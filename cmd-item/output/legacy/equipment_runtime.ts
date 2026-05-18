/**
 * EQUIPMENT RUNTIME — CMD2.docx Mục VII.
 *
 * Wrapper trên EquipmentStatProvider + StatBudgetRuntime.
 * Public API: equip / unequip / aggregate / companion / validate.
 *
 * STRICT: equipment NEVER bypass formula pipeline (Mục VII hard lock).
 * Slot validation + rarity validation + companion bridge.
 */
import {
  type ItemStatBlock,
  type AggregatedStatBlock,
  type EquipmentSlot,
} from './itemization_types.js';
import {
  type EquipmentStatProvider,
  type EquippedItemMap,
  type CharId,
} from './equipment_stat_provider.js';
import {
  type CompanionEquipmentHook,
  type CompanionId,
  type OwnerCompanionLink,
} from './companion_equipment_hook.js';
import {
  type StatBudgetRuntime,
  type BudgetValidationResult,
} from './stat_budget_runtime.js';
import { createEquipmentStatProvider } from './equipment_aggregate.js';
import { createCompanionEquipmentHook } from './companion_equipment.js';
import { createStatBudgetRuntime } from './stat_budget_runtime_impl.js';
import { getItem } from './item_registry.js';

const VALID_SLOTS: ReadonlySet<EquipmentSlot> = new Set<EquipmentSlot>([
  'mu', 'ao', 'quan', 'gang_tay', 'giay', 'vu_khi', 'nhan', 'day_chuyen', 'ngoc',
]);

export interface EquipmentRuntime {
  /** Equip 1 item vào slot. Throw nếu slot/rarity invalid. */
  equip(equipped: EquippedItemMap, slot: EquipmentSlot, item_id: string): EquippedItemMap;

  /** Unequip 1 slot. */
  unequip(equipped: EquippedItemMap, slot: EquipmentSlot): EquippedItemMap;

  /** Aggregate full stat — equipment NEVER bypass pipeline. */
  aggregate(
    char_id: CharId,
    equipped: EquippedItemMap,
    base_stats: ItemStatBlock,
  ): AggregatedStatBlock;

  /** Companion aggregation — SAME pipeline (Phase 7 Mục XIII). */
  aggregateCompanion(
    companion_id: CompanionId,
    companion_equipped: EquippedItemMap,
    companion_base_stats: ItemStatBlock,
    owner_link: OwnerCompanionLink | null,
  ): AggregatedStatBlock;

  /** Validate slot match + rarity in {common,rare,epic,legendary,mythic}. */
  validateItemForSlot(item_id: string, slot: EquipmentSlot): BudgetValidationResult;
}

export function createEquipmentRuntime(
  provider?: EquipmentStatProvider,
  companionHook?: CompanionEquipmentHook,
  budget?: StatBudgetRuntime,
): EquipmentRuntime {
  const eq = provider ?? createEquipmentStatProvider();
  const comp = companionHook ?? createCompanionEquipmentHook(eq);
  const bg = budget ?? createStatBudgetRuntime();

  return {
    equip(equipped, slot, item_id) {
      if (!VALID_SLOTS.has(slot)) {
        throw new Error(`[EquipmentRuntime] invalid slot: ${slot}`);
      }
      const item = getItem(item_id);
      if (item.slot !== slot) {
        throw new Error(`[EquipmentRuntime] item ${item_id} slot=${item.slot}, requested ${slot}`);
      }
      return { ...equipped, [slot]: item_id };
    },

    unequip(equipped, slot) {
      const { [slot]: _removed, ...rest } = equipped;
      void _removed;
      return rest;
    },

    aggregate(char_id, equipped, base_stats) {
      return eq.getAggregatedStats(char_id, equipped, base_stats);
    },

    aggregateCompanion(companion_id, companion_equipped, companion_base_stats, owner_link) {
      return comp.getCompanionAggregatedStats(
        companion_id, companion_equipped, companion_base_stats, owner_link,
      );
    },

    validateItemForSlot(item_id, slot) {
      const item = getItem(item_id);
      if (item.slot !== slot) {
        return {
          is_valid: false,
          violations: [{
            kind: 'over_slot_cap',
            detail: `slot mismatch: item.slot=${item.slot}, requested=${slot}`,
          }],
        };
      }
      return bg.validateItem(item.id, item.rarity, item.slot, item.stats, item.affixes, false);
    },
  };
}
