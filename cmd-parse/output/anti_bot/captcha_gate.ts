/**
 * Cloudflare Turnstile captcha verification gate.
 *
 * Wired into signup + suspicious-action checkpoints (large trade, password
 * reset, rapid action burst). Caller passes the user-submitted Turnstile
 * token + remote IP; gate POSTs to Cloudflare siteverify and returns
 * verdict.
 *
 * Secret loaded from env TURNSTILE_SECRET. fetch injectable for tests.
 */

export interface CaptchaConfig {
  secret: string;
  verify_url: string;
  timeout_ms: number;
}

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const DEFAULT_TIMEOUT_MS = 5000;

export function loadCaptchaConfigFromEnv(): CaptchaConfig {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) throw new Error('TURNSTILE_SECRET env required for captcha_gate');

  const timeoutRaw = process.env.TURNSTILE_TIMEOUT_MS;
  const timeout_ms = timeoutRaw === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutRaw);
  if (!Number.isFinite(timeout_ms) || timeout_ms <= 0) {
    throw new Error(`TURNSTILE_TIMEOUT_MS must be positive finite number, got "${timeoutRaw}"`);
  }

  return {
    secret,
    verify_url: process.env.TURNSTILE_VERIFY_URL ?? TURNSTILE_VERIFY_URL,
    timeout_ms,
  };
}

export interface CaptchaDecision {
  ok: boolean;
  /** Cloudflare error codes ('timeout-or-duplicate' / 'invalid-input-response' / ...). */
  error_codes: string[];
  /** Hostname Cloudflare saw on the challenge (debug + telemetry). */
  hostname?: string;
  /** Action attribute set on widget (anti-replay across actions). */
  action?: string;
  /** Cloudflare timestamp ISO. */
  challenge_ts?: string;
}

/** Cloudflare /siteverify response shape. */
interface TurnstileResponse {
  success: boolean;
  'error-codes'?: string[];
  hostname?: string;
  action?: string;
  challenge_ts?: string;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Verify a Turnstile token. Returns decision; never throws on validation
 * failure (returns ok=false + error_codes). Throws only on transport error.
 */
export async function verifyCaptcha(
  token: string,
  remoteIp: string | null,
  config: CaptchaConfig,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<CaptchaDecision> {
  if (!token) return { ok: false, error_codes: ['missing-input-response'] };

  const body = new URLSearchParams({ secret: config.secret, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout_ms);
  try {
    const res = await fetchImpl(config.verify_url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error_codes: [`http-${res.status}`] };
    }
    const data = (await res.json()) as TurnstileResponse;
    return {
      ok: data.success === true,
      error_codes: data['error-codes'] ?? [],
      hostname: data.hostname,
      action: data.action,
      challenge_ts: data.challenge_ts,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    return {
      ok: false,
      error_codes: name === 'AbortError' ? ['timeout'] : ['transport-error'],
    };
  } finally {
    clearTimeout(timer);
  }
}
