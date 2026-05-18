/**
 * MECHANIC SCHEDULER — telegraphed boss mechanic queue (Phase 6).
 *
 * Owns timeline of pending mechanics:
 *   - mechanic scheduled at turn T with optional telegraphTurns delay
 *   - resolves at turn (T + telegraphTurns)
 *   - delivers MechanicResolveEvent to caller (encounter_manager) for handling
 *
 * Deterministic ordering: pending events sorted by `(resolveTurn ASC, scheduledSeq ASC, mechanicId LEX)`.
 * Stable across replay/restore — uses monotonic `scheduledSeq` not Map insertion.
 *
 * Plug-in dispatch: scheduler does NOT execute mechanic effects — it only emits
 * resolve events. Mechanic effect resolution lives in caller (encounter_manager
 * + spatial_combat_expansion).
 *
 * Replay: snapshot/restore preserves pending queue verbatim.
 */
import { z } from 'zod';
import type { MechanicDef, BossScript } from '../../../cmd-boss/output/legacy/boss_script_registry.js';
import type { BossPhaseState } from '../../../cmd-boss/output/legacy/boss_phase_machine.js';
import type { RNG } from './rng.js';

// ─────────────────────────────────────────────────────────
// Pending mechanic entry
// ─────────────────────────────────────────────────────────

export const PendingMechanicSchema = z.object({
  /** Unique queue entry id (deterministic — encounterId + scheduledSeq). */
  entryId: z.string().min(1),
  /** Source mechanic id (from BossScript). */
  mechanicId: z.string().min(1),
  /** Boss owner. */
  bossId: z.string().min(1),
  /** Turn at which mechanic was scheduled. */
  scheduledAtTurn: z.number().int().nonnegative(),
  /** Turn at which mechanic should resolve. */
  resolveTurn: z.number().int().nonnegative(),
  /** Monotonic sequence id (replay tiebreak). */
  scheduledSeq: z.number().int().nonnegative(),
  /** Telegraphed (non-instant) → boolean for UI/replay. */
  telegraphed: z.boolean(),
});
export type PendingMechanic = z.infer<typeof PendingMechanicSchema>;

// ─────────────────────────────────────────────────────────
// Scheduler state
// ─────────────────────────────────────────────────────────

export interface MechanicSchedulerState {
  encounterId: string;
  /** entryId → pending entry. */
  pending: Map<string, PendingMechanic>;
  /** Monotonic seq for deterministic tiebreak. */
  nextSeq: number;
  /** Mechanics already fired (one-shot bookkeeping per mechanic id). */
  firedOneShot: Set<string>;
  /** HP threshold mechanics already fired (mechanicId set). */
  firedHpThreshold: Set<string>;
}

export function createMechanicScheduler(encounterId: string): MechanicSchedulerState {
  return {
    encounterId,
    pending: new Map(),
    nextSeq: 0,
    firedOneShot: new Set(),
    firedHpThreshold: new Set(),
  };
}

// ─────────────────────────────────────────────────────────
// Scheduling — caller invokes per tick
// ─────────────────────────────────────────────────────────

export interface ScheduleTickInput {
  currentTurn: number;
  encounterStartTurn: number;
  phaseEnteredTurn: number;
  phaseEnteredThisTick: boolean;
  bossHp: number;
  bossMaxHp: number;
  /** RNG for `rng_chance_bp` triggers — caller MUST pass `rng_ai` substream. */
  rngAi: RNG;
}

/**
 * Tick scheduler — scans BossScript mechanics for the active phase, fires any
 * matching trigger by enqueuing pending entries.
 *
 * Returns the list of newly-scheduled entries (for telemetry).
 */
export function tickScheduler(
  state: MechanicSchedulerState,
  script: BossScript,
  phaseState: BossPhaseState,
  input: ScheduleTickInput,
): readonly PendingMechanic[] {
  const phase = script.phases.find((p) => p.phaseId === phaseState.currentPhaseId);
  if (!phase) return [];

  const newlyScheduled: PendingMechanic[] = [];

  for (const mechanicId of phase.mechanicIds) {
    const m = script.mechanics.find((x) => x.mechanicId === mechanicId);
    if (!m) continue;

    if (shouldFireMechanic(m, state, phaseState, input)) {
      const entry = enqueueMechanic(state, script.bossId, m, input.currentTurn);
      newlyScheduled.push(entry);
      // Bookkeeping for one-shot / threshold
      if (m.trigger.kind === 'phase_enter' || m.trigger.kind === 'turn_one_shot') {
        state.firedOneShot.add(scopeId(phaseState.currentPhaseId, m.mechanicId));
      }
      if (m.trigger.kind === 'hp_threshold_bp') {
        state.firedHpThreshold.add(m.mechanicId);
      }
    }
  }

  return newlyScheduled;
}

