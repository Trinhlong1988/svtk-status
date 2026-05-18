/**
 * STATE SNAPSHOT helpers — rollback readiness (Phase 1 hardening).
 *
 * Pure deep clone via structuredClone (Node 17+, JSON-able).
 * Replay-safe: snapshot bit-exact restore for CombatChar / arbitrary state.
 */
import type { CombatChar } from './types.js';

/** Deep clone CombatChar — cooldowns, cc, debuffs, buffs all cloned. */
export function snapshotChar(char: CombatChar): CombatChar {
  return structuredClone(char);
}

/** Restore target in-place from snapshot (mutates target reference). */
export function restoreChar(target: CombatChar, snapshot: CombatChar): void {
  // Clear all keys in target then assign snapshot
  const mut = target as unknown as Record<string, unknown>;
  for (const k of Object.keys(target)) {
    delete mut[k];
  }
  Object.assign(target, structuredClone(snapshot));
}

/** Generic snapshot — works for any JSON-able state. */
export function snapshot<T>(state: T): T {
  return structuredClone(state);
}
