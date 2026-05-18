/**
 * BOSS TIMELINE RESOLVER — same-tick mechanic deterministic ordering (Phase 6 FP FIX #1).
 *
 * PROBLEM (CMD1.docx Phase 6 Final Perfect Pass):
 *   Same-tick boss mechanic interactions become ambiguous:
 *     - phase transition
 *     - cinematic lock
 *     - delayed AoE
 *     - aggro reset
 *     - wipe check
 *     - summon trigger
 *
 * LOCK ORDER (immutable — client / server / replay MUST agree):
 *
 *   1. PHASE_TRANSITION   → state change first; downstream mechanics use new phase
 *   2. CINEMATIC_LOCK     → engage lock before any spatial / damage resolution
 *   3. AGGRO_RESET        → wipe threat before new aggro events
 *   4. DELAYED_AOE        → ground markers resolve (damage zones)
 *   5. WIPE_CHECK         → assess fail-state after AoE
 *   6. SUMMON             → adds enter combat at end of tick
 *   7. CLEANUP            → free expired markers / clear chain locks
 *
 * Within each phase, items sorted by `BossMechanicOrderKey`:
 *   resolveTurn ASC → scheduledSeq ASC → mechanicId LEX
 *
 * Pure function. Same inputs → same output. Always.
 *
 * STRICT ADDITIVE: this file does NOT mutate scheduler / encounter state.
 * Caller (encounter_manager) bundles same-tick events and invokes
 * `resolveBossTimeline()` to obtain execution order.
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────
// Boss timeline phases — LOCKED ORDER per CMD1.docx
// ─────────────────────────────────────────────────────────

export const BossTimelinePhaseSchema = z.enum([
  'PHASE_TRANSITION',
  'CINEMATIC_LOCK',
  'AGGRO_RESET',
  'DELAYED_AOE',
  'WIPE_CHECK',
  'SUMMON',
  'CLEANUP',
]);
export type BossTimelinePhase = z.infer<typeof BossTimelinePhaseSchema>;

/**
 * Phase-to-index map. Lower = resolved earlier.
 * Object.frozen — accidental mutation rejected at runtime.
 */
export const BOSS_TIMELINE_PHASE_INDEX: Readonly<Record<BossTimelinePhase, number>> = Object.freeze({
  PHASE_TRANSITION: 0,
  CINEMATIC_LOCK:   1,
  AGGRO_RESET:      2,
  DELAYED_AOE:      3,
  WIPE_CHECK:       4,
  SUMMON:           5,
  CLEANUP:          6,
});

// ─────────────────────────────────────────────────────────
// Order key (replay-safe tiebreak)
// ─────────────────────────────────────────────────────────

export interface BossMechanicOrderKey {
  /** Turn at which mechanic resolves. */
  resolveTurn: number;
  /** Monotonic scheduler sequence. */
  scheduledSeq: number;
  /** Mechanic id (LEX final tiebreak). */
  mechanicId: string;
}

export function compareBossMechanicOrderKey(
  a: BossMechanicOrderKey,
  b: BossMechanicOrderKey,
): number {
  if (a.resolveTurn !== b.resolveTurn) return a.resolveTurn - b.resolveTurn;
  if (a.scheduledSeq !== b.scheduledSeq) return a.scheduledSeq - b.scheduledSeq;
  if (a.mechanicId < b.mechanicId) return -1;
  if (a.mechanicId > b.mechanicId) return 1;
  return 0;
}

// ─────────────────────────────────────────────────────────
// Timeline event payload
// ─────────────────────────────────────────────────────────

export interface BossTimelineEvent {
  phase: BossTimelinePhase;
  bossId: string;
  mechanicId: string;
  orderKey: BossMechanicOrderKey;
  payload?: Readonly<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────
// Resolver
// ─────────────────────────────────────────────────────────

/**
 * Sort events into the LOCK ORDER. Stable + deterministic. Pure function.
 *
 * Phase order: PHASE_TRANSITION < CINEMATIC_LOCK < AGGRO_RESET < DELAYED_AOE <
 *              WIPE_CHECK < SUMMON < CLEANUP.
 *
 * Within phase: BossMechanicOrderKey (resolveTurn → scheduledSeq → mechanicId).
 *
 * Returns NEW array — caller iterates to dispatch.
 */
export function resolveBossTimeline(
  events: readonly BossTimelineEvent[],
): BossTimelineEvent[] {
  const copy = events.slice();
  copy.sort(compareBossTimelineEvents);
  return copy;
}

function compareBossTimelineEvents(a: BossTimelineEvent, b: BossTimelineEvent): number {
  const pa = BOSS_TIMELINE_PHASE_INDEX[a.phase];
  const pb = BOSS_TIMELINE_PHASE_INDEX[b.phase];
  if (pa !== pb) return pa - pb;
  return compareBossMechanicOrderKey(a.orderKey, b.orderKey);
}

/** Group resolved events by phase (telemetry / batch dispatch). */
export function groupBossTimelineByPhase(
  events: readonly BossTimelineEvent[],
): Record<BossTimelinePhase, BossTimelineEvent[]> {
  const out: Record<BossTimelinePhase, BossTimelineEvent[]> = {
    PHASE_TRANSITION: [], CINEMATIC_LOCK: [], AGGRO_RESET: [],
    DELAYED_AOE: [], WIPE_CHECK: [], SUMMON: [], CLEANUP: [],
  };
  for (const e of events) out[e.phase].push(e);
  return out;
}

/** Diagnostic — count events per phase. */
export function bossTimelinePhaseCounts(
  events: readonly BossTimelineEvent[],
): Readonly<Record<BossTimelinePhase, number>> {
  const counts: Record<BossTimelinePhase, number> = {
    PHASE_TRANSITION: 0, CINEMATIC_LOCK: 0, AGGRO_RESET: 0,
    DELAYED_AOE: 0, WIPE_CHECK: 0, SUMMON: 0, CLEANUP: 0,
  };
  for (const e of events) counts[e.phase] += 1;
  return counts;
}

/** Helper — build a timeline event. */
export function makeBossTimelineEvent(
  phase: BossTimelinePhase,
  bossId: string,
  mechanicId: string,
  orderKey: BossMechanicOrderKey,
  payload?: Readonly<Record<string, unknown>>,
): BossTimelineEvent {
  return { phase, bossId, mechanicId, orderKey, payload };
}

/**
 * Map a `MechanicDef.kind` to its canonical timeline phase.
 *
 * Used by encounter_manager to auto-assign phase when dispatching resolved
 * mechanics from mechanic_scheduler. Caller MAY override per event.
 */
export function defaultPhaseForMechanicKind(kind: string): BossTimelinePhase {
  switch (kind) {
    case 'spatial_aoe':
    case 'spatial_line':
    case 'spatial_cone':
    case 'forced_movement':
      return 'DELAYED_AOE';
    case 'cinematic_lock': return 'CINEMATIC_LOCK';
    case 'aggro_reset':    return 'AGGRO_RESET';
    case 'wipe_check':     return 'WIPE_CHECK';
    case 'summon':         return 'SUMMON';
    case 'enrage_buff':    return 'PHASE_TRANSITION';
    case 'custom':         return 'CLEANUP';
    default:               return 'CLEANUP';
  }
}
