/**
 * STATUS PROTECTION — runtime enforcement của PROTECTED_STATUS_FIELDS (FIX #2).
 *
 * Listener (passive / Module 4 ThreatService / future modding) có thể vô tình
 * mutate effectId/sourceId/targetId/turnApplied/category — corrupts replay.
 *
 * Two-layer defense:
 *   1. assertNoProtectedMutation — diff old/new shallow, throw nếu protected field changed
 *   2. createProtectedView       — Proxy wrap StatusEffect, throw set on protected field
 *
 * Hot-path: assertNoProtectedMutation chỉ run khi DEBUG_STATUS_GUARD=1 (zero overhead prod).
 * Integration: applyEffect Step 7 wrap stackResult.effect với createProtectedView trước
 * khi handover handler.onApply (handler không được mutate identity).
 */
import {
  type StatusEffect,
  PROTECTED_STATUS_FIELDS,
} from './status_types.js';

export class ProtectedStatusMutationError extends Error {
  constructor(
    public readonly effectId: string,
    public readonly field: string,
    public readonly oldValue: unknown,
    public readonly newValue: unknown,
  ) {
    super(
      `[ProtectedStatusMutation] effectId=${effectId} field='${field}' ` +
      `oldValue=${JSON.stringify(oldValue)} newValue=${JSON.stringify(newValue)} — ` +
      `field is in PROTECTED_STATUS_FIELDS list (effect identity).`,
    );
    this.name = 'ProtectedStatusMutationError';
  }
}

const PROTECTED_SET = new Set(PROTECTED_STATUS_FIELDS);

/**
 * Diff old vs new StatusEffect shallow. Throws ProtectedStatusMutationError on first
 * mismatch in protected field.
 *
 * Use after listener returns / pre_resolve mutation merge / post-handler onApply.
 */
export function assertNoProtectedMutation(
  before: StatusEffect,
  after: StatusEffect,
): void {
  for (const field of PROTECTED_STATUS_FIELDS) {
    const o = (before as unknown as Record<string, unknown>)[field];
    const n = (after as unknown as Record<string, unknown>)[field];
    if (o !== n) {
      throw new ProtectedStatusMutationError(after.effectId, field, o, n);
    }
  }
}

/**
 * Wrap StatusEffect in Proxy — throw on set into PROTECTED field.
 * Read-through (no copy). Hot-path safe (Proxy trap only triggers on write).
 *
 * Use trong applyEffect Step 7 pre-handler.onApply: handler được phép mutate
 * remainingTurns / stacks / amount / lastTickTurn (whitelist) nhưng KHÔNG được
 * mutate identity field.
 */
export function createProtectedView<T extends StatusEffect>(effect: T): T {
  return new Proxy(effect, {
    set(target, prop, value): boolean {
      if (typeof prop === 'string' && PROTECTED_SET.has(prop)) {
        const old = (target as unknown as Record<string, unknown>)[prop];
        if (old !== value) {
          throw new ProtectedStatusMutationError(target.effectId, prop, old, value);
        }
      }
      (target as unknown as Record<string | symbol, unknown>)[prop] = value;
      return true;
    },
    deleteProperty(target, prop): boolean {
      if (typeof prop === 'string' && PROTECTED_SET.has(prop)) {
        throw new ProtectedStatusMutationError(target.effectId, prop, (target as unknown as Record<string, unknown>)[prop], undefined);
      }
      delete (target as unknown as Record<string | symbol, unknown>)[prop];
      return true;
    },
  }) as T;
}
