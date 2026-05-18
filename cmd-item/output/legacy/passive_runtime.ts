/**
 * PASSIVE RUNTIME — CMD2.docx Mục VIII.
 *
 * Wrapper trên passive_resolver (5-tuple lock) + recursion guard.
 * SUPPORT: trigger / conflict / strongest_only / exclusive_group / diminishing_return.
 * BLOCK: passive recursion chaos (delegate to ModifierRecursionGuard).
 */
import { resolvePassives } from './passive_resolver.js';
import {
  type ModifierRecursionGuard,
  type RecursionChainEntry,
  type RecursionResult,
} from './modifier_recursion_guard.js';
import { createRecursionGuard } from './modifier_recursion_guard_impl.js';
import type { Item } from './item_registry.js';
import type { ItemPassive, StatModifier } from './itemization_types.js';

export interface PassiveRuntime {
  /** Resolve winners by 5-tuple lock (priority/value DESC/source_type/source_id/insertion_order). */
  resolve(items: readonly Item[]): Map<string, ItemPassive>;

  /** Trigger 1 passive cascade qua guard — block recursion. */
  tryTrigger(
    mod: StatModifier,
    chain: readonly RecursionChainEntry[],
  ): RecursionResult;

  /** Recursion guard (config-driven max_depth). */
  readonly guard: ModifierRecursionGuard;
}

export function createPassiveRuntime(
  guard?: ModifierRecursionGuard,
): PassiveRuntime {
  const g = guard ?? createRecursionGuard();
  return {
    resolve(items) {
      return resolvePassives(items);
    },
    tryTrigger(mod, chain) {
      return g.tryApply(mod, chain);
    },
    guard: g,
  };
}
