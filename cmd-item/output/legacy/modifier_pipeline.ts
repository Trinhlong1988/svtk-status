/**
 * MODIFIER PIPELINE — Implementation 7-step (CMD2.docx FIX #2 LOCKED).
 *
 * Order: BASE → FLAT → ADDITIVE_BP → MULTIPLICATIVE_BP → FINAL_BP → CLAMP → SOFTCAP
 * Tie-break: priority ASC → sourceType ASC → sourceId lexicographical → insertionOrder ASC
 *
 * Bit-identical replay (CMD2.docx FIX #5).
 *
 * INT only — chainMul helper /10000 intermediate (R31).
 *
 * @see modifier_pipeline_contract.ts
 */
import {
  type StatModifier,
  type ItemStatBlock,
} from './itemization_types.js';
import {
  STEP_ORDER,
  type ModifierPipelineContract,
  type PipelineStep,
  type PipelineSnapshot,
  type StableModifierComparator,
} from './modifier_pipeline_contract.js';
import { applySoftCap } from '../../logic/soft_cap.js';
import { codepointCompare } from '../../_shared/codepoint_compare.js';

// ───────── Stable comparator — 4-tuple EXPLICIT (CMD2.docx FINAL FIX #1 + #2) ─────────
/**
 * Comparator deterministic cross-runtime — KHÔNG depend ECMAScript Array.sort stable.
 *
 * Order:
 *   1. order_priority ASC
 *   2. source_type ASC alphabetical (READ from payload, NOT derive)
 *   3. source_item_id lexicographical
 *   4. modifier_insert_order ASC (EXPLICIT INT, caller maintained)
 */
const stableComparator: StableModifierComparator = {
  compare(a: StatModifier, b: StatModifier): number {
    if (a.order_priority !== b.order_priority) return a.order_priority - b.order_priority;
    const cmpType = codepointCompare(a.source_type, b.source_type);
    if (cmpType !== 0) return cmpType;
    const cmpId = codepointCompare(a.source_item_id, b.source_item_id);
    if (cmpId !== 0) return cmpId;
    return a.modifier_insert_order - b.modifier_insert_order;
  },
};

// ───────── Kind → Step mapping (locked) ─────────
function kindToStep(kind: StatModifier['kind']): PipelineStep | null {
  switch (kind) {
    case 'flat':              return 'step_2_flat';
    case 'pct_bp':            return 'step_3_additive_bp';
    case 'conditional':       return 'step_5_final_bp'; // conditional resolves at final step
    case 'passive':           return 'step_4_multiplicative_bp';
    case 'companion_linked':  return 'step_5_final_bp';
    case 'formation_prep':    return null; // ignored Phase 7
    default: return null;
  }
}

// ───────── BP chain multiplication (R31 INT preservation) ─────────
/**
 * Chain multiply 2 BP values: result = floor(left × right_bp / 10000).
 * INT only — KHÔNG float intermediate.
 */
function chainMul(left: number, right_bp: number): number {
  return Math.floor((left * right_bp) / 10000);
}

// ───────── Apply step pure functions ─────────

function applyFlat(stats: ItemStatBlock, mods: readonly StatModifier[]): ItemStatBlock {
  if (mods.length === 0) return stats;
  const out = { ...stats } as Record<string, unknown>;
  for (const m of mods) {
    const cur = (out[m.stat_key] as number | undefined) ?? 0;
    out[m.stat_key] = cur + m.amount_bp_or_raw;
  }
  return out as ItemStatBlock;
}

function applyAdditiveBP(stats: ItemStatBlock, mods: readonly StatModifier[]): ItemStatBlock {
  if (mods.length === 0) return stats;
  // Additive: sum BP percentages, apply once at end per stat
  const sumByStat = new Map<string, number>();
  for (const m of mods) {
    sumByStat.set(m.stat_key, (sumByStat.get(m.stat_key) ?? 0) + m.amount_bp_or_raw);
  }
  const out = { ...stats } as Record<string, unknown>;
  for (const [stat_key, total_bp] of sumByStat) {
    const cur = (out[stat_key] as number | undefined) ?? 0;
    // additive bonus: stat = stat × (1 + total_bp/10000) = stat + chainMul(stat, total_bp)
    out[stat_key] = cur + chainMul(cur, total_bp);
  }
  return out as ItemStatBlock;
}

function applyMultiplicativeBP(stats: ItemStatBlock, mods: readonly StatModifier[]): ItemStatBlock {
  if (mods.length === 0) return stats;
  const out = { ...stats } as Record<string, unknown>;
  for (const m of mods) {
    const cur = (out[m.stat_key] as number | undefined) ?? 0;
    // multiplicative chain: cur = floor(cur × (10000 + amount_bp) / 10000)
    out[m.stat_key] = chainMul(cur, 10000 + m.amount_bp_or_raw);
  }
  return out as ItemStatBlock;
}