function shouldFireMechanic(
  m: MechanicDef,
  state: MechanicSchedulerState,
  phase: BossPhaseState,
  input: ScheduleTickInput,
): boolean {
  switch (m.trigger.kind) {
    case 'turn_interval': {
      if (m.trigger.value <= 0) return false;
      const elapsed = input.currentTurn - phase.enteredAtTurn;
      return elapsed > 0 && elapsed % m.trigger.value === 0;
    }
    case 'turn_one_shot': {
      const scopeKey = scopeId(phase.currentPhaseId, m.mechanicId);
      if (state.firedOneShot.has(scopeKey)) return false;
      return input.currentTurn - phase.enteredAtTurn === m.trigger.value;
    }
    case 'phase_enter': {
      if (!input.phaseEnteredThisTick) return false;
      const scopeKey = scopeId(phase.currentPhaseId, m.mechanicId);
      return !state.firedOneShot.has(scopeKey);
    }
    case 'hp_threshold_bp': {
      if (state.firedHpThreshold.has(m.mechanicId)) return false;
      if (input.bossMaxHp <= 0) return false;
      const hpBp = Math.floor((input.bossHp * 10000) / input.bossMaxHp);
      return hpBp <= m.trigger.value;
    }
    case 'rng_chance_bp': {
      const roll = Math.floor(input.rngAi() * 10000);
      return roll < m.trigger.value;
    }
  }
}

function enqueueMechanic(
  state: MechanicSchedulerState,
  bossId: string,
  m: MechanicDef,
  currentTurn: number,
): PendingMechanic {
  const seq = state.nextSeq++;
  const resolveTurn = currentTurn + m.telegraphTurns;
  const entry: PendingMechanic = {
    entryId: `mech_${state.encounterId}_${seq}`,
    mechanicId: m.mechanicId,
    bossId,
    scheduledAtTurn: currentTurn,
    resolveTurn,
    scheduledSeq: seq,
    telegraphed: m.telegraphTurns > 0,
  };
  state.pending.set(entry.entryId, entry);
  return entry;
}

// ─────────────────────────────────────────────────────────
// Resolve — caller drains ready mechanics each tick
// ─────────────────────────────────────────────────────────

/**
 * Drain mechanics whose resolveTurn <= currentTurn. Returns them sorted
 * deterministically: `(resolveTurn ASC, scheduledSeq ASC, mechanicId LEX)`.
 *
 * Removes drained entries from `state.pending`.
 */
export function drainReadyMechanics(
  state: MechanicSchedulerState,
  currentTurn: number,
): readonly PendingMechanic[] {
  const ready: PendingMechanic[] = [];
  for (const entry of state.pending.values()) {
    if (entry.resolveTurn <= currentTurn) ready.push(entry);
  }
  ready.sort(comparePending);
  for (const e of ready) state.pending.delete(e.entryId);
  return ready;
}

function comparePending(a: PendingMechanic, b: PendingMechanic): number {
  if (a.resolveTurn !== b.resolveTurn) return a.resolveTurn - b.resolveTurn;
  if (a.scheduledSeq !== b.scheduledSeq) return a.scheduledSeq - b.scheduledSeq;
  if (a.mechanicId < b.mechanicId) return -1;
  if (a.mechanicId > b.mechanicId) return 1;
  return 0;
}

export function pendingCount(state: MechanicSchedulerState): number {
  return state.pending.size;
}

/** Sorted pending — for telemetry / UI / replay. */
export function listPending(state: MechanicSchedulerState): readonly PendingMechanic[] {
  return [...state.pending.values()].sort(comparePending);
}

/** Clear pending — used on phase reset / wipe. */
export function clearPending(state: MechanicSchedulerState): void {
  state.pending.clear();
}

/** Snapshot for replay. */
export function snapshotScheduler(state: MechanicSchedulerState): MechanicSchedulerState {
  return {
    encounterId: state.encounterId,
    pending: new Map(state.pending),
    nextSeq: state.nextSeq,
    firedOneShot: new Set(state.firedOneShot),
    firedHpThreshold: new Set(state.firedHpThreshold),
  };
}

export function restoreScheduler(snap: MechanicSchedulerState): MechanicSchedulerState {
  return snapshotScheduler(snap);
}

function scopeId(phaseId: string, mechanicId: string): string {
  return `${phaseId}::${mechanicId}`;
}
