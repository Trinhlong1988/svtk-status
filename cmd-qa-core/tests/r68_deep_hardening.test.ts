import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeStateChecksum } from '../output/replay/state_checksum.js';
import { verifyReplay } from '../output/replay/replay_verifier.js';
import { writeForensicDump } from '../output/replay/forensic_dump.js';
import { SamplingPolicy } from '../output/replay/sampling_policy.js';

describe('R68.1 state_checksum — tick binding (audit bug#40)', () => {
  it('same state at different ticks → different hash', () => {
    const a = computeStateChecksum({ tick: 0, state: { hp: 100 } });
    const b = computeStateChecksum({ tick: 100, state: { hp: 100 } });
    expect(a.hash).not.toBe(b.hash);
  });

  it('empty state at different ticks → different hash', () => {
    const a = computeStateChecksum({ tick: 0, state: {} });
    const b = computeStateChecksum({ tick: 1, state: {} });
    expect(a.hash).not.toBe(b.hash);
  });

  it('rejects tick > MAX_SAFE_INTEGER', () => {
    expect(() =>
      computeStateChecksum({ tick: Number.MAX_SAFE_INTEGER + 2, state: {} }),
    ).toThrow(/integer in/);
  });
});

describe('R68.2 replay_verifier — tick-keyed matching (audit bug#41)', () => {
  const mk = (tick: number, hash: string) => ({ tick, hash, method: 'sha256_canonical_v1' as const });

  it('scrambled order in replayed still matches if hashes by tick match', () => {
    const o = [mk(0, 'h0'), mk(100, 'h1'), mk(200, 'h2')];
    const r = [mk(200, 'h2'), mk(0, 'h0'), mk(100, 'h1')];
    const v = verifyReplay({ battleId: 'b', original: o, replayed: r });
    expect(v.match).toBe(true);
  });

  it('missing tick in replayed → divergence at that tick', () => {
    const o = [mk(0, 'h0'), mk(100, 'h1'), mk(200, 'h2')];
    const r = [mk(0, 'h0'), mk(200, 'h2')]; // tick 100 missing
    const v = verifyReplay({ battleId: 'b', original: o, replayed: r });
    expect(v.match).toBe(false);
    if (!v.match) expect(v.divergenceTick).toBe(100);
  });

  it('extra tick in replayed → divergence at extra tick', () => {
    const o = [mk(0, 'h0')];
    const r = [mk(0, 'h0'), mk(50, 'h?')];
    const v = verifyReplay({ battleId: 'b', original: o, replayed: r });
    expect(v.match).toBe(false);
    if (!v.match) expect(v.divergenceTick).toBe(50);
  });
});

describe('R68.2 replay_verifier — duplicate tick + method check (audit bug#48/#50)', () => {
  const mk = (tick: number, hash: string, method = 'sha256_canonical_v1' as const) => ({
    tick, hash, method,
  });

  it('throws on duplicate tick in original', () => {
    expect(() =>
      verifyReplay({ battleId: 'b', original: [mk(0, 'a'), mk(0, 'b')], replayed: [] }),
    ).toThrow(/duplicate tick/);
  });

  it('throws on duplicate tick in replayed', () => {
    expect(() =>
      verifyReplay({ battleId: 'b', original: [], replayed: [mk(0, 'a'), mk(0, 'b')] }),
    ).toThrow(/duplicate tick/);
  });

  it('reports method-mismatch divergence', () => {
    const o = [mk(0, 'a', 'sha256_canonical_v1')];
    const r = [mk(0, 'a', 'md5_legacy' as unknown as 'sha256_canonical_v1')];
    const v = verifyReplay({ battleId: 'b', original: o, replayed: r });
    expect(v.match).toBe(false);
    if (!v.match) {
      expect(v.originalHash).toBe('<method_mismatch>');
      expect(v.divergenceTick).toBe(-1);
    }
  });
});

describe('R68.4 sampling — unknown kind explicit throw (audit bug#42)', () => {
  it('rateFor throws on unknown kind', () => {
    const p = new SamplingPolicy();
    expect(() => p.rateFor('unknown' as unknown as 'pvp')).toThrow(/unknown battle kind/);
  });

  it('shouldVerify throws on unknown kind (not silent false)', () => {
    const p = new SamplingPolicy();
    expect(() =>
      p.shouldVerify(
        { battleId: 'b', kind: 'unknown' as unknown as 'pvp', hasFlaggedPlayer: false },
        () => 0.5,
      ),
    ).toThrow(/unknown battle kind/);
  });

  it('shouldVerify validates battle input shape', () => {
    const p = new SamplingPolicy();
    expect(() =>
      p.shouldVerify(null as unknown as Parameters<typeof p.shouldVerify>[0], () => 0.5),
    ).toThrow(/battle/);
    expect(() =>
      p.shouldVerify(
        { battleId: '', kind: 'pvp', hasFlaggedPlayer: false },
        () => 0.5,
      ),
    ).toThrow(/battleId/);
    expect(() =>
      p.shouldVerify(
        { battleId: 'b', kind: 'pvp', hasFlaggedPlayer: 'yes' as unknown as boolean },
        () => 0.5,
      ),
    ).toThrow(/hasFlaggedPlayer/);
  });
});

