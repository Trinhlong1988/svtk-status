/**
 * Behavioral audit — score player action cadence to flag bots.
 *
 * Bots emit actions with very low inter-action variance (e.g. stddev < 50ms).
 * Humans naturally jitter (200-2000ms spread). Per Phase 13 brief mục 3.4:
 *   stddev < 50ms → 100% bot likelihood.
 *
 * Stateful: keeps a rolling buffer of last N action timestamps per player,
 * computes mean + stddev on each new sample. Old samples evicted when buffer
 * full or older than MAX_AGE_MS (idle player → fresh start).
 *
 * Stored in Redis as compact CSV "ts1,ts2,...,tsN" with TTL = window. This
 * scales horizontally; no per-process state.
 *
 * ⚠ Concurrency note: recordSample is GET-then-SET, not atomic. Under heavy
 * concurrent writes for the same player_id, late samples can clobber earlier
 * ones (last write wins). Acceptable for bot detection — verdict needs ~10
 * samples to stabilize and occasional drops do not move stddev meaningfully.
 * For strict atomicity, migrate to a Redis Lua script or `ZADD` sorted set
 * in production hardening (defer).
 */
import type { RedisLike } from './redis_like.js';

export interface BehavioralAuditConfig {
  /** Max samples retained per player. */
  buffer_size: number;
  /** Bot threshold — stddev below this triggers full likelihood. */
  bot_stddev_threshold_ms: number;
  /** Min samples before scoring (else score = 0, undetermined). */
  min_samples: number;
  /** Redis TTL for buffer in seconds. Idle player → buffer expires. */
  ttl_sec: number;
}

export const DEFAULT_BEHAVIORAL_CONFIG: BehavioralAuditConfig = {
  buffer_size: 30,
  bot_stddev_threshold_ms: 50,
  min_samples: 10,
  ttl_sec: 60 * 60, // 1h
};

export interface BehavioralSample {
  player_id: string;
  /** Action category (cast / move / loot / trade / chat). */
  action: string;
  /** Wall-clock ms of action (server time, not client). */
  timestamp_ms: number;
}

export interface BehavioralScore {
  /**
   * Discrete bot classification — 0 = human-like, 1 = bot-like (stddev below
   * threshold AND sample_count ≥ min_samples). Integer per R31 (NO FLOAT in
   * Layer 3 hot-path): the verdict is binary, NOT a continuous probability.
   * Callers that need a probability score should layer ML on top of this gate.
   */
  bot_likelihood: 0 | 1;
  sample_count: number;
  mean_interval_ms: number;
  stddev_interval_ms: number;
  /** True only when bot_likelihood === 1. */
  flagged_bot: boolean;
}

function buildKey(playerId: string): string {
  return `bh:${playerId}`;
}

function parseBuffer(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}

function computeIntervalStats(timestamps: number[]): { mean: number; stddev: number } {
  if (timestamps.length < 2) return { mean: 0, stddev: 0 };
  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const prev = timestamps[i - 1];
    const cur = timestamps[i];
    if (prev !== undefined && cur !== undefined) intervals.push(cur - prev);
  }
  const sum = intervals.reduce((a, b) => a + b, 0);
  const mean = sum / intervals.length;
  const sqDiff = intervals.reduce((acc, x) => acc + (x - mean) * (x - mean), 0);
  const stddev = Math.sqrt(sqDiff / intervals.length);
  return { mean, stddev };
}

/**
 * Record a sample + return updated score.
 *
 * Score = 1 if stddev_interval < threshold AND sample_count ≥ min_samples.
 * Caller decides what to do with flagged_bot (shadow_ban / captcha / etc.).
 */
export async function recordSample(
  redis: RedisLike,
  sample: BehavioralSample,
  config: BehavioralAuditConfig = DEFAULT_BEHAVIORAL_CONFIG,
): Promise<BehavioralScore> {
  if (!Number.isFinite(sample.timestamp_ms)) {
    throw new Error('recordSample: timestamp_ms must be finite');
  }
  const key = buildKey(sample.player_id);
  const existing = parseBuffer(await redis.get(key));
  existing.push(sample.timestamp_ms);
  // Sort ASC: concurrent writers may push out-of-order timestamps; interval
  // computation requires monotonic series (else stddev underestimates and
  // bot detection misfires). Cost: O(n log n) on small fixed buffer (~30).
  existing.sort((a, b) => a - b);
  // Evict oldest after sort so eviction removes smallest timestamps (LRU semantics).
  while (existing.length > config.buffer_size) existing.shift();
  await redis.set(key, existing.join(','), 'EX', config.ttl_sec);

  const { mean, stddev } = computeIntervalStats(existing);
  const enoughSamples = existing.length >= config.min_samples;
  const looksLikeBot = stddev < config.bot_stddev_threshold_ms;
  const bot_likelihood: 0 | 1 = enoughSamples && looksLikeBot ? 1 : 0;

  return {
    bot_likelihood,
    sample_count: existing.length,
    mean_interval_ms: mean,
    stddev_interval_ms: stddev,
    flagged_bot: bot_likelihood === 1,
  };
}

/** Peek at current score without recording new sample. */
export async function peekScore(
  redis: RedisLike,
  playerId: string,
  config: BehavioralAuditConfig = DEFAULT_BEHAVIORAL_CONFIG,
): Promise<BehavioralScore> {
  const key = buildKey(playerId);
  const buffer = parseBuffer(await redis.get(key));
  const { mean, stddev } = computeIntervalStats(buffer);
  const enoughSamples = buffer.length >= config.min_samples;
  const looksLikeBot = stddev < config.bot_stddev_threshold_ms;
  const bot_likelihood: 0 | 1 = enoughSamples && looksLikeBot ? 1 : 0;
  return {
    bot_likelihood,
    sample_count: buffer.length,
    mean_interval_ms: mean,
    stddev_interval_ms: stddev,
    flagged_bot: bot_likelihood === 1,
  };
}

/** Clear buffer (admin override / false-positive remediation). */
export async function clearSamples(redis: RedisLike, playerId: string): Promise<void> {
  await redis.del(buildKey(playerId));
}
