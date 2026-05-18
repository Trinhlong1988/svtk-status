/**
 * BOSS PHASE MACHINE — phase transition state machine (Phase 6).
 *
 * Boss combat divides into PHASES separated by trigger conditions (HP threshold,
 * turn elapsed, kill count, mechanic flag). Each phase has its own rotation +
 * mechanic set.
 *
 * DATA-DRIVEN. No `if(bossId === ...)` chains — phase definition lives in
 * BossScript (JSON-loadable). This file owns ONLY the runtime state machine.
 *
 * Deterministic: phase transition decisions are pure function of `(bossState, hp, turn)`.
 * Same inputs → same phase progression. Safe for replay/rollback.
 *
 * Phase ordering convention:
 *   - phases[].enterCondition evaluated IN ORDER per tick
 *   - first matching threshold-not-yet-fired wins
 *   - phase transition is monotonic forward (no fallback to earlier phase except via reset)
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────
// Phase definition (DATA — loadable from JSON)
// ─────────────────────────────────────────────────────────

export const PhaseTriggerKindSchema = z.enum([
  'hp_threshold_bp',       // boss hp / maxHp <= threshold (BP, 10000 = 100%)
  'turn_threshold',        // currentTurn - encounterStart >= threshold
  'kill_count_threshold',  // boss kill count >= threshold
  'mechanic_flag',         // arbitrary boolean flag set by mechanic_scheduler
  'enrage_timer',          // hard enrage (force final phase)
]);
export type PhaseTriggerKind = z.infer<typeof PhaseTriggerKindSchema>;

export const PhaseTriggerSchema = z.object({
  kind: PhaseTriggerKindSchema,
  /** Threshold value (interpretation per kind). For hp_threshold_bp: 0-10000. */
  threshold: z.number().int().nonnegative(),
  /** Optional named flag (for mechanic_flag). */
  flagName: z.string().optional(),
});
export type PhaseTrigger = z.infer<typeof PhaseTriggerSchema>;

export const BossPhaseSchema = z.object({
  phaseId: z.string().min(1).max(64),
  /** Display name for telemetry. */
  name: z.string().min(1).max(128).optional(),
  /** Trigger to enter this phase (undefined = initial/phase1). */
  enterTrigger: PhaseTriggerSchema.optional(),
  /** Skill rotation ids (cycled by mechanic_scheduler). */
  rotation: z.array(z.string()).default([]),
  /** Mechanic ids active in this phase. */
  mechanicIds: z.array(z.string()).default([]),
  /** Target policy override for this phase (boss_target_hook BossTargetPolicyKind). */
  targetPolicyKind: z.string().optional(),
  /** Threat reset on phase enter (raid mechanic — wipe aggro). */
  resetThreatOnEnter: z.boolean().default(false),
  /** Formation reset reason emitted on phase enter (for boss room move). */
  formationResetOnEnter: z.boolean().default(false),
});
export type BossPhase = z.infer<typeof BossPhaseSchema>;

// ─────────────────────────────────────────────────────────
// Runtime state
// ─────────────────────────────────────────────────────────

export interface BossPhaseState {
  bossId: string;
  currentPhaseId: string;
  /** Index into phases array (monotonic forward). */
  phaseIndex: number;
  /** Turn at which current phase was entered. */
  enteredAtTurn: number;
  /** Mechanic flags set by mechanic_scheduler (for `mechanic_flag` triggers). */
  flags: Map<string, boolean>;
  /** Phase history for telemetry/replay. */
  history: PhaseTransitionRecord[];
}

export interface PhaseTransitionRecord {
  fromPhaseId: string;
  toPhaseId: string;
  turn: number;
  trigger: PhaseTriggerKind;
  /** Snapshot of evaluation context. */
  hpBp?: number;
  killCount?: number;
}

export function createBossPhaseState(bossId: string, phases: readonly BossPhase[]): BossPhaseState {
  if (phases.length === 0) {
    throw new Error(`[BossPhaseMachine] boss '${bossId}' has no phases`);
  }
  const first = phases[0]!;
  return {
    bossId,
    currentPhaseId: first.phaseId,
    phaseIndex: 0,
    enteredAtTurn: 0,
    flags: new Map(),
    history: [],
  };
}

// ─────────────────────────────────────────────────────────
// Tick evaluator
// ─────────────────────────────────────────────────────────

