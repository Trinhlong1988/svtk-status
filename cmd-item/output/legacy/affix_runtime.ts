/**
 * AFFIX RUNTIME — CMD2.docx Mục X.
 *
 * Wrapper trên affix_pool core.
 * SUPPORT: generation / validation / rarity weighting / deterministic ordering / replay-safe.
 * STRICT: isolated RNG stream `rng_affix` ONLY (Mục XIII RNG ownership lock).
 *
 * Affix sorted by id (lex) sau roll cho deterministic ordering cross-runtime.
 */
import seedrandom from 'seedrandom';
import {
  type ItemAffix,
  type EquipmentSlot,
  type Rarity,
} from './itemization_types.js';
import {
  rollAffixes,
  createAffixRng,
  getAffixPoolForSlot,
} from './affix_pool.js';
import { codepointCompare } from '../../_shared/codepoint_compare.js';

// Affix count per rarity (CMD2 Mục XI rarity scaling).
const AFFIX_COUNT_BY_RARITY: Record<Rarity, number> = {
  common: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
  mythic: 5,
};

export interface AffixRuntime {
  /** Generate N affix (rarity-weighted) qua isolated rng_affix stream. */
  generate(slot: EquipmentSlot, rarity: Rarity, seed: string): ItemAffix[];

  /** Get pool snapshot cho slot. */
  getPool(slot: EquipmentSlot): readonly { id: string; type: string; min: number; max: number }[];

  /** Validate 1 affix nằm trong pool + value trong [min, max]. */
  validate(slot: EquipmentSlot, affix: ItemAffix): boolean;

  /** Create new isolated rng_affix stream. */
  createRng(seed: string): seedrandom.PRNG;
}

/** Sort affixes by id lex — deterministic ordering cross-runtime. */
function sortDeterministic(affixes: ItemAffix[]): ItemAffix[] {
  return [...affixes].sort((a, b) => codepointCompare(a.id, b.id));
}

export function createAffixRuntime(): AffixRuntime {
  return {
    generate(slot, rarity, seed) {
      const count = AFFIX_COUNT_BY_RARITY[rarity];
      const rng = createAffixRng(seed);
      const rolled = rollAffixes(slot, count, rng);
      return sortDeterministic(rolled);
    },

    getPool(slot) {
      return getAffixPoolForSlot(slot);
    },

    validate(slot, affix) {
      const pool = getAffixPoolForSlot(slot);
      const entry = pool.find(e => e.id === affix.id);
      if (!entry) return false;
      if (entry.type !== affix.type) return false;
      if (!Number.isInteger(affix.value_bp_or_raw)) return false;
      return affix.value_bp_or_raw >= entry.min && affix.value_bp_or_raw <= entry.max;
    },

    createRng(seed) {
      return createAffixRng(seed);
    },
  };
}
