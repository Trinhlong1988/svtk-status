/**
 * R66 Session Token — SVTK Foundation v2.8.0
 *
 * Opaque 256-bit token + device fingerprint + nonce.
 * Grace period: existing `session.ts` (legacy password+cookie) keeps running.
 * R66 token ONLY required for NEW sessions opened ≥ Phase 14 v2.8.0.
 *
 * Sub-rules covered:
 *   R66.1 — session_token (opaque 256-bit + payload)
 *   R66.2 — reconnect_token (separate, single-use, TTL 1h)
 *   R66.6 — device_fingerprint (SHA-256 of canonical UA + screen + tz + lang + platform)
 *
 * Defer (out of Phase 14 Tuần 2 scope — full impl in CMD AUTH proper):
 *   R66.3 persistent replay_cache (Redis/PG) — cmd-network/output/r69/replay_cache.ts is in-memory
 *   R66.4 multi-login policy (kick_old / reject_new + 5s grace)
 *   R66.5 hijack detection (IP change / UA change / geo jump)
 *   R66.7 GM 2FA elevation
 *   R66.8 login flood protection (per-IP / per-account rate limit)
 *   R66.9 auth_log triggered audit
 *
 * In-scope Tuần 2:
 *   R66.1 session_token structure (opaque 256-bit + payload + device fingerprint)
 *   R66.2 reconnect_token (TTL 1h single-use)
 *   R66.6 device_fingerprint canonical hash
 *   R66.3 partial — anti-replay via packet nonce (cmd-network/output/r69/replay_cache.ts)
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32; // 256 bits
const RECONNECT_TTL_MS = 60 * 60 * 1000; // 1h
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface SessionTokenPayload {
  sessionId: string;
  playerId: string;
  issuedAtMs: number;
  expiresAtMs: number;
  deviceFingerprint: string;
}

export interface SessionToken {
  raw: string; // hex-encoded 256-bit opaque
  payload: SessionTokenPayload;
}

export interface ReconnectToken {
  raw: string;
  sessionId: string;
  playerId: string;
  issuedAtMs: number;
  expiresAtMs: number;
  singleUse: true;
}

export interface DeviceFingerprintInput {
  userAgent: string;
  screenResolution: string; // "1920x1080"
  timezone: string; // IANA "Asia/Ho_Chi_Minh"
  language: string; // "vi-VN"
  platform: string; // "Win32" | "Linux x86_64" ...
}

/**
 * R66.6 — Compute device fingerprint from canonical user-agent attributes.
 * Stable across sessions for the same device; mismatch on verify triggers
 * R66.5 re-auth path (deferred — see file header).
 */
export function computeDeviceFingerprint(d: DeviceFingerprintInput): string {
  const canonical = [
    d.userAgent.trim().toLowerCase(),
    d.screenResolution.trim(),
    d.timezone.trim(),
    d.language.trim().toLowerCase(),
    d.platform.trim(),
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

export interface IssueSessionParams {
  playerId: string;
  deviceFingerprint: string;
  nowMs: number;
  ttlMs?: number;
  rngBytes?: (n: number) => Buffer; // injected for determinism in tests
}

/**
 * R66.1 — Issue an opaque 256-bit session token + payload.
 * RNG injection (`rngBytes`) is required for deterministic test seeding;
 * production defaults to `node:crypto.randomBytes`.
 */
export function issueSessionToken(p: IssueSessionParams): SessionToken {
  const rng = p.rngBytes ?? randomBytes;
  const tokenBuf = rng(TOKEN_BYTES);
  const sessionId = createHash('sha256').update(tokenBuf).digest('hex').slice(0, 32);
  const ttl = p.ttlMs ?? SESSION_TTL_MS;
  return {
    raw: tokenBuf.toString('hex'),
    payload: {
      sessionId,
      playerId: p.playerId,
      issuedAtMs: p.nowMs,
      expiresAtMs: p.nowMs + ttl,
      deviceFingerprint: p.deviceFingerprint,
    },
  };
}

export interface IssueReconnectParams {
  sessionId: string;
  playerId: string;
  nowMs: number;
  rngBytes?: (n: number) => Buffer;
}

/**
 * R66.2 — Issue a single-use reconnect token (TTL 1h, rotated each use).
 * Caller MUST invalidate on first successful use to enforce single-use.
 */
export function issueReconnectToken(p: IssueReconnectParams): ReconnectToken {
  const rng = p.rngBytes ?? randomBytes;
  const tokenBuf = rng(TOKEN_BYTES);
  return {
    raw: tokenBuf.toString('hex'),
    sessionId: p.sessionId,
    playerId: p.playerId,
    issuedAtMs: p.nowMs,
    expiresAtMs: p.nowMs + RECONNECT_TTL_MS,
    singleUse: true,
  };
}

export type VerifyResult =
  | { ok: true; payload: SessionTokenPayload }
  | { ok: false; reason: 'expired' | 'fingerprint_mismatch' | 'token_mismatch' | 'unknown_session' };

export interface VerifyParams {
  presentedTokenHex: string;
  storedTokenHex: string; // server-side store keyed by sessionId
  storedPayload: SessionTokenPayload | null;
  presentedFingerprint: string;
  nowMs: number;
}

/**
 * R66.1 verify — timing-safe token compare + expiry + device fingerprint match.
 * Returns structured reason on failure for auth_log (R66.9 — deferred).
 */
export function verifySessionToken(p: VerifyParams): VerifyResult {
  if (!p.storedPayload) return { ok: false, reason: 'unknown_session' };

  const a = Buffer.from(p.presentedTokenHex, 'hex');
  const b = Buffer.from(p.storedTokenHex, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'token_mismatch' };
  }

  if (p.nowMs >= p.storedPayload.expiresAtMs) {
    return { ok: false, reason: 'expired' };
  }

  if (p.presentedFingerprint !== p.storedPayload.deviceFingerprint) {
    return { ok: false, reason: 'fingerprint_mismatch' };
  }

  return { ok: true, payload: p.storedPayload };
}

export const R66_CONSTANTS = {
  TOKEN_BYTES,
  RECONNECT_TTL_MS,
  SESSION_TTL_MS,
} as const;
