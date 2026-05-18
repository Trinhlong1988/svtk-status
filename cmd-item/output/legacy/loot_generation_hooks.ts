/**
 * LOOT GENERATION HOOKS — CMD2.docx Mục XV.
 *
 * STRICT: hooks/interfaces ONLY. KHÔNG build economy ownership runtime.
 *
 * Itemization expose contract cho LootDropSystem (CMD other ownership) consume.
 * RNG streams isolated:
 *  - rng_loot: owner = loot_drop_system (forbidden in itemization)
 *  - rng_affix: owner = itemization (used here for affix roll only)
 *  - rng_rarity: owner = itemization (used here for rarity roll only)
 */
import seedrandom from 'seedrandom';
import {
  type ItemAffix,
  type EquipmentSlot,
  type Rarity,
} from './itemization_types.js';
import { createAffixRng, rollAffixes } from './affix_pool.js';
import type { Item } from './item_registry.js';
import { codepointCompare } from '../_shared/codepoint_compare.js';

export interface LootRollContext {
  /** Encounter id (boss/mob/companion). */
  encounter_id: string;
  /** Drop index in this encounter (0-based). */
  drop_index: number;
  /** Player id receiving (for affix seed). */
  player_id: string;
  /** Server tick. */
  tick: number;
}

export interface LootRollResult {
  /** Selected rarity. */
  rarity: Rarity;
  /** Selected slot (caller decides item id). */
  slot: EquipmentSlot;
  /** Rolled affix list. */
  affixes: readonly ItemAffix[];
  /** Deterministic seed used (for replay). */
  seed_used: string;
}

export interface LootGenerationHooks {
  /** Roll rarity từ weighted distribution (deterministic seeded). */
  rollRarity(
    weights: Readonly<Record<Rarity, number>>,
    ctx: LootRollContext,
  ): Rarity;

  /** Roll affix cho given slot+rarity. */
  rollAffixForDrop(
    slot: EquipmentSlot,
    rarity: Rarity,
    ctx: LootRollContext,
  ): { affixes: ItemAffix[]; seed_used: string };

  /** Boss drop helper (multi-item). */
  rollBossDrop(
    drop_count: number,
    slot_options: readonly EquipmentSlot[],
    rarity_weights: Readonly<Record<Rarity, number>>,
    ctx: LootRollContext,
  ): LootRollResult[];

  /** Companion drop — separate stream (companion-aware loot). */
  rollCompanionDrop(
    slot_options: readonly EquipmentSlot[],
    rarity_weights: Readonly<Record<Rarity, number>>,
    companion_id: string,
    ctx: LootRollContext,
  ): LootRollResult;

  /** Set piece drop — caller pre-selected set. */
  rollSetPieceDrop(
    set_id: string,
    candidate_items: readonly Item[],
    ctx: LootRollContext,
  ): { picked_item_id: string | null; seed_used: string };
}

// Helper: pick từ weighted dict deterministic.
function pickWeighted(
  weights: Readonly<Record<string, number>>,
  rng: seedrandom.PRNG,
): string {
  const sortedKeys = Object.keys(weights).sort();
  let total = 0;
  for (const k of sortedKeys) total += weights[k] ?? 0;
  if (total <= 0) return sortedKeys[0] ?? '';
  const r = rng() * total;
  let cum = 0;
  for (const k of sortedKeys) {
    cum += weights[k] ?? 0;
    if (r < cum) return k;
  }
  return sortedKeys[sortedKeys.length - 1] ?? '';
}

export function createLootGenerationHooks(): LootGenerationHooks {
  return {
    rollRarity(weights, ctx) {
      const seed = `rng_rarity:${ctx.encounter_id}:${ctx.drop_index}`;
      const rng = seedrandom(seed);
      const picked = pickWeighted(weights as Readonly<Record<string, number>>, rng);
      return picked as Rarity;
    },

    rollAffixForDrop(slot, rarity, ctx) {
      // Affix count by rarity
      const COUNT: Record<Rarity, number> = { common: 1, rare: 2, epic: 3, legendary: 4, mythic: 5 };
      const count = COUNT[rarity];
      const seed = `${ctx.player_id}:drop_${ctx.encounter_id}_${ctx.drop_index}`;
      const rng = createAffixRng(seed);
      const rolled = rollAffixes(slot, count, rng);
      return { affixes: [...rolled].sort((a, b) => codepointCompare(a.id, b.id)), seed_used: seed };
    },

    rollBossDrop(drop_count, slot_options, rarity_weights, ctx) {
      const out: LootRollResult[] = [];
      const sortedSlots = [...slot_options].sort();
      for (let i = 0; i < drop_count; i++) {
        const sub_ctx: LootRollContext = { ...ctx, drop_index: ctx.drop_index + i };
        const rarity = this.rollRarity(rarity_weights, sub_ctx);
        // Pick slot deterministic from index
        const slot = sortedSlots[i % sortedSlots.length]!;
        const { affixes, seed_used } = this.rollAffixForDrop(slot, rarity, sub_ctx);
        out.push({ rarity, slot, affixes, seed_used });
      }
      return out;
    },

    rollCompanionDrop(slot_options, rarity_weights, companion_id, ctx) {
      const sub_ctx: LootRollContext = {
        ...ctx,
        encounter_id: `${ctx.encounter_id}:companion_${companion_id}`,
      };
      const rarity = this.rollRarity(rarity_weights, sub_ctx);
      const sortedSlots = [...slot_options].sort();
      const slot = sortedSlots[ctx.drop_index % sortedSlots.length]!;
      const { affixes, seed_used } = this.rollAffixForDrop(slot, rarity, sub_ctx);
      return { rarity, slot, affixes, seed_used };
    },

    rollSetPieceDrop(set_id, candidate_items, ctx) {
      const filtered = candidate_items.filter(it => it.set_id === set_id);
      if (filtered.length === 0) return { picked_item_id: null, seed_used: '' };
      const seed = `rng_rarity:setpiece_${set_id}:${ctx.encounter_id}:${ctx.drop_index}`;
      const rng = seedrandom(seed);
      const sorted = [...filtered].sort((a, b) => codepointCompare(a.id, b.id));
      const idx = Math.floor(rng() * sorted.length);
      return { picked_item_id: sorted[idx]?.id ?? null, seed_used: seed };
    },
  };
}
