/**
 * COMPANION EQUIPMENT — Implementation v2 (CMD2.docx FINAL FIX #3 + #8).
 *
 * Wrapper quanh EquipmentStatProvider (SAME pipeline per spec/08 + Phase 7 Mục XIII).
 * Modifier namespace isolated — owner ↔ companion bonus chỉ qua hook.
 *
 * Bond multiplier formula loaded từ data/itemization_constants.json (FIX #8).
 * CharIdSchema expanded support companion_/npc_/summon_ (FIX #3) — KHÔNG bypass schema.
 *
 * @see companion_equipment_hook.ts (contract)
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  type ItemStatBlock,
  type AggregatedStatBlock,
  type StatModifier,
  type ModifierSourceTypeEnum,
} from './itemization_types.js';
import {
  type EquippedItemMap,
  type EquipmentStatProvider,
} from './equipment_stat_provider.js';
import {
  type CompanionEquipmentHook,
  type CompanionId,
  type OwnerCompanionLink,
} from './companion_equipment_hook.js';
import { createEquipmentStatProvider } from './equipment_aggregate.js';
import { getItem } from './item_registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, '../../data');

// ───────── Bond mult formula loaded from JSON (CMD2.docx FINAL FIX #8) ─────────
const BondConfigSchema = z.object({
  bond_multiplier: z.object({
    base_bp: z.number().int().positive(),
    per_level_bp: z.number().int().nonnegative(),
    max_level: z.number().int().positive(),
    max_bp: z.number().int().positive(),
  }),
}).passthrough();

interface BondConfig {
  base_bp: number;
  per_level_bp: number;
  max_level: number;
  max_bp: number;
}

let cachedBondConfig: BondConfig | null = null;

function loadBondConfig(): BondConfig {
  if (cachedBondConfig) return cachedBondConfig;
  const raw = JSON.parse(readFileSync(join(DATA_ROOT, 'itemization_constants.json'), 'utf8'));
  const parsed = BondConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`[CompanionEquipment] bond_multiplier config FAIL:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
  cachedBondConfig = parsed.data.bond_multiplier;
  return cachedBondConfig;
}

/**
 * Companion budget ratio: companion item budget = 60% owner.
 * Source: data/stat_budget.json companion_budget_ratio_bp = 6000.
 * Inline const cho lean — sẽ extract sang JSON nếu balance review yêu cầu.
 */
const COMPANION_STAT_RATIO_BP = 6000;

function scaleStatBlock(stats: ItemStatBlock, ratio_bp: number): ItemStatBlock {
  const out = { ...stats } as Record<string, unknown>;
  const numeric_keys = ['hp', 'sat_luc', 'phap_luc', 'defense', 'agility',
                        'hp_regen_per_turn', 'mana_regen_per_turn',
                        'crit_rate_bp', 'crit_dmg_bp', 'penetration_bp',
                        'lifesteal_bp', 'dodge_bp'];
  for (const k of numeric_keys) {
    const v = out[k];
    if (typeof v === 'number') {
      out[k] = Math.floor((v * ratio_bp) / 10000);
    }
  }
  return out as ItemStatBlock;
}

// ───────── Hook factory ─────────
export function createCompanionEquipmentHook(
  ownerProvider?: EquipmentStatProvider,
): CompanionEquipmentHook {
  const provider = ownerProvider ?? createEquipmentStatProvider();
  const bondCfg = loadBondConfig();

  return {
    bondMultiplierBP(bond_level) {
      const lv = Math.max(0, Math.min(bondCfg.max_level, bond_level));
      const v = bondCfg.base_bp + lv * bondCfg.per_level_bp;
      return Math.min(v, bondCfg.max_bp);
    },

    getCompanionAggregatedStats(
      companion_id: CompanionId,
      companion_equipped: EquippedItemMap,
      companion_base_stats: ItemStatBlock,
      owner_link: OwnerCompanionLink | null,
    ): AggregatedStatBlock {
      if (owner_link && owner_link.companion_id !== companion_id) {
        throw new Error(
          `[CompanionEquipment] companion_id mismatch: ${companion_id} vs link ${owner_link.companion_id}`,
        );
      }

      // Scale base stats to companion ratio (60% per stat_budget.json)
      const scaled_base = scaleStatBlock(companion_base_stats, COMPANION_STAT_RATIO_BP);

      // Companion ID is valid CharId (CharIdSchema expanded — companion_ prefix accepted).
      // KHÔNG bypass schema (FIX #3).
      return provider.getAggregatedStats(companion_id, companion_equipped, scaled_base);
    },

    resolveOwnerLinkedBonus(
      owner_equipped: EquippedItemMap,
      owner_link: OwnerCompanionLink | null,
    ): StatModifier[] {
      if (!owner_link) return [];
      const out: StatModifier[] = [];
      const sorted_slots = Object.keys(owner_equipped).sort();
      const bond_mult = this.bondMultiplierBP(owner_link.bond_level);
      let insert = 0;

      for (const slot of sorted_slots) {
        const item_id = owner_equipped[slot];
        if (!item_id) continue;
        const item = getItem(item_id);
        if (!item.passives) continue;
        for (const p of item.passives) {
          if (!p.type.startsWith('companion_link_')) continue;
          const scaled_value = Math.floor((p.value_bp_or_raw * bond_mult) / 10000);
          out.push({
            stat_key: p.type,
            kind: 'companion_linked',
            amount_bp_or_raw: scaled_value,
            source_item_id: `companion_aura_${item.id}`,
            source_type: 'companion_aura' satisfies ModifierSourceTypeEnum,
            order_priority: 500,
            modifier_insert_order: insert++,
          });
        }
      }
      return out;
    },

    resolveCompanionLinkedBonus(
      companion_equipped: EquippedItemMap,
      owner_link: OwnerCompanionLink | null,
    ): StatModifier[] {
      if (!owner_link) return [];
      const out: StatModifier[] = [];
      const sorted_slots = Object.keys(companion_equipped).sort();
      const bond_mult = this.bondMultiplierBP(owner_link.bond_level);
      let insert = 0;

      for (const slot of sorted_slots) {
        const item_id = companion_equipped[slot];
        if (!item_id) continue;
        const item = getItem(item_id);
        if (!item.passives) continue;
        for (const p of item.passives) {
          if (!p.type.startsWith('owner_link_')) continue;
          const scaled_value = Math.floor((p.value_bp_or_raw * bond_mult) / 10000);
          out.push({
            stat_key: p.type,
            kind: 'companion_linked',
            amount_bp_or_raw: scaled_value,
            source_item_id: `companion_aura_owner_link_${item.id}`,
            source_type: 'companion_aura' satisfies ModifierSourceTypeEnum,
            order_priority: 500,
            modifier_insert_order: insert++,
          });
        }
      }
      return out;
    },
  };
}

/** Test-only cache reset. */
export function _resetBondConfigCache(): void {
  cachedBondConfig = null;
}
