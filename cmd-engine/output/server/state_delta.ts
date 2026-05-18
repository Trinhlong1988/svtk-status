/**
 * STATE DELTA — Phase 1 hardening FIX #7 (extension points only).
 *
 * Current pipeline directly mutates `caster.mana` / `target.hp` (R5 spec). Future
 * netcode + rollback need diff-based state patching. This file defines extension
 * point shape — Module 10 Network sẽ adopt khi cần.
 *
 * KHÔNG migrate Module 1 pipeline ngay (Mr.Long instruction: "DO NOT migrate
 * current pipeline yet. Only prepare extension points + documentation.").
 *
 * Concepts:
 *   - StateMutation: declarative diff (target → field → newValue)
 *   - applyMutation: apply diff to state (in-place or clone)
 *   - rollbackMutation: invert diff (need oldValue captured at apply time)
 *   - Command sourcing: mutations log → replay = sequential apply
 */

export type StatePath = readonly (string | number)[];

export interface StateMutation {
  /** ISO turn / action index — tie-break for ordering. */
  seq: number;
  /** Path: ['chars', 'p1', 'hp'] etc. */
  path: StatePath;
  /** New value. */
  value: number | string | boolean | null;
  /** Old value — captured at apply time, needed for rollback. */
  oldValue?: number | string | boolean | null;
}

/** Get nested value at path (read-only). */
export function getAtPath(state: unknown, path: StatePath): unknown {
  let cur: unknown = state;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

/**
 * Apply mutation in-place. Captures oldValue into mutation for future rollback.
 * Returns mutated mutation (with oldValue filled).
 */
export function applyMutation(state: unknown, mutation: StateMutation): StateMutation {
  if (mutation.path.length === 0) throw new Error('StateMutation path cannot be empty');
  const parentPath = mutation.path.slice(0, -1);
  const leaf = mutation.path[mutation.path.length - 1]!;
  const parent = getAtPath(state, parentPath) as Record<string | number, unknown> | null | undefined;
  if (parent === null || parent === undefined) {
    throw new Error(`StateMutation parent path not found: ${JSON.stringify(parentPath)}`);
  }
  const oldValue = parent[leaf] as StateMutation['oldValue'];
  parent[leaf] = mutation.value;
  return { ...mutation, oldValue };
}

/**
 * Rollback mutation — restore oldValue.
 * Requires mutation.oldValue captured at apply time.
 */
export function rollbackMutation(state: unknown, mutation: StateMutation): void {
  if (mutation.oldValue === undefined) {
    throw new Error('Cannot rollback mutation without oldValue captured');
  }
  if (mutation.path.length === 0) throw new Error('StateMutation path cannot be empty');
  const parentPath = mutation.path.slice(0, -1);
  const leaf = mutation.path[mutation.path.length - 1]!;
  const parent = getAtPath(state, parentPath) as Record<string | number, unknown> | null | undefined;
  if (parent === null || parent === undefined) return;
  parent[leaf] = mutation.oldValue;
}

/**
 * Command sourcing — sequential apply mutations from log.
 * Replay-safe: identical mutations sequence → identical state.
 */
export function applyMutationLog(state: unknown, log: readonly StateMutation[]): StateMutation[] {
  const applied: StateMutation[] = [];
  const sorted = [...log].sort((a, b) => a.seq - b.seq);
  for (const m of sorted) {
    applied.push(applyMutation(state, m));
  }
  return applied;
}
