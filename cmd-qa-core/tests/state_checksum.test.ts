import { describe, it, expect } from 'vitest';
import {
  computeStateChecksum,
  generateCheckpoints,
  CHECKSUM_METHOD,
  DEFAULT_CHECKPOINT_INTERVAL_TICKS,
} from '../output/replay/state_checksum.js';

describe('R68.1 state_checksum — determinism', () => {
  it('same snapshot → same hash', () => {
    const a = computeStateChecksum({ tick: 0, state: { hp: 100, mana: 50 } });
    const b = computeStateChecksum({ tick: 0, state: { hp: 100, mana: 50 } });
    expect(a.hash).toBe(b.hash);
  });

  it('key order independent (canonical)', () => {
    const a = computeStateChecksum({ tick: 1, state: { hp: 100, mana: 50, x: 'foo' } });
    const b = computeStateChecksum({ tick: 1, state: { x: 'foo', mana: 50, hp: 100 } });
    expect(a.hash).toBe(b.hash);
  });

  it('different value → different hash', () => {
    const a = computeStateChecksum({ tick: 0, state: { hp: 100 } });
    const b = computeStateChecksum({ tick: 0, state: { hp: 99 } });
    expect(a.hash).not.toBe(b.hash);
  });

  it('records method and tick', () => {
    const a = computeStateChecksum({ tick: 42, state: {} });
    expect(a.tick).toBe(42);
    expect(a.method).toBe(CHECKSUM_METHOD);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects negative or non-integer tick', () => {
    expect(() => computeStateChecksum({ tick: -1, state: {} })).toThrow(/non-negative integer/);
    expect(() => computeStateChecksum({ tick: 1.5, state: {} })).toThrow(/non-negative integer/);
    expect(() => computeStateChecksum({ tick: NaN, state: {} })).toThrow(/non-negative integer/);
  });

  it('rejects NaN / Infinity / BigInt / Date / Symbol in state', () => {
    expect(() => computeStateChecksum({ tick: 0, state: { hp: NaN } })).toThrow(/non-finite/);
    expect(() => computeStateChecksum({ tick: 0, state: { hp: Infinity } })).toThrow(/non-finite/);
    expect(() => computeStateChecksum({ tick: 0, state: { hp: 1n as unknown as number } })).toThrow(/BigInt/);
    expect(() => computeStateChecksum({ tick: 0, state: { at: new Date(0) } })).toThrow(/Date/);
    expect(() => computeStateChecksum({ tick: 0, state: { x: undefined } as unknown as Record<string, unknown> })).not.toThrow();
    // undefined values are omitted from canonical
  });

  it('handles nested objects and arrays', () => {
    const a = computeStateChecksum({
      tick: 0,
      state: { units: [{ id: 'u1', hp: 100 }, { id: 'u2', hp: 50 }] },
    });
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('R68.1 generateCheckpoints', () => {
  it('emits one checksum per interval-aligned snapshot', () => {
    const snaps = [];
    for (let t = 0; t <= 500; t += 50) snaps.push({ tick: t, state: { hp: 100 - t / 5 } });
    const cps = generateCheckpoints(snaps, 100);
    // tick 0, 100, 200, 300, 400, 500 → 6 checkpoints
    expect(cps.length).toBe(6);
    expect(cps.map((c) => c.tick)).toEqual([0, 100, 200, 300, 400, 500]);
  });

  it('default interval = 100 ticks', () => {
    expect(DEFAULT_CHECKPOINT_INTERVAL_TICKS).toBe(100);
  });

  it('rejects invalid interval', () => {
    expect(() => generateCheckpoints([], 0)).toThrow(/positive integer/);
    expect(() => generateCheckpoints([], -1)).toThrow(/positive integer/);
    expect(() => generateCheckpoints([], 1.5)).toThrow(/positive integer/);
  });
});
