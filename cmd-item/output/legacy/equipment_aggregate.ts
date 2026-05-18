/**
 * EQUIPMENT STAT PROVIDER — Implementation v2 (Batch 3 + FINAL HARDENING).
 *
 * Orchestrate: load items → collect modifiers (explicit insert_order + source_type ENUM)
 *   → resolve passive (5-tuple) → resolve set bonus (conflict policy) → apply pipeline 7-step
 *   → persist registry/formula versioning → emit telemetry.
 *
 * Equipment NEVER bypass formula pipeline (CMD2.docx hard lock):
 *   equipment → modifier aggregation → stat aggregate → pipeline → softcap → final
 *
 * @see equipment_stat_provider.ts (contract)
 */
import {
  type ItemStatBlock,
  type StatModifier,
  type AggregatedStatBlock,
  type ModifierSourceTypeEnum,
} from './itemization_types.js';
import {
  type EquipmentStatProvider,
  type CharId,
  type EquippedItemMap,
} from './equipment_stat_provider.js';
import { getItem, type Item, getRegistryVersioning } from './item_registry.js';
import { createModifierPipeline } from './modifier_pipeline.js';
import { resolvePassives } from './passive_resolver.js';
import { resolveSetBonuses } from './set_bonus.js';
import { createObservabilityHook } from './itemization_observability_impl.js';
import type { ItemizationObservabilityHook } from './itemization_observability.js';
import { codepointCompare } from '../_shared/codepoint_compare.js';

// ───────── Modifier collector ─────────
/**
 * Collect modifier list từ items equipped.
 *
 * Each modifier has EXPLICIT:
 *  - source_type ENUM (KHÔNG derive from string)
 *  - modifier_insert_order INT monotonic (deterministic cross-runtime)
 */
function collectFromItems(items: readonly Item[]): StatModifier[] {
  const out: StatModifier[] = [];
  let insert = 0;
  // Sort items by id for deterministic insertion order
  const sorted = [...items].sort((a, b) => codepointCompare(a.id, b.id));

  for (const item of sorted) {
    const stat_record = item.stats as unknown as Record<string, unknown>;
    for (const [stat_key, value] of Object.entries(stat_record)) {
      if (typeof value !== 'number' || !Number.isInteger(value)) continue;
      out.push({
        stat_key,
        kind: 'flat',
        amount_bp_or_raw: value,
        source_item_id: item.id,
        source_type: 'base_item' satisfies ModifierSourceTypeEnum,
        order_priority: 100,
        modifier_insert_order: insert++,
      });
    }
    for (const af of item.affixes ?? []) {
      out.push({
        stat_key: af.type,
        kind: 'flat',
        amount_bp_or_raw: af.value_bp_or_raw,
        source_item_id: af.id,
        source_type: 'affix' satisfies ModifierSourceTypeEnum,
        order_priority: 200,
        modifier_insert_order: insert++,
      });
    }
  }
  return out;
}

// ───────── Slot validate ─────────
const VALID_SLOTS = new Set([
  'mu', 'ao', 'quan', 'gang_tay', 'giay', 'vu_khi', 'nhan', 'day_chuyen', 'ngoc',
]);

function validateEquipped(equipped: EquippedItemMap): void {
  const seen_slots = new Set<string>();
  for (const slot of Object.keys(equipped)) {
    if (!VALID_SLOTS.has(slot)) {
      throw new Error(`[EquipmentAggregate] invalid slot: ${slot}`);
    }
    if (seen_slots.has(slot)) {
      throw new Error(`[EquipmentAggregate] duplicate slot: ${slot}`);
    }
    seen_slots.add(slot);
  }
}

// ───────── Provider factory ─────────
export function createEquipmentStatProvider(
  observability?: ItemizationObservabilityHook,
): EquipmentStatProvider {
  const pipeline = createModifierPipeline();
  const obs = observability ?? createObservabilityHook();

  return {
    collectModifiers(equipped: EquippedItemMap): StatModifier[] {
      validateEquipped(equipped);
      const items: Item[] = [];
      const sorted_slots = Object.keys(equipped).sort();
      for (const slot of sorted_slots) {
        const item_id = equipped[slot];
        if (!item_id) continue;
        items.push(getItem(item_id));
      }
      return collectFromItems(items);
    },

    getAggregatedStats(
      char_id: CharId,
      equipped: EquippedItemMap,
      char_base_stats: ItemStatBlock,
    ): AggregatedStatBlock {
      const marker = obs.startAggregationTimer();

      // 1. Load items
      validateEquipped(equipped);
      const items: Item[] = [];
      const sorted_slots = Object.keys(equipped).sort();
      for (const slot of sorted_slots) {
        const item_id = equipped[slot];
        if (!item_id) continue;
        items.push(getItem(item_id));
      }

      // 2. Collect base modifier (with explicit source_type + insert_order)
      const base_mods = collectFromItems(items);
      let next_insert = base_mods.length;

      // 3. Resolve passive (5-tuple deterministic)
      const passive_winners = resolvePassives(items);

      // 4. Resolve set bonus (conflict policy applied)
      const set_result = resolveSetBonuses(items);

      // 5. Convert passives + set bonus → modifiers (kind=passive)
      const passive_mods: StatModifier[] = [];
      const passive_keys = [...passive_winners.keys()].sort();
      for (const type of passive_keys) {
        const p = passive_winners.get(type)!;
        passive_mods.push({
          stat_key: p.type,
          kind: 'passive',
          amount_bp_or_raw: p.value_bp_or_raw,
          source_item_id: `passive_${p.type}`,
          source_type: 'passive' satisfies ModifierSourceTypeEnum,
          order_priority: 300,
          modifier_insert_order: next_insert++,
        });
      }
      for (const sb of set_result.bonus_passives) {
        passive_mods.push({
          stat_key: sb.type,
          kind: 'passive',
          amount_bp_or_raw: sb.value_bp_or_raw,
          source_item_id: `set_${sb.type}`,
          source_type: 'set_bonus' satisfies ModifierSourceTypeEnum,
          order_priority: 400,
          modifier_insert_order: next_insert++,
        });
      }

      const all_mods = [...base_mods, ...passive_mods];

      // 6. Apply pipeline 7-step
      const final_stats = pipeline.applyPipeline(
        char_base_stats,
        all_mods,
        { base_after_step1: char_base_stats, tick: 0, context_tags: [] },
      );

      // 7. Telemetry
      obs.stopAggregationTimer(marker, char_id, all_mods.length);

      // 8. Persist versioning (CMD2.docx FINAL FIX #11 + #12)
      const ver = getRegistryVersioning();

      return {
        stats: final_stats,
        active_sets: set_result.active_set_ids,
        applied_modifiers: all_mods,
        equipped_item_ids: items.map(i => i.id),
        versioning: ver,
      };
    },

    _resetCache() {
      // No cache in provider itself — registries cache reset via their _reset helpers
    },
  };
}
