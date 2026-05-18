/**
 * STATUS ORDERING INVARIANT — replay-safe stable comparator (Phase 2 FH FIX #5).
 *
 * PROBLEM (CMD1.docx):
 *   "DO NOT rely on Map insertion order ONLY. ADD: explicit stable comparator."
 *
 * Status pipeline previously iterated via Map insertion order at multiple points:
 *   - apply order (cluster of pending applies same tick)
 *   - trigger order (DOT/HOT/aura tick same turn)
 *   - stack order (additive resolution of same-type effects)
 *   - expire order (multiple effects expiring same turn)
 *   - cleanse order (cleanse picks candidates from active list)
 *
 * This file provides ONE canonical `StatusOrderKey` + `compareStatusOrderKey` that
 * EVERY ordering pass must use. No exceptions.
 *
 * LOCK ORDER (immutable):
 *   1. turnApplied       ASC  (earlier-applied effect resolves first)
 *   2. sourceId          LEX  (deterministic across casters)
 *   3. effectId          LEX  (per-instance unique id LEX tiebreak)
 *   4. emitSeq           ASC  (monotonic per-action counter — final tiebreak)
 *
 * Pure type. No state. Same inputs → identical comparator output.
 */
import type { StatusEffect } from './status_types.js';

// ─────────────────────────────────────────────────────────
// Order key
// ─────────────────────────────────────────────────────────

export interface StatusOrderKey {
  /** Turn at which effect was applied. */
  turnApplied: number;
  /** Source caster id (LEX tiebreak). */
  sourceId: string;
  /** Effect instance id (LEX tiebreak). */
  effectId: string;
  /** Per-action monotonic emit sequence (final tiebreak). */
  emitSeq: number;
}

/**
 * Comparator function: negative if a < b, positive if a > b, 0 if equal.
 *
 * Order: turnApplied ASC → sourceId LEX → effectId LEX → emitSeq ASC.
 */
export function compareStatusOrderKey(a: StatusOrderKey, b: StatusOrderKey): number {
  if (a.turnApplied !== b.turnApplied) return a.turnApplied - b.turnApplied;
  if (a.sourceId < b.sourceId) return -1;
  if (a.sourceId > b.sourceId) return 1;
  if (a.effectId < b.effectId) return -1;
  if (a.effectId > b.effectId) return 1;
  return a.emitSeq - b.emitSeq;
}

/**
 * Build canonical order key from a StatusEffect + monotonic seq.
 */
export function makeStatusOrderKey(effect: StatusEffect, emitSeq: number): StatusOrderKey {
  return {
    turnApplied: effect.turnApplied,
    sourceId: effect.sourceId,
    effectId: effect.effectId,
    emitSeq,
  };
}

/**
 * Equality check (for dedup / cache invalidation).
 */
export function statusOrderKeyEquals(a: StatusOrderKey, b: StatusOrderKey): boolean {
  return a.turnApplied === b.turnApplied
    && a.sourceId === b.sourceId
    && a.effectId === b.effectId
    && a.emitSeq === b.emitSeq;
}

// ─────────────────────────────────────────────────────────
// Status iteration helpers — replace Map insertion order callers
// ─────────────────────────────────────────────────────────

/**
 * Sort an array of `StatusEffect` deterministically. Used by:
 *   - tick loop (DOT/HOT fire order)
 *   - cleanse picker
 *   - expire sweep
 *
 * Caller passes optional `emitSeqOf(effect) → number` if it tracks per-effect
 * seq externally; otherwise effects are compared by (turn, source, id, 0).
 */
export function sortStatusEffectsStable<T extends StatusEffect>(
  effects: T[],
  emitSeqOf?: (e: T) => number,
): T[] {
  return effects.sort((a, b) => {
    const ka = makeStatusOrderKey(a, emitSeqOf ? emitSeqOf(a) : 0);
    const kb = makeStatusOrderKey(b, emitSeqOf ? emitSeqOf(b) : 0);
    return compareStatusOrderKey(ka, kb);
  });
}

// ─────────────────────────────────────────────────────────
// Per-encounter monotonic seq counter
// ─────────────────────────────────────────────────────────

/**
 * Per-encounter monotonic seq for tiebreaking. Caller (encounter manager) owns
 * 1 instance per active encounter; bumps on every status emit.
 *
 * REQUIRED tiebreaker — without it, same-(turn, source, effectType) status
 * applied within the same caster action could collide on order key.
 */
export interface StatusEmitSeqState {
  next: number;
}

export function createStatusEmitSeq(start: number = 0): StatusEmitSeqState {
  return { next: start };
}

export function nextStatusEmitSeq(state: StatusEmitSeqState): number {
  const v = state.next;
  state.next += 1;
  return v;
}

/** Reset on encounter end. */
export function resetStatusEmitSeq(state: StatusEmitSeqState): void {
  state.next = 0;
}
