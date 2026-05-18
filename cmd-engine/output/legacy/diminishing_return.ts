/**
 * DIMINISHING RETURN — generic framework (Phase 2 spec).
 *
 * Per-target per-DR-group level tracking. Configurable levels via
 * `data/status_constants.json` (DR_LEVELS_<group>_BP).
 *
 * Example hard_cc DR:
 *   first apply  → BP 10000 (full duration)
 *   second apply → BP 5000  (half duration)
 *   third apply  → BP 0     (immune)
 *   reset after DR_RESET_TURNS_HARD_CC turns no apply
 *
 * Pure helper — caller (applyEffect) tracks DRTrackerEntry per (targetId, drGroup).
 */
import type { DRGroup, DRTrackerEntry } from './status_types.js';
import { StatusConstants } from './status_constants.js';

/** Lookup level array per group. */
function levelsFor(group: DRGroup): readonly number[] {
  switch (group) {
    case 'hard_cc': return StatusConstants.DR_LEVELS_HARD_CC_BP;
    case 'soft_cc': return StatusConstants.DR_LEVELS_SOFT_CC_BP;
    case 'dot':     return StatusConstants.DR_LEVELS_DOT_BP;
    case 'hot':     return StatusConstants.DR_LEVELS_HOT_BP;
    case 'none':    return [10000];
  }
}

function resetTurnsFor(group: DRGroup): number {
  switch (group) {
    case 'hard_cc': return StatusConstants.DR_RESET_TURNS_HARD_CC;
    case 'soft_cc': return StatusConstants.DR_RESET_TURNS_SOFT_CC;
    case 'dot':     return StatusConstants.DR_RESET_TURNS_DOT;
    case 'hot':     return StatusConstants.DR_RESET_TURNS_HOT;
    case 'none':    return 0;
  }
}

/**
 * Compute current DR multiplier (BP) for a (group, currentTurn, tracker?).
 * If tracker undefined → first apply, return level 0.
 * If tracker.lastTriggerTurn + resetTurns < currentTurn → reset to level 0.
 *
 * @returns multiplier BP. 0 = immune (block apply).
 */
export function getDRMultiplierBP(
  group: DRGroup,
  currentTurn: number,
  tracker: DRTrackerEntry | undefined,
): number {
  const levels = levelsFor(group);
  if (!tracker) {
    return levels[0] ?? 10000;
  }
  const resetTurns = resetTurnsFor(group);
  const elapsed = currentTurn - tracker.lastTriggerTurn;
  if (resetTurns > 0 && elapsed > resetTurns) {
    // Reset window passed — start over
    return levels[0] ?? 10000;
  }
  // Use current level (capped at last)
  const idx = Math.min(tracker.level, levels.length - 1);
  return levels[idx] ?? 0;
}

/**
 * Advance tracker after DR-affected apply. Pure — returns new tracker (immutable input).
 */
export function advanceDRTracker(
  group: DRGroup,
  currentTurn: number,
  tracker: DRTrackerEntry | undefined,
): DRTrackerEntry {
  const levels = levelsFor(group);
  const resetTurns = resetTurnsFor(group);
  if (!tracker) {
    return { group, level: 1, lastTriggerTurn: currentTurn };
  }
  const elapsed = currentTurn - tracker.lastTriggerTurn;
  const reset = resetTurns > 0 && elapsed > resetTurns;
  const newLevel = reset ? 1 : Math.min(tracker.level + 1, levels.length);
  return { group, level: newLevel, lastTriggerTurn: currentTurn };
}
