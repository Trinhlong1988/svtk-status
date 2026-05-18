import { describe, it, expect } from 'vitest';
import { SamplingPolicy, DEFAULT_SAMPLING } from '../output/replay/sampling_policy.js';

const fixedRng = (v: number) => () => v;

describe('R68.4 SamplingPolicy — Foundation defaults', () => {
  it('PvP rate = 1.0', () => {
    expect(DEFAULT_SAMPLING.pvpRate).toBe(1.0);
  });
  it('PvE normal rate = 0.05', () => {
    expect(DEFAULT_SAMPLING.pveNormalRate).toBe(0.05);
  });
  it('Raid boss rate = 1.0', () => {
    expect(DEFAULT_SAMPLING.raidBossRate).toBe(1.0);
  });
  it('flagged player override defaults true', () => {
    expect(DEFAULT_SAMPLING.flaggedPlayerOverride).toBe(true);
  });
});

describe('R68.4 SamplingPolicy — shouldVerify behavior', () => {
  it('PvP always sampled (100%)', () => {
    const p = new SamplingPolicy();
    expect(
      p.shouldVerify({ battleId: 'b', kind: 'pvp', hasFlaggedPlayer: false }, fixedRng(0.99)),
    ).toBe(true);
  });

  it('PvE 5% — rng=0.04 → sampled', () => {
    const p = new SamplingPolicy();
    expect(
      p.shouldVerify({ battleId: 'b', kind: 'pve_normal', hasFlaggedPlayer: false }, fixedRng(0.04)),
    ).toBe(true);
  });

  it('PvE 5% — rng=0.06 → NOT sampled', () => {
    const p = new SamplingPolicy();
    expect(
      p.shouldVerify({ battleId: 'b', kind: 'pve_normal', hasFlaggedPlayer: false }, fixedRng(0.06)),
    ).toBe(false);
  });

  it('Raid always sampled', () => {
    const p = new SamplingPolicy();
    expect(
      p.shouldVerify({ battleId: 'b', kind: 'raid_boss', hasFlaggedPlayer: false }, fixedRng(0.99)),
    ).toBe(true);
  });

  it('Flagged player ALWAYS sampled regardless of kind', () => {
    const p = new SamplingPolicy();
    expect(
      p.shouldVerify({ battleId: 'b', kind: 'pve_normal', hasFlaggedPlayer: true }, fixedRng(0.99)),
    ).toBe(true);
  });

  it('Flagged-override OFF respects normal rate', () => {
    const p = new SamplingPolicy({ flaggedPlayerOverride: false });
    expect(
      p.shouldVerify({ battleId: 'b', kind: 'pve_normal', hasFlaggedPlayer: true }, fixedRng(0.99)),
    ).toBe(false);
  });

  it('rate=0 → never sampled regardless of rng', () => {
    const p = new SamplingPolicy({ pveNormalRate: 0 });
    expect(
      p.shouldVerify({ battleId: 'b', kind: 'pve_normal', hasFlaggedPlayer: false }, fixedRng(0.0)),
    ).toBe(false);
  });

  it('rate=1 → always sampled, rng never called', () => {
    let called = 0;
    const rng = () => {
      called++;
      return 0.99;
    };
    const p = new SamplingPolicy({ pveNormalRate: 1 });
    expect(
      p.shouldVerify({ battleId: 'b', kind: 'pve_normal', hasFlaggedPlayer: false }, rng),
    ).toBe(true);
    expect(called).toBe(0);
  });

  it('rejects rate outside [0, 1]', () => {
    expect(() => new SamplingPolicy({ pvpRate: -0.1 })).toThrow(/finite in/);
    expect(() => new SamplingPolicy({ pvpRate: 1.1 })).toThrow(/finite in/);
    expect(() => new SamplingPolicy({ pvpRate: NaN })).toThrow(/finite in/);
  });

  it('rejects rng() returning out-of-range value', () => {
    const p = new SamplingPolicy();
    expect(() =>
      p.shouldVerify({ battleId: 'b', kind: 'pve_normal', hasFlaggedPlayer: false }, fixedRng(1.5)),
    ).toThrow(/invalid/);
    expect(() =>
      p.shouldVerify({ battleId: 'b', kind: 'pve_normal', hasFlaggedPlayer: false }, fixedRng(NaN)),
    ).toThrow(/invalid/);
  });
});
