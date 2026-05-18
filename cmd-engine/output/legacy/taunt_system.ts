/**
 * TAUNT SYSTEM — Phase 4 § VII.
 *
 * Forced target with:
 *   - duration (turn-based)
 *   - DR per-target (TAUNT_DR_LEVELS_BP, reset TAUNT_DR_RESET_TURNS)
 *   - immunity tag (boss may have anti-taunt)
 *   - boss/elite resist BP roll (uses rng_ai_threat substream)
 *
 * Pure helper functions. Caller (ThreatEngine) maintains TauntStateEntry per boss.
 */
import type { RNG } from './rng.js';
import type { TauntStateEntry } from './threat_types.js';
import { ThreatConstants } from './threat_constants.js';

export interface TauntApplyInput {
  /** Source caster (taunt skill caster). */
  sourceId: string;
  /** Target boss/NPC being taunted. */
  targetId: string;
  /** Requested duration (turn). Capped MAX_TAUNT_DURATION_TURNS. */
  requestedDuration: number;
  /** Boss flag — applies BOSS_TAUNT_RESIST_BP. */
  isBossTarget?: boolean;
  /** Elite flag — applies ELITE_TAUNT_RESIST_BP. */
  isEliteTarget?: boolean;
  /** Immunity flag — fully immune. */
  immune?: boolean;
}

export type TauntApplyOutcome =
  | 'applied'
  | 'refreshed'
  | 'resisted'
  | 'dr_blocked'
  | 'immune'
  | 'invalid_duration';

export interface TauntApplyResult {
  outcome: TauntApplyOutcome;
  effectiveDuration: number;
  drLevelAfter: number;
  state?: TauntStateEntry;
}

/**
 * Apply taunt to target. Returns result + mutated state (caller stores).
 *
 * Order of checks:
 *   1. duration validate (1..MAX_TAUNT_DURATION_TURNS)
 *   2. immune → return immune
 *   3. DR check (current level) → if BP=0, block
 *   4. resist roll (boss/elite) — uses rng_ai_threat substream
 *   5. apply: scale duration by DR BP, advance DR level, set forcedUntil
 *
 * @param current     existing TauntStateEntry on target (or undefined)
 * @param input       apply request
 * @param currentTurn current turn number
 * @param rng         RNG callable (caller passes ctx.rngStream.sub('rng_ai_threat'))
 */
export function applyTaunt(
  current: TauntStateEntry | undefined,
  input: TauntApplyInput,
  currentTurn: number,
  rng: RNG,
): TauntApplyResult {
  // Step 1 — duration validate
  if (input.requestedDuration <= 0 || input.requestedDuration > ThreatConstants.MAX_TAUNT_DURATION_TURNS) {
    return { outcome: 'invalid_duration', effectiveDuration: 0, drLevelAfter: current?.drLevel ?? 0 };
  }

  // Step 2 — immunity
  if (input.immune) {
    return { outcome: 'immune', effectiveDuration: 0, drLevelAfter: current?.drLevel ?? 0 };
  }

  // Step 3 — DR
  const drLevels = ThreatConstants.TAUNT_DR_LEVELS_BP;
  const reset = ThreatConstants.TAUNT_DR_RESET_TURNS;
  const drLevel = current
    ? (currentTurn - current.drLastApplyTurn > reset ? 0 : current.drLevel)
    : 0;
  const drBP = drLevels[Math.min(drLevel, drLevels.length - 1)] ?? 10000;
  if (drBP === 0) {
    return { outcome: 'dr_blocked', effectiveDuration: 0, drLevelAfter: drLevel };
  }

  // Step 4 — resist roll (boss/elite)
  let resistBP = 0;
  if (input.isBossTarget) resistBP = ThreatConstants.BOSS_TAUNT_RESIST_BP;
  else if (input.isEliteTarget) resistBP = ThreatConstants.ELITE_TAUNT_RESIST_BP;
  if (resistBP > 0 && rng() * 10000 < resistBP) {
    return { outcome: 'resisted', effectiveDuration: 0, drLevelAfter: drLevel };
  }

  // Step 5 — apply (DR-scaled duration)
  const effDuration = Math.max(1, Math.floor((input.requestedDuration * drBP) / 10000));
  const newLevel = Math.min(drLevel + 1, drLevels.length);
  const state: TauntStateEntry = {
    targetId: input.targetId,
    forcedSourceId: input.sourceId,
    forcedUntilTurn: currentTurn + effDuration,
    drLevel: newLevel,
    drLastApplyTurn: currentTurn,
  };
  return {
    outcome: current ? 'refreshed' : 'applied',
    effectiveDuration: effDuration,
    drLevelAfter: newLevel,
    state,
  };
}

/** Check if taunt expired at currentTurn. Pure. */
export function isTauntExpired(state: TauntStateEntry, currentTurn: number): boolean {
  return currentTurn > state.forcedUntilTurn;
}

/** Forced target lookup — returns sourceId if taunt active, else null. */
export function forcedTarget(state: TauntStateEntry | undefined, currentTurn: number): string | null {
  if (!state) return null;
  if (isTauntExpired(state, currentTurn)) return null;
  return state.forcedSourceId;
}