function applyFinalBP(
  stats: ItemStatBlock,
  mods: readonly StatModifier[],
  snapshot: PipelineSnapshot,
): ItemStatBlock {
  if (mods.length === 0) return stats;
  const out = { ...stats } as Record<string, unknown>;
  const tags = snapshot.context_tags ?? [];
  for (const m of mods) {
    // Conditional skip nếu condition không match tag
    if (m.kind === 'conditional' && m.condition && !tags.includes(m.condition)) continue;
    const cur = (out[m.stat_key] as number | undefined) ?? 0;
    out[m.stat_key] = chainMul(cur, 10000 + m.amount_bp_or_raw);
  }
  return out as ItemStatBlock;
}

function applyClamp(stats: ItemStatBlock): ItemStatBlock {
  // Clamp INT nonnegative for absolute stats. Signed for threat_coef_bp.
  const out = { ...stats } as Record<string, unknown>;
  const nonnegKeys = ['hp', 'sat_luc', 'phap_luc', 'defense', 'agility', 'hp_regen_per_turn', 'mana_regen_per_turn',
                      'crit_rate_bp', 'crit_dmg_bp', 'penetration_bp', 'lifesteal_bp', 'dodge_bp'];
  for (const k of nonnegKeys) {
    const v = out[k];
    if (typeof v === 'number' && v < 0) out[k] = 0;
  }
  return out as ItemStatBlock;
}

function applySoftCapStep(stats: ItemStatBlock): ItemStatBlock {
  // Apply R24 soft cap. Bạo Kích cap 50% (5000 BP), DR /2.
  const out = { ...stats } as Record<string, unknown>;
  const crit = out.crit_rate_bp;
  if (typeof crit === 'number') {
    out.crit_rate_bp = applySoftCap(crit, 5000, 2);
  }
  // Other R24 caps (dodge 25% / lifesteal 30%)
  const dodge = out.dodge_bp;
  if (typeof dodge === 'number') {
    out.dodge_bp = applySoftCap(dodge, 2500, 2);
  }
  const lifesteal = out.lifesteal_bp;
  if (typeof lifesteal === 'number') {
    out.lifesteal_bp = applySoftCap(lifesteal, 3000, 2);
  }
  return out as ItemStatBlock;
}

// ───────── Pipeline factory ─────────
export function createModifierPipeline(): ModifierPipelineContract {
  return {
    comparator: stableComparator,

    groupByStep(modifiers) {
      // Group thành Map step → mods, sau đó convert thành array readonly tuple
      const grouped = new Map<PipelineStep, StatModifier[]>();
      for (const step of STEP_ORDER) grouped.set(step, []);

      for (const m of modifiers) {
        const step = kindToStep(m.kind);
        if (!step) continue;
        grouped.get(step)!.push(m);
      }

      // Sort each step theo stable comparator
      const out: Array<readonly [PipelineStep, readonly StatModifier[]]> = [];
      for (const step of STEP_ORDER) {
        const list = grouped.get(step)!;
        list.sort((a, b) => stableComparator.compare(a, b));
        out.push([step, list] as const);
      }
      return out;
    },

    applyPipeline(base_stats, modifiers, snapshot) {
      const grouped = this.groupByStep(modifiers);
      let stats: ItemStatBlock = { ...base_stats };

      // Iterate STEP_ORDER (KHÔNG iterate Map.entries để avoid traversal dependency)
      for (const [step, mods] of grouped) {
        switch (step) {
          case 'step_1_base':
            // Base = input, no modifier apply
            break;
          case 'step_2_flat':
            stats = applyFlat(stats, mods);
            break;
          case 'step_3_additive_bp':
            stats = applyAdditiveBP(stats, mods);
            break;
          case 'step_4_multiplicative_bp':
            stats = applyMultiplicativeBP(stats, mods);
            break;
          case 'step_5_final_bp':
            stats = applyFinalBP(stats, mods, snapshot);
            break;
          case 'step_6_clamp':
            stats = applyClamp(stats);
            break;
          case 'step_7_softcap':
            stats = applySoftCapStep(stats);
            break;
        }
      }
      return stats;
    },

    validateOrderingInvariant(modifiers): true {
      // Compare 2 sorts: original order vs reversed input — phải identical sau sort
      const sorted1 = [...modifiers].sort((a, b) => stableComparator.compare(a, b));
      const sorted2 = [...modifiers].reverse().sort((a, b) => stableComparator.compare(a, b));

      if (sorted1.length !== sorted2.length) {
        throw new Error('[ModifierPipeline] ordering invariant FAIL: length mismatch');
      }
      for (let i = 0; i < sorted1.length; i++) {
        const a = sorted1[i]!;
        const b = sorted2[i]!;
        if (a.source_item_id !== b.source_item_id || a.amount_bp_or_raw !== b.amount_bp_or_raw) {
          throw new Error(`[ModifierPipeline] ordering invariant FAIL at idx ${i}: ${a.source_item_id} vs ${b.source_item_id}`);
        }
      }
      return true;
    },
  };
}
