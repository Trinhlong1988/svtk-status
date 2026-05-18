/**
 * TURN PLAYBACK — replay-safe action playback (FIX PHASE 3 § V).
 *
 * After server resolves all locked actions, playback phase emits ordered
 * action results to client (animation cadence aligned with TURN_DELAY_MS).
 *
 * Playback is REPLAY-SAFE: deterministic order from turn_order_resolver,
 * resolved actions from action_lock seal(), animation gap = TURN_DELAY_MS.
 *
 * Pure data — caller (presentation layer) consumes PlaybackEntry[] for animation.
 */
import type { LockedAction } from './action_lock.js';
import type { TurnOrderEntry } from './turn_order_resolver.js';
import { SkillConstants } from './skill_constants.js';

export type PlaybackEntryKind =
  | 'action_resolved'
  | 'action_skipped_cc'
  | 'action_skipped_dead'
  | 'action_missing_no_lock';

export interface PlaybackEntry {
  /** Ordinal position in turn (0-based). */
  ordinal: number;
  /** Acting entity id. */
  actorEntityId: string;
  /** Kind of playback. */
  kind: PlaybackEntryKind;
  /** Locked action (undefined if action_missing_no_lock or skip). */
  action?: LockedAction;
  /** Reason (when skipped). */
  skipReason?: 'stunned' | 'frozen' | 'dead' | 'no_action_locked';
  /** Animation start time millisecond from turn start (for client cadence). */
  animationStartMs: number;
  /** Animation duration ms (typical TURN_DELAY_MS). */
  animationDurationMs: number;
}

/**
 * Build playback list from turn order + locks. Deterministic.
 *
 * Rules:
 *   - For each TurnOrderEntry: lookup lock by entityId
 *   - If skipReason set (stun/frozen/dead) → emit skipped
 *   - If no lock found → emit action_missing_no_lock (server records as AFK pass)
 *   - Else → emit action_resolved with locked action
 *   - animationStartMs = ordinal × TURN_DELAY_MS (cadence)
 */
export function buildTurnPlayback(
  order: readonly TurnOrderEntry[],
  locks: ReadonlyMap<string, LockedAction>,
): PlaybackEntry[] {
  const out: PlaybackEntry[] = [];
  for (let ordinal = 0; ordinal < order.length; ordinal++) {
    const entry = order[ordinal];
    if (!entry) continue;
    const baseStart = ordinal * SkillConstants.TURN_DELAY_MS;

    if (entry.skipReason === 'dead') {
      out.push({
        ordinal,
        actorEntityId: entry.entityId,
        kind: 'action_skipped_dead',
        skipReason: 'dead',
        animationStartMs: baseStart,
        animationDurationMs: 0,    // dead = no animation
      });
      continue;
    }
    if (entry.skipReason === 'stunned' || entry.skipReason === 'frozen') {
      out.push({
        ordinal,
        actorEntityId: entry.entityId,
        kind: 'action_skipped_cc',
        skipReason: entry.skipReason,
        animationStartMs: baseStart,
        animationDurationMs: SkillConstants.TURN_DELAY_MS,    // CC visual
      });
      continue;
    }
    const lock = locks.get(entry.entityId);
    if (!lock) {
      out.push({
        ordinal,
        actorEntityId: entry.entityId,
        kind: 'action_missing_no_lock',
        skipReason: 'no_action_locked',
        animationStartMs: baseStart,
        animationDurationMs: SkillConstants.TURN_DELAY_MS,
      });
      continue;
    }
    out.push({
      ordinal,
      actorEntityId: entry.entityId,
      kind: 'action_resolved',
      action: lock,
      animationStartMs: baseStart,
      animationDurationMs: SkillConstants.TURN_DELAY_MS,
    });
  }
  return out;
}

/** Total turn duration ms for client UI countdown. */
export function totalTurnDurationMs(playback: readonly PlaybackEntry[]): number {
  if (playback.length === 0) return 0;
  const last = playback[playback.length - 1];
  if (!last) return 0;
  return last.animationStartMs + last.animationDurationMs;
}

/**
 * Auto-pass rule — if entity has no lock for AFK_TIMEOUT_TURNS consecutive turns,
 * mark as AFK + auto-skip per turn. Caller maintains per-entity `consecutiveAFK` counter.
 */
export function shouldAutoPass(consecutiveAfkTurns: number): boolean {
  return consecutiveAfkTurns >= SkillConstants.AFK_TIMEOUT_TURNS;
}
