/**
 * SET BONUS RUNTIME — CMD2.docx Mục IX.
 *
 * Wrapper trên set_bonus core.
 * SUPPORT: detection / partial / full / conflict policy / companion isolation.
 * BLOCK: duplicate passive stacking (4 conflict policy enforced).
 */
import { resolveSetBonuses } from './set_bonus.js';
import type { Item } from './item_registry.js';
import type { ItemPassive } from './itemization_types.js';

export interface SetBonusRuntime {
  /** Detect active sets + bonus passives sau conflict policy. */
  detect(items: readonly Item[]): {
    active_set_ids: string[];
    bonus_passives: ItemPassive[];
  };

  /** Companion-side detection — isolated from owner (same function, separate Item array). */
  detectForCompanion(companion_items: readonly Item[]): {
    active_set_ids: string[];
    bonus_passives: ItemPassive[];
  };
}

export function createSetBonusRuntime(): SetBonusRuntime {
  return {
    detect(items) {
      return resolveSetBonuses(items);
    },
    detectForCompanion(companion_items) {
      // Separate call ensures namespace isolation — companion items resolved separately.
      return resolveSetBonuses(companion_items);
    },
  };
}
