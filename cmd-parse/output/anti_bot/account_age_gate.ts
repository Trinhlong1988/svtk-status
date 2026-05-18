/**
 * Account age gate — block sensitive actions for accounts younger than
 * MIN_AGE_MS. Default 24h per Phase 13 brief mục 3.3.
 *
 * Blocked actions (configurable subset):
 *   - trade        (player-to-player gold/item)
 *   - send_mail    (in-game mail with attachment)
 *   - group_join   (large faction join — anti throwaway zerg)
 *
 * Auction-house, marketplace, recruit may extend list via blocked_actions.
 */
import type { Pool } from 'pg';
import { accountAgeMs } from '../../db/repositories/player_repository.js';

export const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000; // 24h

export const DEFAULT_BLOCKED_ACTIONS = [
  'trade',
  'send_mail',
  'group_join',
] as const;

export type BlockedAction = (typeof DEFAULT_BLOCKED_ACTIONS)[number] | string;

export interface AgeGateConfig {
  min_age_ms: number;
  blocked_actions: readonly string[];
}

export const DEFAULT_AGE_GATE_CONFIG: AgeGateConfig = {
  min_age_ms: DEFAULT_MIN_AGE_MS,
  blocked_actions: DEFAULT_BLOCKED_ACTIONS,
};

export interface AgeGateDecision {
  allowed: boolean;
  age_ms: number;
  required_ms: number;
  reason?: 'too_young' | 'unknown_player';
}

/**
 * Evaluate gate for a specific action. Returns allowed=true if action is not
 * in blocked_actions OR account is older than threshold.
 */
export async function checkAgeGate(
  pool: Pool,
  playerId: string,
  action: BlockedAction,
  nowMs: number,
  config: AgeGateConfig = DEFAULT_AGE_GATE_CONFIG,
): Promise<AgeGateDecision> {
  if (!config.blocked_actions.includes(action)) {
    return { allowed: true, age_ms: 0, required_ms: 0 };
  }
  const age = await accountAgeMs(pool, playerId, nowMs);
  // `-1` = sentinel for player not found (accountAgeMs contract).
  // age=0 (just created within same ms) is valid → falls into too_young branch.
  if (age < 0) {
    return {
      allowed: false,
      age_ms: 0,
      required_ms: config.min_age_ms,
      reason: 'unknown_player',
    };
  }
  if (age < config.min_age_ms) {
    return {
      allowed: false,
      age_ms: age,
      required_ms: config.min_age_ms,
      reason: 'too_young',
    };
  }
  return { allowed: true, age_ms: age, required_ms: config.min_age_ms };
}
