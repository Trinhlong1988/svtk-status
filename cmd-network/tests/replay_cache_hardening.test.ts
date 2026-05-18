import { describe, it, expect } from 'vitest';
import { ReplayCache } from '../output/r69/replay_cache.js';

describe('Hardening — capacity validation (bug#12, #13)', () => {
  it('rejects capacity = NaN', () => {
    expect(() => new ReplayCache({ capacity: NaN })).toThrow(/positive integer/);
  });

  it('rejects capacity = Infinity', () => {
    expect(() => new ReplayCache({ capacity: Infinity })).toThrow(/positive integer/);
  });

  it('rejects capacity = 0.5 (fractional)', () => {
    expect(() => new ReplayCache({ capacity: 0.5 })).toThrow(/positive integer/);
  });

  it('rejects capacity = -1', () => {
    expect(() => new ReplayCache({ capacity: -1 })).toThrow(/positive integer/);
  });

  it('rejects capacity = 0', () => {
    expect(() => new ReplayCache({ capacity: 0 })).toThrow(/positive integer/);
  });

  it('accepts capacity = 1 (minimum)', () => {
    const c = new ReplayCache({ capacity: 1 });
    expect(c.size()).toBe(0);
  });
});

describe('Hardening — admitSeq finite-integer guard (bug#8, #9)', () => {
  it('rejects admitSeq(NaN) — would otherwise lock lastSeq=NaN forever', () => {
    const c = new ReplayCache();
    expect(c.admitSeq(NaN)).toBe(false);
    expect(c.getLastSeq()).toBe(-1); // unchanged
  });

  it('rejects admitSeq(Infinity) — would otherwise DoS all finite seq', () => {
    const c = new ReplayCache();
    expect(c.admitSeq(Infinity)).toBe(false);
    expect(c.getLastSeq()).toBe(-1);
    expect(c.admitSeq(1)).toBe(true);
  });

  it('rejects admitSeq(-1)', () => {
    const c = new ReplayCache();
    expect(c.admitSeq(-1)).toBe(false);
  });

  it('rejects admitSeq(0.5) — non-integer', () => {
    const c = new ReplayCache();
    expect(c.admitSeq(0.5)).toBe(false);
  });

  it('accepts admitSeq(0) at initial state', () => {
    const c = new ReplayCache();
    expect(c.admitSeq(0)).toBe(true);
    expect(c.getLastSeq()).toBe(0);
  });
});

describe('Hardening — nonce input validation (bug#10, #11)', () => {
  it('rejects empty-string nonce', () => {
    const c = new ReplayCache();
    expect(c.checkAndAdmit('')).toBe(false);
    expect(c.size()).toBe(0);
    expect(c.has('')).toBe(false);
  });

  it('rejects non-string nonce (undefined / null / number)', () => {
    const c = new ReplayCache();
    expect(c.checkAndAdmit(undefined as unknown as string)).toBe(false);
    expect(c.checkAndAdmit(null as unknown as string)).toBe(false);
    expect(c.checkAndAdmit(0 as unknown as string)).toBe(false);
    expect(c.size()).toBe(0);
  });

  it('admit() returns boolean now (was void)', () => {
    const c = new ReplayCache();
    expect(c.admit('n1')).toBe(true);
    expect(c.admit('')).toBe(false);
  });
});
