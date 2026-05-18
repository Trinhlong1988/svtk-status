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
 * Defer (per Foundation Gap 1+2):
 *   R66.3 persistent replay_cache (Redis/PG) — cmd-network/output/r69/replay_cache.ts is in-memory
 *   R66.7 GM 2FA — out of Phase 14 scope
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
