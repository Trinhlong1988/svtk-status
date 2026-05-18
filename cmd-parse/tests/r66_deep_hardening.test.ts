import { describe, it, expect } from 'vitest';
import {
  issueSessionToken,
  issueReconnectToken,
  computeDeviceFingerprint,
} from '../output/auth/r66_session_token.js';

const FP = computeDeviceFingerprint({
  userAgent: 'a',
  screenResolution: '1x1',
  timezone: 'UTC',
  language: 'en',
  platform: 'Win',
});
const fakeRng = (b: number) => (n: number) => Buffer.alloc(n, b);

describe('Deep hardening — issueSessionToken input validation (bug#30-34)', () => {
  it('rejects negative ttlMs', () => {
    expect(() =>
      issueSessionToken({
        playerId: 'p',
        deviceFingerprint: FP,
        nowMs: 1000,
        ttlMs: -100,
        rngBytes: fakeRng(1),
      }),
    ).toThrow(/positive finite/);
  });

  it('rejects ttlMs = NaN (would otherwise produce non-expiring token)', () => {
    expect(() =>
      issueSessionToken({
        playerId: 'p',
        deviceFingerprint: FP,
        nowMs: 1000,
        ttlMs: NaN,
        rngBytes: fakeRng(1),
      }),
    ).toThrow(/positive finite/);
  });

  it('rejects ttlMs = Infinity (would otherwise produce non-expiring token)', () => {
    expect(() =>
      issueSessionToken({
        playerId: 'p',
        deviceFingerprint: FP,
        nowMs: 1000,
        ttlMs: Infinity,
        rngBytes: fakeRng(1),
      }),
    ).toThrow(/positive finite/);
  });

  it('rejects ttlMs = 0', () => {
    expect(() =>
      issueSessionToken({
        playerId: 'p',
        deviceFingerprint: FP,
        nowMs: 1000,
        ttlMs: 0,
        rngBytes: fakeRng(1),
      }),
    ).toThrow(/positive finite/);
  });

  it('rejects nowMs = NaN', () => {
    expect(() =>
      issueSessionToken({
        playerId: 'p',
        deviceFingerprint: FP,
        nowMs: NaN,
        rngBytes: fakeRng(1),
      }),
    ).toThrow(/finite/);
  });

  it('rejects empty playerId', () => {
    expect(() =>
      issueSessionToken({
        playerId: '',
        deviceFingerprint: FP,
        nowMs: 1000,
        rngBytes: fakeRng(1),
      }),
    ).toThrow(/playerId/);
  });

  it('rejects empty deviceFingerprint', () => {
    expect(() =>
      issueSessionToken({
        playerId: 'p',
        deviceFingerprint: '',
        nowMs: 1000,
        rngBytes: fakeRng(1),
      }),
    ).toThrow(/deviceFingerprint/);
  });

  it('rejects rngBytes returning wrong-size buffer', () => {
    expect(() =>
      issueSessionToken({
        playerId: 'p',
        deviceFingerprint: FP,
        nowMs: 1000,
        rngBytes: () => Buffer.alloc(16),
      }),
    ).toThrow(/Buffer of 32 bytes/);
  });
});

describe('Deep hardening — issueReconnectToken input validation', () => {
  it('rejects empty sessionId', () => {
    expect(() =>
      issueReconnectToken({
        sessionId: '',
        playerId: 'p',
        nowMs: 1000,
        rngBytes: fakeRng(1),
      }),
    ).toThrow(/sessionId/);
  });

  it('rejects nowMs NaN', () => {
    expect(() =>
      issueReconnectToken({
        sessionId: 's',
        playerId: 'p',
        nowMs: NaN,
        rngBytes: fakeRng(1),
      }),
    ).toThrow(/finite/);
  });
});
