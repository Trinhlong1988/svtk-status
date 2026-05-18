/**
 * BOSS AI RUNTIME — top-level orchestrator (Phase 6).
 *
 * Wires together:
 *   - BossScript (data — boss_script_registry)
 *   - BossPhaseState (boss_phase_machine — phase transition)
 *   - MechanicSchedulerState (mechanic_scheduler — telegraph queue)
 *   - BossTargetPolicy (boss_target_hook — target selection)
 *   - ThreatTable (threat_resolver — caller-provided)
 *
 * 70/20/10 BEHAVIOR POLICY (data-driven via BossScript.behaviorWeights):
 *   - 70% (default): use `highest_threat` (resolver default — no override)
 *   - 20% (default): use scripted target — pick from active phase's rotation
 *   - 10% (default): random eligible (rng_ai_threat substream)
 *
 * STRICT: NO `if(bossId === ...)` chains. All boss behavior data-driven via registry.
 *
 * Deterministic: every decision is pure function of input + RNG substream.
 * Same encounter seed → same boss decisions across replay.
 */
import type { BossScript } from './boss_script_registry.js';
import { activePhaseOf } from './boss_script_registry.js';
import type { BossPhaseState, PhaseTickInput } from './boss_phase_machine.js';
import {
  evaluatePhaseTransition,
  applyPhaseTransition,
} from './boss_phase_machine.js';
import type { MechanicSchedulerState, PendingMechanic, ScheduleTickInput } from '../../../cmd-engine/output/legacy/mechanic_scheduler.js';
import { tickScheduler, drainReadyMechanics, clearPending } from '../../../cmd-engine/output/legacy/mechanic_scheduler.js';
import type { ThreatEntryV2 } from '../../../cmd-engine/output/legacy/threat_types.js';
import {
  applyBossTargetPolicy,
  type BossTargetPolicy,
  type BossTargetPolicyKind,
  type PolicyOutcome,
} from './boss_target_hook.js';
import type { RNG } from '../../../cmd-engine/output/legacy/rng.js';

// ─────────────────────────────────────────────────────────
// Decision outcome
// ─────────────────────────────────────────────────────────

export type BehaviorBranch = 'highest_threat' | 'scripted_mechanic' | 'random_eligible';

export interface BossDecision {
  bossId: string;
  currentPhaseId: string;
  /** Which behavior branch the 70/20/10 roll selected. */
  branch: BehaviorBranch;
  /** Target id (undefined → resolver fallback to highest_threat). */
  targetId?: string;
  /** Skill to cast this turn (from active phase's rotation). */
  skillId?: string;
  /** Mechanics resolving this turn (drained from scheduler). */
  resolvedMechanics: readonly PendingMechanic[];
  /** Mechanics newly scheduled this turn. */
  scheduledMechanics: readonly PendingMechanic[];
  /** Phase transition info (if happened this tick). */
  phaseTransitioned: boolean;
  /** Telemetry: which boss_target_hook policy fired. */
  policyVia?: BossTargetPolicyKind;
}

// ─────────────────────────────────────────────────────────
// Runtime context (caller-injected per tick)
// ─────────────────────────────────────────────────────────

export interface BossTickInput {
  currentTurn: number;
  encounterStartTurn: number;
  bossHp: number;
  bossMaxHp: number;
  /** Boss kill count this encounter (for kill_count_threshold trigger). */
  killCount: number;
  /** Current threat table for boss. */
  threatTable: Map<string, ThreatEntryV2>;
  /** Eligibility predicate (alive + targetable). */
  isEligible: (id: string) => boolean;
  /** Optional hp lookup (for mechanic_lowest_hp). */
  hpOf?: (id: string) => number;
  /** Optional distance lookup (for mechanic_furthest). */
  distanceOf?: (id: string) => number;
  /** Optional tag filter (for healer_punish). */
  tagFilter?: (id: string) => boolean;
  /** RNG: rng_ai substream — branch selection + mechanic chance triggers. */
  rngAi: RNG;
  /** RNG: rng_ai_threat substream — target selection (weighted/random). */
  rngAiThreat: RNG;
}

// ─────────────────────────────────────────────────────────
// Tick
// ─────────────────────────────────────────────────────────

/**
 * Tick boss AI for current turn. Pure function of state + input.
 *
 * Order of operations (deterministic):
 *   1. Drain resolved mechanics (from previous telegraphs)
 *   2. Evaluate phase transition (may fire `phase_enter` mechanics next)
 *   3. Tick scheduler — fire new mechanics
 *   4. Roll 70/20/10 branch
 *   5. Apply branch to pick target + skill
 *
 * Caller is responsible for actually executing the skill cast + mechanic effects.
 */
