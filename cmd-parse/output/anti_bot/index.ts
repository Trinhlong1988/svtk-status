/**
 * Anti-bot façade — wire helper that bundles the 5 systems for endpoint
 * integration.
 *
 * Endpoint patterns (Phase 13 brief mục 3.6):
 *   - signup     → rate_limit(ip) + captcha
 *   - trade      → rate_limit(user) + account_age + behavioral + shadow_ban check
 *   - combat     → behavioral score update only
 *
 * Each helper returns AntiBotDecision. Caller stops the request if
 * decision.allowed=false, returning 429 / 403 / shadow-drop as appropriate.
 */
import type { Pool } from 'pg';
import type { RedisLike } from './redis_like.js';
import {
  rateLimitHit,
  type RateLimitConfig,
  type RateLimitKind,
  DEFAULT_RATE_LIMIT_CONFIG,
} from './ip_rate_limit.js';
import {
  verifyCaptcha,
  type CaptchaConfig,
  type FetchLike,
} from './captcha_gate.js';
import {
  checkAgeGate,
  type AgeGateConfig,
  type BlockedAction,
  DEFAULT_AGE_GATE_CONFIG,
} from './account_age_gate.js';
import {
  recordSample,
  type BehavioralAuditConfig,
  type BehavioralScore,
  DEFAULT_BEHAVIORAL_CONFIG,
} from './behavioral_audit.js';
import { isShadowBanned, type ShadowBanFlag } from './shadow_ban.js';

export interface AntiBotDecision {
  allowed: boolean;
  http_status: 200 | 403 | 429;
  reasons: string[];
  retry_after_sec?: number;
  shadow_ban?: ShadowBanFlag | null;
  behavioral_score?: BehavioralScore;
}

export interface SignupGateInput {
  ip: string;
  captcha_token: string;
}

export interface SignupGateDeps {
  redis: RedisLike;
  captcha_config: CaptchaConfig;
  rate_limit_config?: RateLimitConfig;
  fetch_impl?: FetchLike;
}

/** Signup gate: IP rate-limit + captcha verify. */
export async function checkSignupGate(
  input: SignupGateInput,
  deps: SignupGateDeps,
): Promise<AntiBotDecision> {
  const rl = await rateLimitHit(
    deps.redis,
    'ip',
    input.ip,
    deps.rate_limit_config ?? DEFAULT_RATE_LIMIT_CONFIG,
  );
  if (!rl.allowed) {
    return {
      allowed: false,
      http_status: 429,
      reasons: ['rate_limit_ip'],
      retry_after_sec: rl.retry_after_sec,
    };
  }
  const captcha = await verifyCaptcha(
    input.captcha_token,
    input.ip,
    deps.captcha_config,
    deps.fetch_impl,
  );
  if (!captcha.ok) {
    return {
      allowed: false,
      http_status: 403,
      reasons: ['captcha_failed', ...captcha.error_codes],
    };
  }
  return { allowed: true, http_status: 200, reasons: [] };
}

export interface TradeGateInput {
  player_id: string;
  ip: string;
  now_ms: number;
  action_timestamp_ms: number;
}

export interface TradeGateDeps {
  pool: Pool;
  redis: RedisLike;
  rate_limit_config?: RateLimitConfig;
  age_gate_config?: AgeGateConfig;
  behavioral_config?: BehavioralAuditConfig;
}

/** Trade gate: user rate-limit + account age + behavioral score + shadow ban check. */
export async function checkTradeGate(
  input: TradeGateInput,
  deps: TradeGateDeps,
): Promise<AntiBotDecision> {
  const rl = await rateLimitHit(
    deps.redis,
    'user',
    input.player_id,
    deps.rate_limit_config ?? DEFAULT_RATE_LIMIT_CONFIG,
  );
  if (!rl.allowed) {
    return {
      allowed: false,
      http_status: 429,
      reasons: ['rate_limit_user'],
      retry_after_sec: rl.retry_after_sec,
    };
  }

  const age = await checkAgeGate(
    deps.pool,
    input.player_id,
    'trade',
    input.now_ms,
    deps.age_gate_config ?? DEFAULT_AGE_GATE_CONFIG,
  );
  if (!age.allowed) {
    return {
      allowed: false,
      http_status: 403,
      reasons: ['account_too_young', age.reason ?? 'unknown'],
    };
  }

  const behavioral = await recordSample(
    deps.redis,
    {
      player_id: input.player_id,
      action: 'trade',
      timestamp_ms: input.action_timestamp_ms,
    },
    deps.behavioral_config ?? DEFAULT_BEHAVIORAL_CONFIG,
  );

  const sb = await isShadowBanned(deps.redis, input.player_id);
  if (sb || behavioral.flagged_bot) {
    // Shadow-drop (allowed=true but isolated cohort downstream).
    // Both signals are emitted independently so callers can route on either.
    const reasons: string[] = [];
    if (behavioral.flagged_bot) reasons.push('shadow_drop_behavioral');
    if (sb) reasons.push('shadow_drop_flagged');
    return {
      allowed: true,
      http_status: 200,
      reasons,
      shadow_ban: sb,
      behavioral_score: behavioral,
    };
  }

  return {
    allowed: true,
    http_status: 200,
    reasons: [],
    behavioral_score: behavioral,
  };
}

export interface CombatActionInput {
  player_id: string;
  action_timestamp_ms: number;
}

export interface CombatActionDeps {
  redis: RedisLike;
  behavioral_config?: BehavioralAuditConfig;
}

/**
 * Combat action gate: ONLY updates behavioral score (no rate-limit because
 * combat tick is server-driven; no captcha for hot-path latency).
 *
 * Returns behavioral score so caller (CMD1 combat orchestrator) can flag
 * via CMD1 ban_pipeline if score=1.0 sustained.
 */
export async function recordCombatAction(
  input: CombatActionInput,
  deps: CombatActionDeps,
): Promise<BehavioralScore> {
  return recordSample(
    deps.redis,
    {
      player_id: input.player_id,
      action: 'combat',
      timestamp_ms: input.action_timestamp_ms,
    },
    deps.behavioral_config ?? DEFAULT_BEHAVIORAL_CONFIG,
  );
}

// Re-export public surface for callers.
export type { RedisLike } from './redis_like.js';
export type { RateLimitConfig, RateLimitKind } from './ip_rate_limit.js';
export { InMemoryRedis } from './redis_like.js';
export {
  rateLimitHit,
  rateLimitPeek,
  rateLimitReset,
  DEFAULT_RATE_LIMIT_CONFIG,
} from './ip_rate_limit.js';
export {
  verifyCaptcha,
  loadCaptchaConfigFromEnv,
  type CaptchaConfig,
  type CaptchaDecision,
  type FetchLike,
} from './captcha_gate.js';
export {
  checkAgeGate,
  DEFAULT_AGE_GATE_CONFIG,
  DEFAULT_MIN_AGE_MS,
  type AgeGateConfig,
  type AgeGateDecision,
  type BlockedAction,
} from './account_age_gate.js';
export {
  recordSample,
  peekScore,
  clearSamples,
  DEFAULT_BEHAVIORAL_CONFIG,
  type BehavioralAuditConfig,
  type BehavioralScore,
  type BehavioralSample,
} from './behavioral_audit.js';
export {
  shadowBan,
  isShadowBanned,
  unshadowBan,
  arePeersVisible,
  type ShadowBanFlag,
  type ShadowBanSource,
} from './shadow_ban.js';
