import { describe, it, expect } from 'vitest';
import { verifyReplay } from '../output/replay/replay_verifier.js';
import { computeStateChecksum } from '../output/replay/state_checksum.js';

function chain(states: Array<{ tick: number; state: unknown }>) {
  return states.map(computeStateChecksum);
}

describe('R68.2 replay_verifier — exact match', () => {
  it('match=true when sequences identical', () => {
    const seq = chain([
      { tick: 0, state: { hp: 100 } },
      { tick: 100, state: { hp: 90 } },
      { tick: 200, state: { hp: 80 } },
    ]);
    const r = verifyReplay({ battleId: 'b1', original: seq, replayed: seq });
    expect(r.match).toBe(true);
    if (r.match) expect(r.checkpointsCompared).toBe(3);
  });

  it('match=true on empty sequences', () => {
    const r = verifyReplay({ battleId: 'b1', original: [], replayed: [] });
    expect(r.match).toBe(true);
  });
});

describe('R68.2 replay_verifier — divergence at checkpoint', () => {
  it('reports first divergent tick', () => {
    const orig = chain([
      { tick: 0, state: { hp: 100 } },
      { tick: 100, state: { hp: 90 } },
      { tick: 200, state: { hp: 80 } },
    ]);
    const replay = chain([
      { tick: 0, state: { hp: 100 } },
      { tick: 100, state: { hp: 90 } },
      { tick: 200, state: { hp: 79 } }, // divergence at tick 200
    ]);
    const r = verifyReplay({ battleId: 'b1', original: orig, replayed: replay });
    expect(r.match).toBe(false);
    if (!r.match) {
      expect(r.divergenceTick).toBe(200);
      expect(r.checkpointsCompared).toBe(3);
      expect(r.originalHash).not.toBe(r.replayedHash);
    }
  });

  it('reports divergence on tick-number desync', () => {
    const orig = chain([
      { tick: 0, state: {} },
      { tick: 100, state: {} },
    ]);
    const replay = chain([
      { tick: 0, state: {} },
      { tick: 200, state: {} }, // tick mismatch at index 1
    ]);
    const r = verifyReplay({ battleId: 'b1', original: orig, replayed: replay });
    expect(r.match).toBe(false);
    if (!r.match) expect(r.divergenceTick).toBe(100); // min of mismatched
  });

  it('reports divergence when sequences different length', () => {
    const orig = chain([
      { tick: 0, state: {} },
      { tick: 100, state: {} },
      { tick: 200, state: {} },
    ]);
    const replay = chain([
      { tick: 0, state: {} },
      { tick: 100, state: {} },
    ]);
    const r = verifyReplay({ battleId: 'b1', original: orig, replayed: replay });
    expect(r.match).toBe(false);
    if (!r.match) expect(r.divergenceTick).toBe(200);
  });
});

describe('R68.2 replay_verifier — input validation', () => {
  it('rejects empty battleId', () => {
    expect(() => verifyReplay({ battleId: '', original: [], replayed: [] })).toThrow(/battleId/);
  });

  it('rejects non-array inputs', () => {
    expect(() =>
      verifyReplay({
        battleId: 'b1',
        original: null as unknown as never[],
        replayed: [],
      }),
    ).toThrow(/arrays/);
  });
});
