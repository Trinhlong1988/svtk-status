/**
 * PASSIVE RESOLVER — 5-tuple deterministic (CMD2.docx FINAL FIX #5).
 *
 * Lock order:
 *   1. passive_priority ASC (lower = applied first)
 *   2. value_bp_or_raw DESC (stronger wins ties)
 *   3. source_type ASC (alphabetical)
 *   4. source_item_id lex ASC
 *   5. insertion_order ASC
 *
 * Pure function. Deterministic cross-runtime.
 */
import type { ItemPassive } from './itemization_types.js';
import type { Item } from './item_registry.js';
import { codepointCompare } from '../_shared/codepoint_compare.js';

interface PassiveCandidate {
  passive: ItemPassive;
  source_item_id: string;
  source_type: 'base_item' | 'set_bonus';
  insertion_order: number;
}

/**
 * Resolve passive conflict — 5-tuple lock.
 *
 * @param items    Items equipped
 * @returns        Map<passive_type, ItemPassive> — winner per type
 */
export function resolvePassives(items: readonly Item[]): Map<string, ItemPassive> {
  // Sort items deterministic (id ASC) cho insertion_order
  const sorted = [...items].sort((a, b) => codepointCompare(a.id, b.id));

  // Collect candidates with explicit insertion_order
  const candidatesByType = new Map<string, PassiveCandidate[]>();
  let insert = 0;
  for (const item of sorted) {
    if (!item.passives) continue;
    for (const passive of item.passives) {
      const cand: PassiveCandidate = {
        passive,
        source_item_id: item.id,
        source_type: 'base_item',
        insertion_order: insert++,
      };
      const list = candidatesByType.get(passive.type) ?? [];
      list.push(cand);
      candidatesByType.set(passive.type, list);
    }
  }

  // Resolve winner per type via 5-tuple comparator
  const winners = new Map<string, ItemPassive>();
  for (const [type, candidates] of candidatesByType) {
    candidates.sort((a, b) => {
      // 1. passive_priority ASC
      if (a.passive.passive_priority !== b.passive.passive_priority) {
        return a.passive.passive_priority - b.passive.passive_priority;
      }
      // 2. value_bp_or_raw DESC (stronger wins)
      if (a.passive.value_bp_or_raw !== b.passive.value_bp_or_raw) {
        return b.passive.value_bp_or_raw - a.passive.value_bp_or_raw;
      }
      // 3. source_type ASC
      const ct = codepointCompare(a.source_type, b.source_type);
      if (ct !== 0) return ct;
      // 4. source_item_id lex ASC
      const cs = codepointCompare(a.source_item_id, b.source_item_id);
      if (cs !== 0) return cs;
      // 5. insertion_order ASC
      return a.insertion_order - b.insertion_order;
    });
    winners.set(type, candidates[0]!.passive);
  }
  return winners;
}
