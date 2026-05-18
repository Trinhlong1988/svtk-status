/**
 * R68 state_checksum — deterministic checkpoint + divergence detection.
 *
 * 7 tests:
 *   1. checksumFrame is deterministic across runs.
 *   2. canonicalize is key-order independent.
 *   3. checksumStream samples every N turns (default 10).
 *   4. Identical streams → no divergence.
 *   5. compareCheckpoints pinpoints first divergent turn.
 *   6. forensicDump returns suspect frame + events.
 *   7. Length mismatch reported as divergence.
 */
import { describe, it, expect } from 'vitest';
import {
  appendFrame,
  appendEvent,
  createReplayStream,
} from '../legacy/replay_event_stream.js';
import { type ReplayFrame, REPLAY_FRAME_SCHEMA_VERSION } from '../legacy/replay_frame.js';
import {
  checksumFrame,
  checksumStream,
  compareCheckpoints,
  forensicDump,
  canonicalize,
  CANON_SENTINEL_NAN,
  CANON_SENTINEL_POS_INF,
  CANON_SENTINEL_NEG_INF,
  CANON_SENTINEL_BIGINT_PREFIX,
  CANON_SENTINEL_SYMBOL_PREFIX,
  CANON_SENTINEL_UNDEFINED,
  CANON_KEY_PROTO,
  CANON_SENTINEL_CIRCULAR,
  CANON_TAG_DATE,
  CANON_TAG_MAP,
  CANON_TAG_SET,
  CANON_TAG_ARRAY_WITH_META,
  CANON_SENTINEL_GETTER_THREW,
  CANON_KEY_SYMBOL_PREFIX,
} from './state_checksum.js';

function makeFrame(turn: number, sessionId: string, encounterId: string, damage = 100): ReplayFrame {
  return {
    schemaVersion: REPLAY_FRAME_SCHEMA_VERSION,
    frameId: `${sessionId}@f${turn}`,
    turn,
    sessionId,
    encounterId,
    bossDecision: {
      branch: 'highest_threat',
      phaseTransitioned: false,
      currentPhaseId: 'phase_1',
      scheduledMechanicIds: [],
      resolvedMechanicIds: [],
    },
    statusDeltas: [],
    damageEvents: [{ kind: 'damage', skillId: 'fireball', sourceId: 'p1', targetId: 'b1', amount: damage }],
    threatSnapshot: [],
    rngTraces: [{ key: 'main', rollCount: turn }],
  };
}

function buildStream(encounter: string, turn_count: number, damage_each = 100) {
  const s = createReplayStream(encounter, `sess_${encounter}`);
  for (let t = 0; t < turn_count; t++) {
    appendFrame(s, makeFrame(t, `sess_${encounter}`, encounter, damage_each + t));
    appendEvent(s, t, 'damage', { amount: damage_each + t });
    appendEvent(s, t, 'status_apply', { id: 'burn' });
  }
  return s;
}

