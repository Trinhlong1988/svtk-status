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

  it('7. Length mismatch is reported as divergence', () => {
    const a = buildStream('enc_LEN', 10);
    const b = buildStream('enc_LEN', 25);
    const cpA = checksumStream(a, { every_n_turns: 5 });
    const cpB = checksumStream(b, { every_n_turns: 5 });
    const report = compareCheckpoints(cpA, cpB);
    expect(report.divergent).toBe(true);
  });
});
