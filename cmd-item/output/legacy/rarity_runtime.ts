/**
 * RARITY RUNTIME — CMD2.docx Mục XI.
 *
 * Wrapper trên StatBudgetRuntime + ObservabilityHook.
 * SUPPORT: rarity validation / scaling / distribution / telemetry / anti inflation prep.
 * BLOCK: stat creep explosion (budget cap enforced).
 */
import {
  type Rarity,
  type ItemStatBlock,
  type ItemAffix,
  type EquipmentSlot,
} from './itemization_types.js';
import {
  type StatBudgetRuntime,
  type RarityBudget,
  type BudgetValidationResult,
} from './stat_budget_runtime.js';
import {
  type ItemizationObservabilityHook,
  DEFAULT_SEVERITY_BY_TYPE,
} from './itemization_observability.js';
import { createStatBudgetRuntime } from './stat_budget_runtime_impl.js';
import { createObservabilityHook } from './itemization_observability_impl.js';

// 5 rarity multiplier (CMD2 Mục XI rarity scaling — locked).
const RARITY_MULT_BP: Record<Rarity, number> = {
  common: 10000,    // ×1.0
  rare: 12000,      // ×1.2
  epic: 15000,      // ×1.5
  legendary: 20000, // ×2.0
  mythic: 25000,    // ×2.5
};

const RARITY_LIST: readonly Rarity[] = ['common', 'rare', 'epic', 'legendary', 'mythic'];

export interface RarityRuntime {
  /** Validate rarity name + budget. */
  validate(
    item_id: string,
    rarity: Rarity,
    slot: EquipmentSlot,
    stats: ItemStatBlock,
    affixes: readonly ItemAffix[],
    is_companion: boolean,
  ): BudgetValidationResult;

  /** Get rarity scaling multiplier (BP). */
  getScalingBP(rarity: Rarity): number;

  /** Get budget config for rarity. */
  getBudget(rarity: Rarity): RarityBudget;

  /** Get rarity distribution counter (for telemetry / live balance prep). */
  getDistribution(items: readonly { rarity: Rarity }[]): Record<Rarity, number>;

  /** All rarity names ordered weakest → strongest. */
  readonly tiers: readonly Rarity[];
}

export function createRarityRuntime(
  budget?: StatBudgetRuntime,
  observability?: ItemizationObservabilityHook,
): RarityRuntime {
  const bg = budget ?? createStatBudgetRuntime();
  const obs = observability ?? createObservabilityHook();

  return {
    validate(item_id, rarity, slot, stats, affixes, is_companion) {
      const result = bg.validateItem(item_id, rarity, slot, stats, affixes, is_companion);
      if (!result.is_valid) {
        // Telemetry — anti inflation prep (CMD2 Mục XVI).
        for (const v of result.violations) {
          obs.emit({
            type: 'budget_violation',
            severity: DEFAULT_SEVERITY_BY_TYPE.budget_violation,
            tick: 0,
            char_id: undefined,
            stat_key: v.stat_key,
            detail: `${item_id} (${rarity}): ${v.kind} — ${v.detail}`,
          });
        }
      }
      return result;
    },

    getScalingBP(rarity) {
      const v = RARITY_MULT_BP[rarity];
      if (v === undefined) throw new Error(`[RarityRuntime] unknown rarity: ${rarity}`);
      return v;
    },

    getBudget(rarity) {
      return bg.getRarityBudget(rarity);
    },

    getDistribution(items) {
      const dist: Record<Rarity, number> = {
        common: 0, rare: 0, epic: 0, legendary: 0, mythic: 0,
      };
      for (const it of items) {
        if (it.rarity in dist) dist[it.rarity]++;
      }
      return dist;
    },

    tiers: RARITY_LIST,
  };
}
