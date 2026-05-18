/**
 * STAT BUDGET RUNTIME — Implementation (CMD2.docx FIX #3, Batch 3 APPROVED).
 *
 * Pure function validator. Block stat inflation + impossible combo + Bạo Kích cap.
 *
 * @see stat_budget_runtime.ts (contract)
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  type ItemStatBlock,
  type ItemAffix,
  type EquipmentSlot,
  type Rarity,
} from './itemization_types.js';
import {
  type StatBudgetRuntime,
  type RarityBudget,
  type BudgetValidationResult,
} from './stat_budget_runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, '../../data');

// ───────── Config schemas ─────────
const StatBudgetConfigSchema = z.object({
  rarity_budget: z.array(z.object({
    rarity: z.enum(['common', 'rare', 'epic', 'legendary', 'mythic']),
    max_stat_power: z.number().int().positive(),
    max_affix_count: z.number().int().nonnegative(),
    max_affix_power: z.number().int().positive(),
  })),
  companion_budget_ratio_bp: z.number().int().positive(),
}).passthrough();

const SlotCapConfigSchema = z.object({
  caps_per_slot: z.record(z.string(), z.record(z.string(), z.number().int().nonnegative())),
}).passthrough();

const StatWeightConfigSchema = z.object({
  stat_weight: z.record(z.string(), z.unknown()).transform(obj => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[k] = v;
    }
    return out;
  }),
  max_safe_int_stat: z.number().int().positive(),
  bao_kich_global_cap_bp: z.number().int().positive(),
}).passthrough();

interface CachedConfig {
  rarity_budget: Map<Rarity, RarityBudget>;
  companion_budget_ratio_bp: number;
  slot_caps: Map<string, Record<string, number>>;
  stat_weight: Record<string, number>;
  max_safe_int_stat: number;
  bao_kich_global_cap_bp: number;
}

let cached: CachedConfig | null = null;

function loadConfig(): CachedConfig {
  if (cached) return cached;
  const budgetRaw = JSON.parse(readFileSync(join(DATA_ROOT, 'stat_budget.json'), 'utf8'));
  const budgetParsed = StatBudgetConfigSchema.safeParse(budgetRaw);
  if (!budgetParsed.success) throw new Error(`[StatBudget] stat_budget.json FAIL: ${JSON.stringify(budgetParsed.error.issues)}`);

  const slotRaw = JSON.parse(readFileSync(join(DATA_ROOT, 'slot_cap.json'), 'utf8'));
  const slotParsed = SlotCapConfigSchema.safeParse(slotRaw);
  if (!slotParsed.success) throw new Error(`[StatBudget] slot_cap.json FAIL: ${JSON.stringify(slotParsed.error.issues)}`);

  const constRaw = JSON.parse(readFileSync(join(DATA_ROOT, 'itemization_constants.json'), 'utf8'));
  const constParsed = StatWeightConfigSchema.safeParse(constRaw);
  if (!constParsed.success) throw new Error(`[StatBudget] itemization_constants.json FAIL: ${JSON.stringify(constParsed.error.issues)}`);

  const rarity_budget = new Map<Rarity, RarityBudget>();
  for (const b of budgetParsed.data.rarity_budget) rarity_budget.set(b.rarity, b);

  const slot_caps = new Map<string, Record<string, number>>();
  for (const [slot, caps] of Object.entries(slotParsed.data.caps_per_slot)) slot_caps.set(slot, caps);

  cached = {
    rarity_budget,
    companion_budget_ratio_bp: budgetParsed.data.companion_budget_ratio_bp,
    slot_caps,
    stat_weight: constParsed.data.stat_weight,
    max_safe_int_stat: constParsed.data.max_safe_int_stat,
    bao_kich_global_cap_bp: constParsed.data.bao_kich_global_cap_bp,
  };
  return cached;
}

/** Pure helper: weighted stat power. */
function computeWeightedPower(
  stats: ItemStatBlock,
  affixes: readonly ItemAffix[],
  weights: Record<string, number>,
): number {
  let power = 0;
  // Stat power
  for (const [key, weight] of Object.entries(weights)) {
    const v = (stats as unknown as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isInteger(v)) {
      power += v * weight;
    }
  }
  // Affix power
  for (const af of affixes) {
    const w = weights[af.type] ?? 1;
    power += af.value_bp_or_raw * w;
  }
  return Math.floor(power / 100); // normalize down to "power score" scale
}

/**
 * Factory: tạo instance StatBudgetRuntime.
 */
