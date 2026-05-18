/**
 * IP + user rate limiter — Redis-backed counter with TTL window.
 *
 * Limits (per Phase 13 brief mục 3.1):
 *   100 req/min per IP
 *   1000 req/min per user
 *
 * Returns RateLimitDecision { allowed, retry_after_sec }. Caller emits 429
 * with Retry-After header when allowed=false.
 *
 * Algorithm: fixed window counter via INCR + EXPIRE on first hit. Cheap +
 * Redis-cluster-safe. Acceptable burst at window boundary; switch to sliding
 * window only if anti-cheat data shows boundary abuse.
 */
import type { RedisLike } from './redis_like.js';

export interface RateLimitConfig {
  /** Max requests per window for an IP key. */
  ip_max_per_min: number;
  /** Max requests per window for a user key. */
  user_max_per_min: number;
  /** Window length in seconds (default 60). */
  window_sec: number;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  ip_max_per_min: 100,
  user_max_per_min: 1000,
  window_sec: 60,
};

export interface RateLimitDecision {
  allowed: boolean;
  /** Current count after this hit. */
  count: number;
  /** Limit applied. */
  limit: number;
  /** Seconds until window expires; 0 if denied during current window. */
  retry_after_sec: number;
}

export type RateLimitKind = 'ip' | 'user';

/** Build a Redis key with prefix + kind + identifier. */
function buildKey(kind: RateLimitKind, identifier: string, windowSec: number): string {
  return `rl:${kind}:${windowSec}:${identifier}`;
}

/**
 * Record one hit + return decision. Caller invokes once per request.
 *
 * Atomic guarantees: INCR is atomic; EXPIRE only set on first hit (count=1)
 * so window doesn't slide forward on each request.
 */
export async function rateLimitHit(
  redis: RedisLike,
  kind: RateLimitKind,
  identifier: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
): Promise<RateLimitDecision> {
  if (!identifier) throw new Error('rateLimitHit: identifier required');
  const limit = kind === 'ip' ? config.ip_max_per_min : config.user_max_per_min;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`rateLimitHit: invalid limit ${limit} for kind ${kind}`);
  }
  const key = buildKey(kind, identifier, config.window_sec);
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, config.window_sec);
  }
  const allowed = count <= limit;
  let retry_after_sec = 0;
  if (!allowed) {
    const ttl = await redis.ttl(key);
    retry_after_sec = ttl > 0 ? ttl : config.window_sec;
  }
  return { allowed, count, limit, retry_after_sec };
}

/** Read current count without incrementing (status probe). */
export async function rateLimitPeek(
  redis: RedisLike,
  kind: RateLimitKind,
  identifier: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
): Promise<{ count: number; limit: number; ttl_sec: number }> {
  const key = buildKey(kind, identifier, config.window_sec);
  const [raw, ttl] = await Promise.all([redis.get(key), redis.ttl(key)]);
  return {
    count: raw === null ? 0 : Number(raw),
    limit: kind === 'ip' ? config.ip_max_per_min : config.user_max_per_min,
    ttl_sec: ttl,
  };
}

/** Reset counter for an identifier (admin override). */
export async function rateLimitReset(
  redis: RedisLike,
  kind: RateLimitKind,
  identifier: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
): Promise<void> {
  await redis.del(buildKey(kind, identifier, config.window_sec));
}