export function tickBossAi(
  script: BossScript,
  phaseState: BossPhaseState,
  scheduler: MechanicSchedulerState,
  input: BossTickInput,
): BossDecision {
  // ─── 1. Drain ready mechanics
  const resolved = drainReadyMechanics(scheduler, input.currentTurn);

  // ─── 2. Phase transition
  const phaseInput: PhaseTickInput = {
    currentTurn: input.currentTurn,
    encounterStartTurn: input.encounterStartTurn,
    bossHp: input.bossHp,
    bossMaxHp: input.bossMaxHp,
    killCount: input.killCount,
  };
  const phaseResult = evaluatePhaseTransition(phaseState, script.phases, phaseInput);
  let transitionedThisTick = false;
  if (phaseResult.transitioned) {
    applyPhaseTransition(phaseState, script.phases, phaseResult, phaseInput);
    transitionedThisTick = true;
  }

  // Hard enrage — force last phase + enrage flag
  if (script.hardEnrageTurns !== undefined) {
    const elapsed = input.currentTurn - input.encounterStartTurn;
    if (elapsed >= script.hardEnrageTurns && phaseState.phaseIndex < script.phases.length - 1) {
      const lastPhase = script.phases[script.phases.length - 1]!;
      phaseState.currentPhaseId = lastPhase.phaseId;
      phaseState.phaseIndex = script.phases.length - 1;
      phaseState.enteredAtTurn = input.currentTurn;
      phaseState.history.push({
        fromPhaseId: phaseResult.fromPhaseId,
        toPhaseId: lastPhase.phaseId,
        turn: input.currentTurn,
        trigger: 'enrage_timer',
        hpBp: input.bossMaxHp > 0 ? Math.floor((input.bossHp * 10000) / input.bossMaxHp) : 0,
        killCount: input.killCount,
      });
      transitionedThisTick = true;
    }
  }

  // ─── 3. Tick scheduler
  const schedInput: ScheduleTickInput = {
    currentTurn: input.currentTurn,
    encounterStartTurn: input.encounterStartTurn,
    phaseEnteredTurn: phaseState.enteredAtTurn,
    phaseEnteredThisTick: transitionedThisTick,
    bossHp: input.bossHp,
    bossMaxHp: input.bossMaxHp,
    rngAi: input.rngAi,
  };
  const scheduled = tickScheduler(scheduler, script, phaseState, schedInput);

  // ─── 4. 70/20/10 branch roll
  const branch = rollBehaviorBranch(script, input.rngAi);

  // ─── 5. Target + skill selection
  const phase = activePhaseOf(script, phaseState.currentPhaseId);
  const skillId = pickRotationSkill(phase?.rotation ?? [], input.currentTurn, phaseState.enteredAtTurn);

  const decision: BossDecision = {
    bossId: script.bossId,
    currentPhaseId: phaseState.currentPhaseId,
    branch,
    skillId,
    resolvedMechanics: resolved,
    scheduledMechanics: scheduled,
    phaseTransitioned: transitionedThisTick,
  };

  const policyKind = resolvePolicyKind(branch, phase?.targetPolicyKind);
  const policy: BossTargetPolicy = {
    kind: policyKind,
    hpOf: input.hpOf,
    distanceOf: input.distanceOf,
    tagFilter: input.tagFilter,
    rng: input.rngAiThreat,
  };
  const outcome: PolicyOutcome = applyBossTargetPolicy(policy, input.threatTable, input.isEligible);
  decision.targetId = outcome.targetId;
  decision.policyVia = outcome.via;

  return decision;
}

// ─────────────────────────────────────────────────────────
// Behavior branch — 70/20/10 roll
// ─────────────────────────────────────────────────────────

function rollBehaviorBranch(script: BossScript, rng: RNG): BehaviorBranch {
  const w = script.behaviorWeights;
  const roll = Math.floor(rng() * 10000);
  if (roll < w.highestThreatBP) return 'highest_threat';
  if (roll < w.highestThreatBP + w.scriptedMechanicBP) return 'scripted_mechanic';
  return 'random_eligible';
}

function resolvePolicyKind(
  branch: BehaviorBranch,
  phaseOverride: string | undefined,
): BossTargetPolicyKind {
  if (branch === 'highest_threat') return 'highest_threat';
  if (branch === 'random_eligible') return 'random_weight';
  // scripted_mechanic — use phase override, else fallback to weighted_threat
  if (phaseOverride && isValidPolicyKind(phaseOverride)) return phaseOverride as BossTargetPolicyKind;
  return 'weighted_threat';
}

function isValidPolicyKind(s: string): boolean {
  return (
    s === 'highest_threat' || s === 'weighted_threat' || s === 'scripted_target' ||
    s === 'mechanic_lowest_hp' || s === 'mechanic_furthest' || s === 'bait_target' ||
    s === 'healer_punish' || s === 'random_weight' || s === 'anti_exploit_only'
  );
}

// ─────────────────────────────────────────────────────────
// Rotation — deterministic cycle
// ─────────────────────────────────────────────────────────

function pickRotationSkill(
  rotation: readonly string[],
  currentTurn: number,
  phaseEnteredTurn: number,
): string | undefined {
  if (rotation.length === 0) return undefined;
  const elapsed = currentTurn - phaseEnteredTurn;
  const idx = elapsed % rotation.length;
  const safeIdx = Math.max(0, Math.min(idx, rotation.length - 1));
  return rotation[safeIdx];
}

// ─────────────────────────────────────────────────────────
// Reset (wipe / encounter restart)
// ─────────────────────────────────────────────────────────

export function resetBossAi(
  phaseState: BossPhaseState,
  scheduler: MechanicSchedulerState,
  script: BossScript,
): void {
  const first = script.phases[0]!;
  phaseState.currentPhaseId = first.phaseId;
  phaseState.phaseIndex = 0;
  phaseState.enteredAtTurn = 0;
  phaseState.flags.clear();
  clearPending(scheduler);
  scheduler.firedOneShot.clear();
  scheduler.firedHpThreshold.clear();
}