describe('R68.3 forensic_dump — path traversal + ISO timestamp (audit bug#43/#47)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'audit-fix-'));
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });
  const div = { match: false as const, divergenceTick: 1, originalHash: 'a', replayedHash: 'b', checkpointsCompared: 1 };
  const env = { foundationVersion: '2.8.0', runtimeVersion: '2.6.5' };

  it('rejects outputPath with literal .. segment (path traversal)', () => {
    // path.join() resolves .. eagerly, so to actually pass a traversal-intent
    // string we have to build it manually.
    const evil = tmp + '\\..\\evil.json';
    expect(() =>
      writeForensicDump({
        battleId: 'b', verdict: div, originalStateFull: {}, replayedStateFull: {},
        environment: env, outputPath: evil, timestamp: '2026-05-18T00:00:00Z',
      }),
    ).toThrow(/path traversal/);
  });

  it('rejects relative outputPath', () => {
    expect(() =>
      writeForensicDump({
        battleId: 'b', verdict: div, originalStateFull: {}, replayedStateFull: {},
        environment: env, outputPath: './local.json', timestamp: '2026-05-18T00:00:00Z',
      }),
    ).toThrow(/absolute/);
  });

  it('rejects null byte in outputPath', () => {
    expect(() =>
      writeForensicDump({
        battleId: 'b', verdict: div, originalStateFull: {}, replayedStateFull: {},
        environment: env, outputPath: join(tmp, 'evil\0.json'), timestamp: '2026-05-18T00:00:00Z',
      }),
    ).toThrow(/null byte/);
  });

  it('rejects non-ISO-8601 timestamp', () => {
    expect(() =>
      writeForensicDump({
        battleId: 'b', verdict: div, originalStateFull: {}, replayedStateFull: {},
        environment: env, outputPath: null, timestamp: 'not-a-date',
      }),
    ).toThrow(/ISO-8601/);
    expect(() =>
      writeForensicDump({
        battleId: 'b', verdict: div, originalStateFull: {}, replayedStateFull: {},
        environment: env, outputPath: null, timestamp: '<script>alert(1)</script>',
      }),
    ).toThrow(/ISO-8601/);
  });

  it('accepts ISO-8601 with timezone offset', () => {
    expect(() =>
      writeForensicDump({
        battleId: 'b', verdict: div, originalStateFull: {}, replayedStateFull: {},
        environment: env, outputPath: null, timestamp: '2026-05-18T07:00:00+07:00',
      }),
    ).not.toThrow();
  });
});

describe('R68.3 forensic_dump — safe serializer (audit bug#44/#45/#46)', () => {
  const div = { match: false as const, divergenceTick: 1, originalHash: 'a', replayedHash: 'b', checkpointsCompared: 1 };
  const env = { foundationVersion: '2.8.0', runtimeVersion: '2.6.5' };
  const ts = '2026-05-18T00:00:00Z';

  it('survives circular references (no crash, marker emitted)', () => {
    const circ: Record<string, unknown> = { hp: 100 };
    circ.self = circ;
    const r = writeForensicDump({
      battleId: 'b', verdict: div, originalStateFull: circ, replayedStateFull: {},
      environment: env, outputPath: null, timestamp: ts,
    });
    expect(JSON.parse(r.body).original_state_full.self.__circular__).toBe(true);
  });

  it('serializes BigInt as decimal string marker', () => {
    const r = writeForensicDump({
      battleId: 'b', verdict: div, originalStateFull: { gold: 999999999999999n },
      replayedStateFull: {}, environment: env, outputPath: null, timestamp: ts,
    });
    expect(JSON.parse(r.body).original_state_full.gold.__bigint__).toBe('999999999999999');
  });

  it('serializes NaN / Infinity as markers (not null)', () => {
    const r = writeForensicDump({
      battleId: 'b', verdict: div,
      originalStateFull: { a: NaN, b: Infinity, c: -Infinity },
      replayedStateFull: {}, environment: env, outputPath: null, timestamp: ts,
    });
    const o = JSON.parse(r.body).original_state_full;
    expect(o.a.__non_finite__).toBe('NaN');
    expect(o.b.__non_finite__).toBe('Infinity');
    expect(o.c.__non_finite__).toBe('-Infinity');
  });

  it('serializes Date as ISO marker', () => {
    const r = writeForensicDump({
      battleId: 'b', verdict: div, originalStateFull: { at: new Date(0) },
      replayedStateFull: {}, environment: env, outputPath: null, timestamp: ts,
    });
    expect(JSON.parse(r.body).original_state_full.at.__date__).toBe('1970-01-01T00:00:00.000Z');
  });

  it('serializes Symbol/function values as unserializable marker', () => {
    const sym = Symbol('s');
    const r = writeForensicDump({
      battleId: 'b', verdict: div, originalStateFull: { f: () => 1, s: sym },
      replayedStateFull: {}, environment: env, outputPath: null, timestamp: ts,
    });
    const o = JSON.parse(r.body).original_state_full;
    expect(o.f.__unserializable__).toBe('function');
    expect(o.s.__unserializable__).toBe('symbol');
  });
});