describe('R68 state_checksum — frame primitives', () => {
  it('1. checksumFrame is deterministic across runs', () => {
    const f = makeFrame(5, 'sess_X', 'enc_X');
    expect(checksumFrame(f)).toBe(checksumFrame(f));
  });

  it('2. canonicalize is key-order independent', () => {
    const a = { a: 1, b: 2, nested: { x: 'a', y: 'b' } };
    const b = { nested: { y: 'b', x: 'a' }, b: 2, a: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });
});

describe('R68 state_checksum — stream sampling', () => {
  it('3. checksumStream samples first + multiples of N + last frame', () => {
    const stream = buildStream('enc_S', 23);
    const cps = checksumStream(stream, { every_n_turns: 10 });
    // expect: turn 0 (first), 10, 20, 22 (last) — dedup if last coincides with multiple.
    const turns = cps.map((c) => c.turn);
    expect(turns).toContain(0);
    expect(turns).toContain(10);
    expect(turns).toContain(20);
    expect(turns).toContain(22);
  });

  it('4. Identical streams → no divergence', () => {
    const a = buildStream('enc_EQ', 15);
    const b = buildStream('enc_EQ', 15);
    const cpA = checksumStream(a, { every_n_turns: 5 });
    const cpB = checksumStream(b, { every_n_turns: 5 });
    const report = compareCheckpoints(cpA, cpB);
    expect(report.divergent).toBe(false);
  });
});

describe('R68 state_checksum — divergence + forensics', () => {
  it('5. compareCheckpoints pinpoints first divergent turn', () => {
    const a = buildStream('enc_DIV', 15, 100);
    // Same encounter id keeps aggregates aligned up to the point of divergence;
    // diverge stat at turn 10.
    const b = createReplayStream('enc_DIV', 'sess_enc_DIV');
    for (let t = 0; t < 15; t++) {
      const damage = t === 10 ? 999 : 100 + t;
      appendFrame(b, makeFrame(t, 'sess_enc_DIV', 'enc_DIV', damage));
    }
    const cpA = checksumStream(a, { every_n_turns: 5 });
    const cpB = checksumStream(b, { every_n_turns: 5 });
    const report = compareCheckpoints(cpA, cpB);
    expect(report.divergent).toBe(true);
    expect(report.first_divergent_turn).toBe(10);
  });

  it('6. forensicDump returns the suspect frame + intra-turn events', () => {
    const s = buildStream('enc_FX', 12);
    const dump = forensicDump(s, 7, 'expected_hash_value');
    expect(dump.divergence_turn).toBe(7);
    expect(dump.frame?.turn).toBe(7);
    expect(dump.events_in_turn.length).toBe(2);
    expect(dump.events_prev_turn.length).toBe(2);
    expect(dump.checksum_actual).toBeDefined();
    expect(dump.checksum_expected).toBe('expected_hash_value');
  });

  it('BUG-18: forensicDump.frame is deep-frozen — cannot leak mutation to stream', () => {
    const s = buildStream('enc_FROST', 5);
    const dump = forensicDump(s, 3);
    expect(dump.frame).toBeDefined();
    expect(Object.isFrozen(dump.frame)).toBe(true);
    // Mutation attempt throws (strict mode)
    expect(() => { (dump.frame as { turn: number }).turn = 999; }).toThrow();
    // Stream untouched
    expect(s.frames.find((f) => f.turn === 3)?.turn).toBe(3);
  });

  it('BUG-18: forensicDump.events_in_turn entries are frozen', () => {
    const s = buildStream('enc_FROST_E', 5);
    const dump = forensicDump(s, 2);
    expect(dump.events_in_turn.length).toBeGreaterThan(0);
    const evt = dump.events_in_turn[0];
    expect(evt).toBeDefined();
    expect(Object.isFrozen(evt)).toBe(true);
    expect(() => { (evt as { turn: number }).turn = 999; }).toThrow();
  });

  it('7. Length mismatch is reported as divergence', () => {
    const a = buildStream('enc_LEN', 10);
    const b = buildStream('enc_LEN', 25);
    const cpA = checksumStream(a, { every_n_turns: 5 });
    const cpB = checksumStream(b, { every_n_turns: 5 });
    const report = compareCheckpoints(cpA, cpB);
    expect(report.divergent).toBe(true);
  });
});

describe('R68 state_checksum — NaN/Infinity sentinel (regression BUG-2)', () => {
  function frameWithDamage(amount: number) {
    return {
      schemaVersion: 1,
      frameId: 'f',
      turn: 0,
      sessionId: 's',
      encounterId: 'e',
      bossDecision: {
        branch: 'highest_threat' as const,
        phaseTransitioned: false,
        currentPhaseId: 'p1',
        scheduledMechanicIds: [],
        resolvedMechanicIds: [],
      },
      statusDeltas: [],
      damageEvents: [{ kind: 'damage' as const, sourceId: 'p', targetId: 'b', amount }],
      threatSnapshot: [],
      rngTraces: [],
    };
  }

  it('BUG-2: NaN, +Infinity, -Infinity produce DISTINCT hashes', () => {
    const hNaN = checksumFrame(frameWithDamage(NaN));
    const hPosInf = checksumFrame(frameWithDamage(Infinity));
    const hNegInf = checksumFrame(frameWithDamage(-Infinity));
    const hZero = checksumFrame(frameWithDamage(0));
    expect(hNaN).not.toBe(hPosInf);
    expect(hNaN).not.toBe(hNegInf);
    expect(hPosInf).not.toBe(hNegInf);
    expect(hNaN).not.toBe(hZero);
    expect(hPosInf).not.toBe(hZero);
    expect(hNegInf).not.toBe(hZero);
  });

  it('BUG-2: canonicalize emits sentinel for non-finite numbers', () => {
    expect(canonicalize({ x: NaN })).toBe(`{"x":"${CANON_SENTINEL_NAN}"}`);
    expect(canonicalize({ x: Infinity })).toBe(`{"x":"${CANON_SENTINEL_POS_INF}"}`);
    expect(canonicalize({ x: -Infinity })).toBe(`{"x":"${CANON_SENTINEL_NEG_INF}"}`);
  });

  it('BUG-2: finite numbers untouched', () => {
    expect(canonicalize({ x: 0 })).toBe('{"x":0}');
    expect(canonicalize({ x: -0 })).toBe('{"x":0}');
    expect(canonicalize({ x: 1.5 })).toBe('{"x":1.5}');
    expect(canonicalize({ x: 1e21 })).toBe('{"x":1e+21}');
  });
});

describe('R68 state_checksum — bigint/Symbol/undefined sentinels (regression BUG-4/5)', () => {
  it('BUG-4: canonicalize(bigint) does NOT throw, emits sentinel', () => {
    expect(() => canonicalize({ x: 123n })).not.toThrow();
    expect(canonicalize({ x: 123n })).toBe(`{"x":"${CANON_SENTINEL_BIGINT_PREFIX}123__"}`);
    expect(canonicalize({ x: 0n })).toBe(`{"x":"${CANON_SENTINEL_BIGINT_PREFIX}0__"}`);
    expect(canonicalize({ x: -999n })).toBe(`{"x":"${CANON_SENTINEL_BIGINT_PREFIX}-999__"}`);
  });

  it('BUG-4: different bigint values produce different hashes', () => {
    const h1 = canonicalize({ x: 123n });
    const h2 = canonicalize({ x: 124n });
    expect(h1).not.toBe(h2);
  });

  it('BUG-5: canonicalize Symbol emits sentinel (not silently dropped)', () => {
    const a = canonicalize({ x: Symbol('abc'), y: 1 });
    const b = canonicalize({ y: 1 });
    expect(a).not.toBe(b);
    expect(a).toBe(`{"x":"${CANON_SENTINEL_SYMBOL_PREFIX}abc__","y":1}`);
  });

  it('BUG-5: explicit undefined value emits sentinel (distinct from missing key)', () => {
    const a = canonicalize({ x: undefined, y: 1 });
    const b = canonicalize({ y: 1 });
    expect(a).not.toBe(b);
    expect(a).toBe(`{"x":"${CANON_SENTINEL_UNDEFINED}","y":1}`);
  });

  it('BUG-6: __proto__ key is preserved via sentinel rename (not silently dropped)', () => {
    const obj = Object.create(null) as Record<string, unknown>;
    obj['__proto__'] = 'evil_payload';
    obj.x = 1;
    const canon = canonicalize(obj);
    expect(canon).toContain(CANON_KEY_PROTO);
    expect(canon).toContain('evil_payload');
    // Distinct from same payload without __proto__
    expect(canon).not.toBe(canonicalize({ x: 1 }));
  });

  it('BUG-7: circular reference does NOT throw — emits CIRCULAR sentinel', () => {
    const a: { x: number; self?: unknown } = { x: 1 };
    a.self = a;
    expect(() => canonicalize(a)).not.toThrow();
    expect(canonicalize(a)).toContain(CANON_SENTINEL_CIRCULAR);
  });

  it('BUG-7: deeply nested circular array also handled', () => {
    const arr: unknown[] = [1, 2];
    arr.push(arr);
    expect(() => canonicalize(arr)).not.toThrow();
    expect(canonicalize(arr)).toContain(CANON_SENTINEL_CIRCULAR);
  });

  it('BUG-10: Map content preserved (was {} silently)', () => {
    const a = canonicalize({ data: new Map([['k1', 1], ['k2', 2]]) });
    const empty = canonicalize({ data: {} });
    expect(a).not.toBe(empty);
    expect(a).toContain(CANON_TAG_MAP);
    expect(a).toContain('k1');
  });

  it('BUG-10: Map distinct entries → distinct hash', () => {
    expect(canonicalize(new Map([['k', 1]]))).not.toBe(canonicalize(new Map([['k', 2]])));
  });

  it('BUG-10: Map insertion-order invariant (canonical key sort)', () => {
    expect(canonicalize(new Map([['a', 1], ['b', 2]]))).toBe(canonicalize(new Map([['b', 2], ['a', 1]])));
  });

  it('BUG-11: Set content preserved (was {} silently)', () => {
    const a = canonicalize({ data: new Set([1, 2, 3]) });
    const empty = canonicalize({ data: {} });
    expect(a).not.toBe(empty);
    expect(a).toContain(CANON_TAG_SET);
  });

  it('BUG-11: Set insertion-order invariant', () => {
    expect(canonicalize(new Set([1, 2, 3]))).toBe(canonicalize(new Set([3, 1, 2])));
  });

  it('BUG-12: Date timestamps preserved (was {} silently)', () => {
    const d1 = canonicalize({ t: new Date(1_000_000) });
    const d2 = canonicalize({ t: new Date(1_000_001) });
    const empty = canonicalize({ t: {} });
    expect(d1).not.toBe(d2);
    expect(d1).not.toBe(empty);
    expect(d1).toContain(CANON_TAG_DATE);
  });

  it('BUG-15: toJSON poisoning — payload preserved, toJSON ignored', () => {
    const evil = {
      __nasty: 'evil_payload',
      toJSON() { return { x: 1 }; },
    };
    const clean = { x: 1 };
    const evil_canon = canonicalize(evil);
    const clean_canon = canonicalize(clean);
    expect(evil_canon).not.toBe(clean_canon);
    expect(evil_canon).toContain('evil_payload');
  });

  it('BUG-17: array extra-property is preserved (was silently dropped)', () => {
    const arr = [1, 2, 3] as unknown as { metadata: string } & number[];
    arr.metadata = 'hidden';
    const plain = canonicalize([1, 2, 3]);
    const tagged = canonicalize(arr);
    expect(tagged).not.toBe(plain);
    expect(tagged).toContain(CANON_TAG_ARRAY_WITH_META);
    expect(tagged).toContain('hidden');
  });

  it('BUG-19: getter that throws does NOT propagate — emits sentinel', () => {
    const obj = {
      get x() { throw new Error('GET_DETONATION'); },
      y: 1,
    };
    expect(() => canonicalize(obj)).not.toThrow();
    expect(canonicalize(obj)).toContain(CANON_SENTINEL_GETTER_THREW);
  });

  it('BUG-20: shared subtree (DAG) is serialised both times — not falsely flagged as circular', () => {
    const shared = { val: 'shared_data' };
    const a = { left: shared, right: shared };
    const canon = canonicalize(a);
    expect(canon).not.toContain(CANON_SENTINEL_CIRCULAR);
    // shared payload appears twice (once per reference)
    const matches = canon.match(/shared_data/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('BUG-20: shared subtree as array repeat — full serialisation each time', () => {
    const inner = [1, 2, 3];
    const outer = { a: inner, b: inner };
    const canon = canonicalize(outer);
    expect(canon).not.toContain(CANON_SENTINEL_CIRCULAR);
    expect(canon).toBe('{"a":[1,2,3],"b":[1,2,3]}');
  });

  it('BUG-20: TRUE cycle still detected', () => {
    const c: { x: number; self?: unknown } = { x: 1 };
    c.self = c;
    expect(canonicalize(c)).toContain(CANON_SENTINEL_CIRCULAR);
  });

  it('BUG-21: Symbol-keyed property is preserved (was silently dropped)', () => {
    const sym = Symbol('secret_key');
    const a = { [sym]: 'evil_payload', x: 1 };
    const b = { x: 1 };
    const a_canon = canonicalize(a);
    expect(a_canon).not.toBe(canonicalize(b));
    expect(a_canon).toContain(CANON_KEY_SYMBOL_PREFIX);
    expect(a_canon).toContain('evil_payload');
  });

  it('BUG-21: distinct symbol-keyed values produce distinct hashes', () => {
    const sym = Symbol('k');
    expect(canonicalize({ [sym]: 'v1' })).not.toBe(canonicalize({ [sym]: 'v2' }));
  });

  it('BUG-8: unicode composed and decomposed forms produce SAME hash (NFC normalise)', () => {
    const composed = { name: 'café' };       // é = single U+00E9
    const decomposed = { name: 'café' };    // e + combining acute U+0301
    expect(canonicalize(composed)).toBe(canonicalize(decomposed));
  });

  it('BUG-4/5: integration — frame with bigint event payload no longer crashes checksumFrame', () => {
    // Synthetic frame whose damage event carries a bigint (boundary scenario)
    const frame = {
      schemaVersion: 1,
      frameId: 'f',
      turn: 0,
      sessionId: 's',
      encounterId: 'e',
      bossDecision: {
        branch: 'highest_threat' as const,
        phaseTransitioned: false,
        currentPhaseId: 'p1',
        scheduledMechanicIds: [],
        resolvedMechanicIds: [],
      },
      statusDeltas: [],
      damageEvents: [{ kind: 'damage' as const, sourceId: 'p', targetId: 'b', amount: 0 }],
      threatSnapshot: [],
      rngTraces: [],
      // ↓ extra forensic metadata that may be wedged in via cast
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _extra: { monotonic_ns: 999_999_999_999n } as any,
    } as Parameters<typeof checksumFrame>[0];
    expect(() => checksumFrame(frame)).not.toThrow();
  });
});
