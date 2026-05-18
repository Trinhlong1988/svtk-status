/**
 * Shadow ban — flag a player as suspected bot without revealing the ban.
 *
 * Shadow-banned players:
 *   - Continue to play normally (no error, no kick).
 *   - Cannot interact with non-shadow-banned players (matchmaking isolates
 *     them with other flagged accounts).
 *   - Trade / chat / mail go nowhere (silently dropped on outbound).
 *
 * Coordinates with CMD1's anti-cheat ban_pipeline: CMD1 detects combat
 * anomalies → flags player via `shadowBan()`. CMD2's anti-bot modules
 * (behavioral_audit) also flag. CMD4 admin dashboard reviews flags.
 *
 * Redis-backed flag store with optional reason metadata. Persistent unless
 * explicitly unbanned by admin.
 */
import type { RedisLike } from './redis_like.js';

export type ShadowBanSource = 'anti_cheat' | 'behavioral_audit' | 'admin_manual';

export interface ShadowBanFlag {
  player_id: string;
  source: ShadowBanSource;
  reason: string;
  flagged_at_ms: number;
}

const FLAG_PREFIX = 'sb:';

function buildKey(playerId: string): string {
  return `${FLAG_PREFIX}${playerId}`;
}

/** Mark a player as shadow-banned. Idempotent (overwrites existing flag). */
export async function shadowBan(
  redis: RedisLike,
  flag: Omit<ShadowBanFlag, 'flagged_at_ms'>,
  nowMs: number,
): Promise<ShadowBanFlag> {
  if (!flag.player_id) throw new Error('shadowBan: player_id required');
  const stored: ShadowBanFlag = { ...flag, flagged_at_ms: nowMs };
  await redis.set(buildKey(flag.player_id), JSON.stringify(stored));
  return stored;
}

/** Check if player is shadow-banned. Returns flag detail or null. */
export async function isShadowBanned(
  redis: RedisLike,
  playerId: string,
): Promise<ShadowBanFlag | null> {
  const raw = await redis.get(buildKey(playerId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ShadowBanFlag;
  } catch {
    return null;
  }
}

/** Lift shadow ban (admin action only). */
export async function unshadowBan(redis: RedisLike, playerId: string): Promise<boolean> {
  const removed = await redis.del(buildKey(playerId));
  return removed > 0;
}

/**
 * Pair test: are two players visible to each other? Both shadow-banned →
 * yes (isolated cohort). Either non-banned → no. Used by matchmaker +
 * chat router + trade target picker.
 */
export async function arePeersVisible(
  redis: RedisLike,
  playerA: string,
  playerB: string,
): Promise<boolean> {
  const [a, b] = await Promise.all([
    isShadowBanned(redis, playerA),
    isShadowBanned(redis, playerB),
  ]);
  // Both banned → visible to each other only.
  // Both clean → visible normally.
  // Mixed → not visible (banned sees themselves alone or in cohort).
  if (a && b) return true;
  if (!a && !b) return true;
  return false;
}