export interface PhaseTickInput {
  currentTurn: number;
  encounterStartTurn: number;
  bossHp: number;
  bossMaxHp: number;
  killCount: number;
}

export interface PhaseTickResult {
  transitioned: boolean;
  newPhaseId: string;
  fromPhaseId: string;
  trigger?: PhaseTriggerKind;
}

/**
 * Evaluate all phase triggers. Returns transition info.
 *
 * Pure: caller mutates state only on `transitioned === true`.
 * Deterministic: same inputs → same result.
 *
 * Forward-only: cannot go back to earlier phase except via `resetPhase()`.
 */
export function evaluatePhaseTransition(
  state: BossPhaseState,
  phases: readonly BossPhase[],
  input: PhaseTickInput,
): PhaseTickResult {
  const fromId = state.currentPhaseId;
  // Scan phases ahead of current index for next eligible trigger
  for (let i = state.phaseIndex + 1; i < phases.length; i++) {
    const next = phases[i]!;
    if (!next.enterTrigger) continue;
    if (triggerMatches(next.enterTrigger, state, input)) {
      return {
        transitioned: true,
        newPhaseId: next.phaseId,
        fromPhaseId: fromId,
        trigger: next.enterTrigger.kind,
      };
    }
  }
  return { transitioned: false, newPhaseId: fromId, fromPhaseId: fromId };
}

function triggerMatches(
  trigger: PhaseTrigger,
  state: BossPhaseState,
  input: PhaseTickInput,
): boolean {
  switch (trigger.kind) {
    case 'hp_threshold_bp': {
      if (input.bossMaxHp <= 0) return false;
      const hpBp = Math.floor((input.bossHp * 10000) / input.bossMaxHp);
      return hpBp <= trigger.threshold;
    }
    case 'turn_threshold':
      return input.currentTurn - input.encounterStartTurn >= trigger.threshold;
    case 'kill_count_threshold':
      return input.killCount >= trigger.threshold;
    case 'mechanic_flag': {
      if (!trigger.flagName) return false;
      return state.flags.get(trigger.flagName) === true;
    }
    case 'enrage_timer':
      return input.currentTurn - input.encounterStartTurn >= trigger.threshold;
  }
}

/**
 * Commit the transition — caller invokes after `evaluatePhaseTransition` returns
 * `transitioned: true`. Records history + advances phaseIndex.
 */
export function applyPhaseTransition(
  state: BossPhaseState,
  phases: readonly BossPhase[],
  result: PhaseTickResult,
  input: PhaseTickInput,
): void {
  if (!result.transitioned || !result.trigger) return;
  const newIdx = phases.findIndex((p) => p.phaseId === result.newPhaseId);
  if (newIdx < 0 || newIdx <= state.phaseIndex) return;     // monotonic forward only
  state.currentPhaseId = result.newPhaseId;
  state.phaseIndex = newIdx;
  state.enteredAtTurn = input.currentTurn;
  const hpBp = input.bossMaxHp > 0 ? Math.floor((input.bossHp * 10000) / input.bossMaxHp) : 0;
  state.history.push({
    fromPhaseId: result.fromPhaseId,
    toPhaseId: result.newPhaseId,
    turn: input.currentTurn,
    trigger: result.trigger,
    hpBp,
    killCount: input.killCount,
  });
}

/** Set / clear named flag (mechanic_scheduler dispatches). */
export function setBossFlag(state: BossPhaseState, flagName: string, value: boolean): void {
  state.flags.set(flagName, value);
}

/** Reset to initial phase — used by wipe / encounter reset. */
export function resetBossPhase(state: BossPhaseState, phases: readonly BossPhase[]): void {
  const first = phases[0]!;
  state.currentPhaseId = first.phaseId;
  state.phaseIndex = 0;
  state.enteredAtTurn = 0;
  state.flags.clear();
  // history preserved — replay can read prior runs
}

export function snapshotBossPhase(state: BossPhaseState): BossPhaseState {
  return {
    bossId: state.bossId,
    currentPhaseId: state.currentPhaseId,
    phaseIndex: state.phaseIndex,
    enteredAtTurn: state.enteredAtTurn,
    flags: new Map(state.flags),
    history: state.history.map((h) => ({ ...h })),
  };
}

export function restoreBossPhase(snap: BossPhaseState): BossPhaseState {
  return snapshotBossPhase(snap);
}
