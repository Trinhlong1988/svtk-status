import { describe, it, expect } from 'vitest';
import { ReplayCache } from '../output/r69/replay_cache.js';

describe('R69 ReplayCache — nonce admission', () => {
  it('admits a new nonce', () => {
    const c = new ReplayCache();
    expect(c.checkAndAdmit('nonce_a')).toBe(true);
    expect(c.has('nonce_a')).toBe(true);
  });

  it('rejects a replayed nonce', () => {
    const c = new ReplayCache();
    c.admit('nonce_a');
    expect(c.checkAndAdmit('nonce_a')).toBe(false);
  });

  it('admit is idempotent (no double-count)', () => {
    const c = new ReplayCache();
    c.admit('nonce_a');
    c.admit('nonce_a');
    expect(c.size()).toBe(1);
  });
});

describe('R69 ReplayCache — bounded ring (FIFO eviction)', () => {
  it('evicts oldest nonce when capacity reached', () => {
    const c = new ReplayCache({ capacity: 3 });
    c.admit('n1');
    c.admit('n2');
    c.admit('n3');
    c.admit('n4'); // should evict n1
    expect(c.has('n1')).toBe(false);
    expect(c.has('n2')).toBe(true);
    expect(c.has('n3')).toBe(true);
    expect(c.has('n4')).toBe(true);
    expect(c.size()).toBe(3);
  });

  it('throws on capacity <= 0', () => {
    expect(() => new ReplayCache({ capacity: 0 })).toThrow(/capacity/);
    expect(() => new ReplayCache({ capacity: -1 })).toThrow(/capacity/);
  });

  it('default capacity is 10000', () => {
    const c = new ReplayCache();
    for (let i = 0; i < 10_000; i++) c.admit(`n${i}`);
    expect(c.size()).toBe(10_000);
    expect(c.has('n0')).toBe(true);
    c.admit('n10000'); // evicts n0
    expect(c.has('n0')).toBe(false);
    expect(c.has('n10000')).toBe(true);
    expect(c.size()).toBe(10_000);
  });
});

describe('R69.2 ReplayCache — monotonic sequence', () => {
  it('admits strictly increasing seq', () => {
    const c = new ReplayCache();
    expect(c.admitSeq(1)).toBe(true);
    expect(c.admitSeq(2)).toBe(true);
    expect(c.admitSeq(100)).toBe(true);
  });

  it('rejects duplicate seq', () => {
    const c = new ReplayCache();
    c.admitSeq(5);
    expect(c.admitSeq(5)).toBe(false);
  });

  it('rejects out-of-order (lower) seq', () => {
    const c = new ReplayCache();
    c.admitSeq(10);
    expect(c.admitSeq(9)).toBe(false);
    expect(c.admitSeq(8)).toBe(false);
  });

  it('tracks last admitted seq', () => {
    const c = new ReplayCache();
    c.admitSeq(7);
    expect(c.getLastSeq()).toBe(7);
    c.admitSeq(10);
    expect(c.getLastSeq()).toBe(10);
  });
});

describe('R69.6 ReplayCache — reset on reconnect', () => {
  it('clears nonces and seq on reset', () => {
    const c = new ReplayCache();
    c.admit('n1');
    c.admit('n2');
    c.admitSeq(5);
    c.reset();
    expect(c.size()).toBe(0);
    expect(c.has('n1')).toBe(false);
    expect(c.getLastSeq()).toBe(-1);
    // after reset, previously-replayed nonce can be admitted again (new session)
    expect(c.checkAndAdmit('n1')).toBe(true);
    expect(c.admitSeq(1)).toBe(true);
  });
});
