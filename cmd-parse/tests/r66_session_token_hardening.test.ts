import { describe, it, expect } from 'vitest';
import {
  issueSessionToken,
  verifySessionToken,
  computeDeviceFingerprint,
  R66_CONSTANTS,
} from '../output/auth/r66_session_token.js';

const FP = computeDeviceFingerprint({
  userAgent: 'a',
  screenResolution: '1x1',
  timezone: 'UTC',
  language: 'en',
  platform: 'Win',
});

const NOW = 1_000_000;
const fakeRng = (b: number) => (n: number) => Buffer.alloc(n, b);
const TOKEN = issueSessionToken({
  playerId: 'p1',
  deviceFingerprint: FP,
  nowMs: NOW,
  rngBytes: fakeRng(0xab),
});

describe('Hardening — verify expiry FIRST (bug#15 — timing oracle)', () => {
  it('correct token + expired returns "expired" identically to wrong token + expired', () => {
    // Correct token, expired
    const expiredOk = verifySessionToken({
      presentedTokenHex: TOKEN.raw,
      storedTokenHex: TOKEN.raw,
      storedPayload: { ...TOKEN.payload, expiresAtMs: NOW - 1 },
      presentedFingerprint: FP,
      nowMs: NOW,
    });
    // Wrong token, expired
    const expiredBad = verifySessionToken({
      presentedTokenHex: '00'.repeat(32),
      storedTokenHex: TOKEN.raw,
      storedPayload: { ...TOKEN.payload, expiresAtMs: NOW - 1 },
      presentedFingerprint: FP,
      nowMs: NOW,
    });
    expect(expiredOk.ok).toBe(false);
    expect(expiredBad.ok).toBe(false);
    if (!expiredOk.ok) expect(expiredOk.reason).toBe('expired');
    if (!expiredBad.ok) expect(expiredBad.reason).toBe('expired');
    // SAME reason → no oracle distinguishes correct-but-expired from wrong-but-expired.
  });
});

describe('Hardening — empty / malformed token (bug#16, #19)', () => {
  it('rejects empty presented token (was: AUTH BYPASS when stored also empty)', () => {
    const r = verifySessionToken({
      presentedTokenHex: '',
      storedTokenHex: '',
      storedPayload: TOKEN.payload,
      presentedFingerprint: FP,
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('token_mismatch');
  });

  it('rejects undefined presented token gracefully (no crash)', () => {
    const r = verifySessionToken({
      presentedTokenHex: undefined as unknown as string,
      storedTokenHex: TOKEN.raw,
      storedPayload: TOKEN.payload,
      presentedFingerprint: FP,
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('token_mismatch');
  });

  it('rejects null presented token', () => {
    const r = verifySessionToken({
      presentedTokenHex: null as unknown as string,
      storedTokenHex: TOKEN.raw,
      storedPayload: TOKEN.payload,
      presentedFingerprint: FP,
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('token_mismatch');
  });

  it('rejects token length ≠ 64 hex chars', () => {
    const r = verifySessionToken({
      presentedTokenHex: 'ab',
      storedTokenHex: TOKEN.raw,
      storedPayload: TOKEN.payload,
      presentedFingerprint: FP,
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('token_mismatch');
  });

  it('rejects nowMs = NaN', () => {
    const r = verifySessionToken({
      presentedTokenHex: TOKEN.raw,
      storedTokenHex: TOKEN.raw,
      storedPayload: TOKEN.payload,
      presentedFingerprint: FP,
      nowMs: NaN,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('token_mismatch');
  });

  it('rejects non-hex token (Buffer.from drops silently to shorter buffer)', () => {
    const r = verifySessionToken({
      presentedTokenHex: 'Z'.repeat(64),
      storedTokenHex: TOKEN.raw,
      storedPayload: TOKEN.payload,
      presentedFingerprint: FP,
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('token_mismatch');
  });
});

describe('Hardening — fingerprint undefined input (bug#18)', () => {
  it('does not crash on undefined fingerprint fields', () => {
    expect(() =>
      computeDeviceFingerprint({
        userAgent: undefined as unknown as string,
        screenResolution: '1x1',
        timezone: 'UTC',
        language: 'en',
        platform: 'Win',
      }),
    ).not.toThrow();
  });

  it('produces a stable hash when all fields undefined', () => {
    const h = computeDeviceFingerprint({
      userAgent: undefined as unknown as string,
      screenResolution: undefined as unknown as string,
      timezone: undefined as unknown as string,
      language: undefined as unknown as string,
      platform: undefined as unknown as string,
    });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pipe-separator immune: UA containing | does not collide via field concatenation', () => {
    // After fix, each field is JSON-stringified before join with |.
    const a = computeDeviceFingerprint({
      userAgent: 'Mozilla',
      screenResolution: '1920x1080',
      timezone: 'UTC',
      language: 'en',
      platform: 'Win32',
    });
    const b = computeDeviceFingerprint({
      userAgent: 'Mozilla|1920x1080',
      screenResolution: '',
      timezone: 'UTC',
      language: 'en',
      platform: 'Win32',
    });
    expect(a).not.toBe(b);
  });
});

describe('R66 constants sanity', () => {
  it('TOKEN_BYTES = 32 (256-bit)', () => {
    expect(R66_CONSTANTS.TOKEN_BYTES).toBe(32);
  });
});
