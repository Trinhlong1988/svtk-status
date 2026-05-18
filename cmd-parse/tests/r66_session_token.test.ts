import { describe, it, expect } from 'vitest';
import {
  computeDeviceFingerprint,
  issueSessionToken,
  issueReconnectToken,
  verifySessionToken,
  R66_CONSTANTS,
} from '../output/auth/r66_session_token.js';

const NOW = 2_000_000_000_000; // 2033-05-18 fixed for determinism

function fakeRng(seedByte: number): (n: number) => Buffer {
  return (n: number) => Buffer.alloc(n, seedByte);
}

const FP_INPUT = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
  screenResolution: '1920x1080',
  timezone: 'Asia/Ho_Chi_Minh',
  language: 'vi-VN',
  platform: 'Win32',
};

describe('R66.6 device fingerprint', () => {
  it('is deterministic for same input', () => {
    expect(computeDeviceFingerprint(FP_INPUT)).toBe(computeDeviceFingerprint(FP_INPUT));
  });

  it('is case-insensitive on user-agent and language', () => {
    const a = computeDeviceFingerprint(FP_INPUT);
    const b = computeDeviceFingerprint({
      ...FP_INPUT,
      userAgent: FP_INPUT.userAgent.toUpperCase(),
      language: 'VI-VN',
    });
    expect(a).toBe(b);
  });

  it('changes when any canonical field changes', () => {
    const a = computeDeviceFingerprint(FP_INPUT);
    const b = computeDeviceFingerprint({ ...FP_INPUT, platform: 'Linux x86_64' });
    expect(a).not.toBe(b);
  });

  it('returns a 64-char hex SHA-256', () => {
    expect(computeDeviceFingerprint(FP_INPUT)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('R66.1 issueSessionToken', () => {
  it('produces 256-bit (64 hex) raw token', () => {
    const fp = computeDeviceFingerprint(FP_INPUT);
    const t = issueSessionToken({
      playerId: 'player_001',
      deviceFingerprint: fp,
      nowMs: NOW,
      rngBytes: fakeRng(0xa5),
    });
    expect(t.raw).toMatch(/^[0-9a-f]{64}$/);
    expect(t.raw.length).toBe(64);
  });

  it('sets default 24h TTL', () => {
    const fp = computeDeviceFingerprint(FP_INPUT);
    const t = issueSessionToken({
      playerId: 'player_001',
      deviceFingerprint: fp,
      nowMs: NOW,
      rngBytes: fakeRng(1),
    });
    expect(t.payload.expiresAtMs - t.payload.issuedAtMs).toBe(R66_CONSTANTS.SESSION_TTL_MS);
    expect(R66_CONSTANTS.SESSION_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('honors custom TTL', () => {
    const fp = computeDeviceFingerprint(FP_INPUT);
    const t = issueSessionToken({
      playerId: 'player_001',
      deviceFingerprint: fp,
      nowMs: NOW,
      ttlMs: 60_000,
      rngBytes: fakeRng(2),
    });
    expect(t.payload.expiresAtMs - t.payload.issuedAtMs).toBe(60_000);
  });

  it('is deterministic with injected RNG', () => {
    const fp = computeDeviceFingerprint(FP_INPUT);
    const a = issueSessionToken({ playerId: 'p1', deviceFingerprint: fp, nowMs: NOW, rngBytes: fakeRng(0x77) });
    const b = issueSessionToken({ playerId: 'p1', deviceFingerprint: fp, nowMs: NOW, rngBytes: fakeRng(0x77) });
    expect(a.raw).toBe(b.raw);
    expect(a.payload.sessionId).toBe(b.payload.sessionId);
  });
});

describe('R66.2 issueReconnectToken', () => {
  it('TTL is 1 hour', () => {
    const t = issueReconnectToken({
      sessionId: 'sess_001',
      playerId: 'player_001',
      nowMs: NOW,
      rngBytes: fakeRng(3),
    });
    expect(t.expiresAtMs - t.issuedAtMs).toBe(R66_CONSTANTS.RECONNECT_TTL_MS);
    expect(R66_CONSTANTS.RECONNECT_TTL_MS).toBe(60 * 60 * 1000);
  });

  it('is flagged single-use', () => {
    const t = issueReconnectToken({
      sessionId: 'sess_001',
      playerId: 'player_001',
      nowMs: NOW,
      rngBytes: fakeRng(4),
    });
    expect(t.singleUse).toBe(true);
  });
});

describe('R66.1 verifySessionToken', () => {
  const fp = computeDeviceFingerprint(FP_INPUT);
  const issued = issueSessionToken({
    playerId: 'player_001',
    deviceFingerprint: fp,
    nowMs: NOW,
    rngBytes: fakeRng(0x10),
  });

  it('accepts a fresh token + matching fingerprint', () => {
    const r = verifySessionToken({
      presentedTokenHex: issued.raw,
      storedTokenHex: issued.raw,
      storedPayload: issued.payload,
      presentedFingerprint: fp,
      nowMs: NOW + 1000,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects when storedPayload is null (unknown_session)', () => {
    const r = verifySessionToken({
      presentedTokenHex: issued.raw,
      storedTokenHex: issued.raw,
      storedPayload: null,
      presentedFingerprint: fp,
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_session');
  });

  it('rejects token mismatch (timing-safe path)', () => {
    const evil = '0'.repeat(64);
    const r = verifySessionToken({
      presentedTokenHex: evil,
      storedTokenHex: issued.raw,
      storedPayload: issued.payload,
      presentedFingerprint: fp,
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('token_mismatch');
  });

  it('rejects expired token', () => {
    const r = verifySessionToken({
      presentedTokenHex: issued.raw,
      storedTokenHex: issued.raw,
      storedPayload: issued.payload,
      presentedFingerprint: fp,
      nowMs: issued.payload.expiresAtMs + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired');
  });

  it('rejects fingerprint mismatch', () => {
    const otherFp = computeDeviceFingerprint({ ...FP_INPUT, platform: 'Linux' });
    const r = verifySessionToken({
      presentedTokenHex: issued.raw,
      storedTokenHex: issued.raw,
      storedPayload: issued.payload,
      presentedFingerprint: otherFp,
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('fingerprint_mismatch');
  });
});
