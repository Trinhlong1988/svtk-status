/**
 * STACK RULE — 5 generic behaviors (Phase 2 spec).
 *
 * Pure functions per behavior. Caller (applyEffect) dispatch theo handler.stackBehavior.
 *
 * Behaviors:
 *   - additive   — burn stacks damage (sum amounts, add stacks count)
 *   - refresh    — freeze refreshes duration (latest wins on duration)
 *   - strongest  — shield replaces if incoming amount larger
 *   - capped     — additive but cap stacks at limit
 *   - unique     — first wins, ignore subsequent until expire
 */
import type { StatusEffect, StackBehavior } from './status_types.js';

export type StackOutcome = 'apply_new' | 'refreshed' | 'overwritten' | 'stack_capped' | 'duplicate_unique';

export interface StackResult {
  outcome: StackOutcome;
  /** Resulting effect (may be merged from existing+incoming). */
  effect?: StatusEffect;
  /** Existing effect being overwritten/replaced. */
  removed?: StatusEffect;
}

/**
 * Apply stack rule deterministically.
 *
 * @param existing — current instance on target (undefined if first apply)
 * @param incoming — new instance trying to apply
 * @param stackCap — max stacks for capped behavior
 */
export function applyStackRule(
  existing: StatusEffect | undefined,
  incoming: StatusEffect,
  behavior: StackBehavior,
  stackCap: number,
): StackResult {
  if (!existing) {
    return { outcome: 'apply_new', effect: incoming };
  }

  switch (behavior) {
    case 'additive': {
      const merged: StatusEffect = {
        ...existing,
        stacks: existing.stacks + incoming.stacks,
        amount: existing.amount + incoming.amount,
        // Refresh duration to max of existing remaining vs incoming
        remainingTurns: Math.max(existing.remainingTurns, incoming.remainingTurns),
      };
      return { outcome: 'apply_new', effect: merged };
    }

    case 'refresh': {
      const refreshed: StatusEffect = {
        ...existing,
        remainingTurns: incoming.remainingTurns,
        // Refresh resets last tick (so next tick fires fresh)
        lastTickTurn: incoming.turnApplied,
      };
      return { outcome: 'refreshed', effect: refreshed };
    }

    case 'strongest': {
      if (incoming.amount > existing.amount) {
        return { outcome: 'overwritten', effect: incoming, removed: existing };
      }
      // Existing wins — incoming dropped
      return { outcome: 'duplicate_unique', effect: existing };
    }

    case 'capped': {
      const newStacks = Math.min(existing.stacks + incoming.stacks, stackCap);
      if (newStacks === existing.stacks) {
        // Already at cap — no change
        return { outcome: 'stack_capped', effect: existing };
      }
      const delta = newStacks - existing.stacks;
      const merged: StatusEffect = {
        ...existing,
        stacks: newStacks,
        amount: existing.amount + (incoming.amount * delta) / Math.max(1, incoming.stacks),
        remainingTurns: Math.max(existing.remainingTurns, incoming.remainingTurns),
      };
      // Floor amount to keep INT
      merged.amount = Math.floor(merged.amount);
      return { outcome: 'apply_new', effect: merged };
    }

    case 'unique': {
      // First wins — ignore subsequent
      return { outcome: 'duplicate_unique', effect: existing };
    }
  }
}