export function createStatBudgetRuntime(): StatBudgetRuntime {
  const cfg = loadConfig();

  return {
    computeStatPower(stats, affixes) {
      return computeWeightedPower(stats, affixes, cfg.stat_weight);
    },

    getRarityBudget(rarity) {
      const b = cfg.rarity_budget.get(rarity);
      if (!b) throw new Error(`[StatBudget] unknown rarity: ${rarity}`);
      return b;
    },

    getSlotCap(slot) {
      const caps = cfg.slot_caps.get(slot);
      if (!caps) throw new Error(`[StatBudget] unknown slot: ${slot}`);
      return { slot, caps_per_stat: caps };
    },

    validateAggregatedCritCap(total_crit_rate_bp) {
      return total_crit_rate_bp <= cfg.bao_kich_global_cap_bp;
    },

    validateItem(
      item_id: string,
      rarity: Rarity,
      slot: EquipmentSlot,
      stats: ItemStatBlock,
      affixes: readonly ItemAffix[],
      is_companion: boolean,
    ): BudgetValidationResult {
      const violations: BudgetValidationResult['violations'] = [];

      // 1. Rarity budget
      const rb = this.getRarityBudget(rarity);
      const power = this.computeStatPower(stats, affixes);
      const max_power = is_companion
        ? Math.floor((rb.max_stat_power * cfg.companion_budget_ratio_bp) / 10000)
        : rb.max_stat_power;
      if (power > max_power) {
        violations.push({
          kind: 'over_rarity_budget',
          detail: `${item_id}: power ${power} > max ${max_power} (${rarity}${is_companion ? ' companion' : ''})`,
          measured: power,
          limit: max_power,
        });
      }

      // 2. Affix count
      if (affixes.length > rb.max_affix_count) {
        violations.push({
          kind: 'over_affix_count',
          detail: `${item_id}: ${affixes.length} affix > max ${rb.max_affix_count} (${rarity})`,
          measured: affixes.length,
          limit: rb.max_affix_count,
        });
      }

      // 3. Per-affix power
      for (const af of affixes) {
        const af_weight = cfg.stat_weight[af.type] ?? 1;
        const af_power = Math.floor((af.value_bp_or_raw * af_weight) / 100);
        if (af_power > rb.max_affix_power) {
          violations.push({
            kind: 'over_affix_power',
            detail: `${item_id} affix ${af.id}: power ${af_power} > max ${rb.max_affix_power}`,
            stat_key: af.type,
            measured: af_power,
            limit: rb.max_affix_power,
          });
        }
      }

      // 4. Slot cap per stat
      const slot_caps = cfg.slot_caps.get(slot);
      if (slot_caps) {
        const statRecord = stats as unknown as Record<string, unknown>;
        for (const [stat_key, cap] of Object.entries(slot_caps)) {
          const v = statRecord[stat_key];
          if (typeof v === 'number' && Number.isInteger(v) && v > cap) {
            violations.push({
              kind: 'over_slot_cap',
              detail: `${item_id}: ${stat_key} = ${v} > slot ${slot} cap ${cap}`,
              stat_key,
              measured: v,
              limit: cap,
            });
          }
        }
      }

      // 5. Overflow INT
      const statRecord2 = stats as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(statRecord2)) {
        if (typeof v === 'number') {
          if (!Number.isInteger(v)) {
            violations.push({
              kind: 'overflow_int',
              detail: `${item_id}: ${k} = ${v} is not INT (R31 violation)`,
              stat_key: k,
            });
          } else if (Math.abs(v) > cfg.max_safe_int_stat) {
            violations.push({
              kind: 'overflow_int',
              detail: `${item_id}: ${k} = ${v} > MAX_SAFE_INT_STAT ${cfg.max_safe_int_stat}`,
              stat_key: k,
              measured: v,
              limit: cfg.max_safe_int_stat,
            });
          }
        }
      }

      // 6. Impossible combo: cùng item KHÔNG có cả ATK + INT cao
      const sat = (statRecord2.sat_luc as number | undefined) ?? 0;
      const phap = (statRecord2.phap_luc as number | undefined) ?? 0;
      const half_power = Math.floor(max_power / 2);
      if (sat > 0 && phap > 0 && (sat * 8 + phap * 8) > half_power) {
        violations.push({
          kind: 'impossible_combo',
          detail: `${item_id}: ATK + INT combined power > half of rarity budget (hybrid abuse)`,
          measured: sat * 8 + phap * 8,
          limit: half_power,
        });
      }

      return { is_valid: violations.length === 0, violations };
    },
  };
}

/** Test-only cache reset. */
export function _resetStatBudgetCache(): void {
  cached = null;
}
