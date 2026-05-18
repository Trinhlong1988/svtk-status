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
 * Defer (Mr.Long quyết 2026-05-18 → Phase 15 CMD AUTH proper, see
 *   cmd-lead/escalations/R66_DECIDED_PHASE15.json):
 *   R66.3 persistent replay_cache (Redis/PG) — cmd-network/output/r69/replay_cache.ts is in-memory
 *   R66.4 multi-login policy (kick_old / reject_new + 5s grace)
 *   R66.5 hijack detection (IP change / UA change / geo jump > 5000km)
 *   R66.7 GM 2FA elevation (TOTP, 15-min TTL, dual-authorization)
 *   R66.8 login flood protection (per-IP 5/60s, per-account 5 fails/5min)
 *   R66.9 auth_log triggered audit (R42 pattern)
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
  // Audit bug#18: guard against undefined/null fields (previously crashed).
  const norm = (s: unknown) => (typeof s === 'string' ? s : '').trim();
  // Audit consideration: '|' separator could collide if any field contains '|'
  // and an adjacent field is empty. Encode each field via JSON.stringify so
  // separators inside content cannot align with the join.
  const canonical = [
    norm(d.userAgent).toLowerCase(),
    norm(d.screenResolution),
    norm(d.timezone),
    norm(d.language).toLowerCase(),
    norm(d.platform),
  ]
    .map((s) => JSON.stringify(s))
    .join('|');
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
  // Audit bug#30/#31/#32/#33: validate inputs before producing token that
  // would otherwise be impossible to expire (NaN/Infinity) or born-expired
  // (negative ttl). Bug#34: reject empty playerId/fingerprint.
  if (typeof p.playerId !== 'string' || p.playerId.length === 0) {
    throw new TypeError('issueSessionToken: playerId must be non-empty string');
  }
  if (typeof p.deviceFingerprint !== 'string' || p.deviceFingerprint.length === 0) {
    throw new TypeError('issueSessionToken: deviceFingerprint must be non-empty string');
  }
  if (typeof p.nowMs !== 'number' || !Number.isFinite(p.nowMs)) {
    throw new TypeError(`issueSessionToken: nowMs must be finite number (got ${p.nowMs})`);
  }
  const ttl = p.ttlMs ?? SESSION_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new RangeError(`issueSessionToken: ttlMs must be positive finite (got ${p.ttlMs})`);
  }
  const rng = p.rngBytes ?? randomBytes;
  const tokenBuf = rng(TOKEN_BYTES);
  if (!Buffer.isBuffer(tokenBuf) || tokenBuf.length !== TOKEN_BYTES) {
    throw new Error(`issueSessionToken: rngBytes must return Buffer of ${TOKEN_BYTES} bytes`);
  }
  const sessionId = createHash('sha256').update(tokenBuf).digest('hex').slice(0, 32);
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
  if (typeof p.sessionId !== 'string' || p.sessionId.length === 0) {
    throw new TypeError('issueReconnectToken: sessionId must be non-empty string');
  }
  if (typeof p.playerId !== 'string' || p.playerId.length === 0) {
    throw new TypeError('issueReconnectToken: playerId must be non-empty string');
  }
  if (typeof p.nowMs !== 'number' || !Number.isFinite(p.nowMs)) {
    throw new TypeError('issueReconnectToken: nowMs must be finite number');
  }
  const rng = p.rngBytes ?? randomBytes;
  const tokenBuf = rng(TOKEN_BYTES);
  if (!Buffer.isBuffer(tokenBuf) || tokenBuf.length !== TOKEN_BYTES) {
    throw new Error(`issueReconnectToken: rngBytes must return Buffer of ${TOKEN_BYTES} bytes`);
  }
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
 *
 * Hardened against (audit 2026-05-18):
 *   - bug#15 timing-oracle: check expiry FIRST so attacker probing wrong
 *     tokens on expired sessions does not learn whether the guess matched.
 *   - bug#16 undefined presentedTokenHex previously crashed; now graceful.
 *   - bug#19 empty token both sides authenticated; now empty inputs reject.
 */
export function verifySessionToken(p: VerifyParams): VerifyResult {
  if (!p.storedPayload) return { ok: false, reason: 'unknown_session' };

  // 1. Expiry check FIRST — fail closed and identically regardless of token,
  //    so the response doesn't reveal whether the presented token was correct
  //    on an expired session (R66.9 audit-log differentiates if needed).
  if (typeof p.nowMs !== 'number' || !Number.isFinite(p.nowMs)) {
    return { ok: false, reason: 'token_mismatch' };
  }
  if (p.nowMs >= p.storedPayload.expiresAtMs) {
    return { ok: false, reason: 'expired' };
  }

  // 2. Input validation — reject malformed presented token without crashing.
  if (typeof p.presentedTokenHex !== 'string' || p.presentedTokenHex.length === 0) {
    return { ok: false, reason: 'token_mismatch' };
  }
  if (typeof p.storedTokenHex !== 'string' || p.storedTokenHex.length === 0) {
    return { ok: false, reason: 'token_mismatch' };
  }
  // Enforce 256-bit (64-hex) token length to prevent empty/zero-length bypass
  // and reject obvious format violations early.
  if (p.storedTokenHex.length !== TOKEN_BYTES * 2 || p.presentedTokenHex.length !== TOKEN_BYTES * 2) {
    return { ok: false, reason: 'token_mismatch' };
  }

  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(p.presentedTokenHex, 'hex');
    b = Buffer.from(p.storedTokenHex, 'hex');
  } catch {
    return { ok: false, reason: 'token_mismatch' };
  }
  // After hex parse, both must still be full 32 bytes (non-hex chars truncate silently).
  if (a.length !== TOKEN_BYTES || b.length !== TOKEN_BYTES) {
    return { ok: false, reason: 'token_mismatch' };
  }
  if (!timingSafeEqual(a, b)) {
    return { ok: false, reason: 'token_mismatch' };
  }

  // 3. Fingerprint match (cheap string compare AFTER constant-time token compare).
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
