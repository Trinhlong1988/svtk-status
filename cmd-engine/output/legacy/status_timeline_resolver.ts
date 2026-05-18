/**
 * STATUS TIMELINE RESOLVER — same-tick deterministic ordering (Phase 2 FH FIX #1).
 *
 * PROBLEM (CMD1.docx):
 *   Same-tick status interactions become ambiguous:
 *     - expire + refresh
 *     - cleanse + trigger
 *     - detonation + remove
 *     - aura refresh + stack decay
 *   Without a locked order, client / replay / server may resolve differently.
 *
 * LOCK ORDER (immutable, identical across client / server / replay):
 *
 *   1. EXPIRE      → durations have ticked to 0 this turn (remove first)
 *   2. CLEANSE     → cleanse fires next (consume cleansable effects)
 *   3. REFRESH     → existing effects refreshed (duration / stack)
 *   4. TRIGGER     → tick + on-trigger proc (DOT/HOT/aura tick)
 *   5. APPLY_NEW   → brand-new effect application
 *
 * Within each phase, items sorted by `StatusOrderingComparator` (FIX #5) to
 * eliminate Map insertion order reliance.
 *
 * STRICT ADDITIVE: this module does NOT touch `apply_effect.ts` or tick loop.
 * Caller (encounter manager) bundles same-tick events and invokes
 * `resolveStatusTimeline(events)` to obtain deterministic execution order.
 *
 * Replay-safe: pure function. Same inputs → same output order. Always.
 */
import { z } from 'zod';
import { compareStatusOrderKey, type StatusOrderKey } from './status_ordering.js';

// ─────────────────────────────────────────────────────────
// Timeline event kinds — LOCKED ORDER per CMD1.docx
// ─────────────────────────────────────────────────────────

export const TimelinePhaseSchema = z.enum([
  'EXPIRE',
  'CLEANSE',
  'REFRESH',
  'TRIGGER',
  'APPLY_NEW',
]);
export type TimelinePhase = z.infer<typeof TimelinePhaseSchema>;

/**
 * Phase-to-index map. Lower = resolved earlier. **DO NOT REORDER** —
 * client / server / replay all rely on this exact sequence.
 */
export const TIMELINE_PHASE_INDEX: Readonly<Record<TimelinePhase, number>> = Object.freeze({
  EXPIRE: 0,
  CLEANSE: 1,
  REFRESH: 2,
  TRIGGER: 3,
  APPLY_NEW: 4,
});

// ─────────────────────────────────────────────────────────
// Timeline event payload
// ─────────────────────────────────────────────────────────

export interface TimelineEvent {
  /** Locked phase. */
  phase: TimelinePhase;
  /** Effect type (for telemetry). */
  effectType: string;
  /** Target receiving the action. */
  targetId: string;
  /** Source caster (or 'system' for expire). */
  sourceId: string;
  /** Order key for stable tiebreak within phase (FIX #5). */
  orderKey: StatusOrderKey;
  /** Opaque payload — caller uses to execute the action. */
  payload?: Readonly<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────
// Resolver
// ─────────────────────────────────────────────────────────

/**
 * Sort events into the LOCK ORDER. Stable + deterministic. Pure function.
 *
 * Phase: EXPIRE < CLEANSE < REFRESH < TRIGGER < APPLY_NEW
 * Within phase: `compareStatusOrderKey` (turnApplied → sourceId → effectId → seq)
 *
 * Returns NEW array — caller can iterate to execute.
 */
export function resolveStatusTimeline(events: readonly TimelineEvent[]): TimelineEvent[] {
  const copy = events.slice();
  copy.sort(compareTimelineEvents);
  return copy;
}

function compareTimelineEvents(a: TimelineEvent, b: TimelineEvent): number {
  const pa = TIMELINE_PHASE_INDEX[a.phase];
  const pb = TIMELINE_PHASE_INDEX[b.phase];
  if (pa !== pb) return pa - pb;
  return compareStatusOrderKey(a.orderKey, b.orderKey);
}

/**
 * Group resolved events by phase (telemetry / batch dispatch).
 */
export function groupByPhase(
  events: readonly TimelineEvent[],
): Record<TimelinePhase, TimelineEvent[]> {
  const out: Record<TimelinePhase, TimelineEvent[]> = {
    EXPIRE: [], CLEANSE: [], REFRESH: [], TRIGGER: [], APPLY_NEW: [],
  };
  for (const e of events) out[e.phase].push(e);
  return out;
}

/**
 * Helper — build a timeline event with default order key.
 */
export function makeTimelineEvent(
  phase: TimelinePhase,
  effectType: string,
  targetId: string,
  sourceId: string,
  orderKey: StatusOrderKey,
  payload?: Readonly<Record<string, unknown>>,
): TimelineEvent {
  return { phase, effectType, targetId, sourceId, orderKey, payload };
}

/**
 * Diagnostic — count events per phase (for telemetry / replay diff).
 */
export function timelinePhaseCounts(
  events: readonly TimelineEvent[],
): Readonly<Record<TimelinePhase, number>> {
  const counts: Record<TimelinePhase, number> = {
    EXPIRE: 0, CLEANSE: 0, REFRESH: 0, TRIGGER: 0, APPLY_NEW: 0,
  };
  for (const e of events) counts[e.phase] += 1;
  return counts;
}
