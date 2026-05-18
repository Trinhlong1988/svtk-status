/**
 * R67 TickScheduler — 5 deterministic tests.
 *
 * Verifies:
 *   1. Same seed (base_ns) → identical ledger across runs.
 *   2. monotonic_ns strictly increasing.
 *   3. server_tick strictly +1 per event from 0.
 *   4. begin/aura_guard/end phases stamp in order within a turn.
 *   5. Multi-turn replay hash is stable (whole-ledger fingerprint).
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createCombatRuntime,
  type CombatRuntime,
} from '../legacy/combat_runtime.js';
import {
  createR67TickScheduler,
  createDeterministicMonotonicClock,
  type R67TickEvent,
} from './tick_scheduler_adapter.js';

function freshRuntime(encounter_id: string): CombatRuntime {
  return createCombatRuntime({
    encounterId: encounter_id,
    sessionId: `sess_${encounter_id}`,
  });
}

function runFixedScript(rt: CombatRuntime, base_ns: bigint, turns: number): readonly R67TickEvent[] {
  const sched = createR67TickScheduler({
    clock: createDeterministicMonotonicClock(base_ns),
  });
  for (let t = 1; t <= turns; t++) {
    sched.begin(rt, t);
    sched.guard(rt, t);
    sched.end(rt, t);
  }
  return sched.sequence();
}

function hashLedger(events: readonly R67TickEvent[]): string {
  const h = createHash('sha256');
  for (const ev of events) {
    h.update(
      `${ev.monotonic_ns}|${ev.server_tick}|${ev.turn}|${ev.phase}|${ev.encounter_id}\n`,
    );
  }
  return h.digest('hex');
}

describe('R67 TickScheduler — deterministic adapter', () => {
  it('1. Same base_ns produces identical ledger across runs', () => {
    const a = runFixedScript(freshRuntime('enc_A'), 0n, 5);
    const b = runFixedScript(freshRuntime('enc_A'), 0n, 5);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      const evA = a[i];
      const evB = b[i];
      expect(evA).toBeDefined();
      expect(evB).toBeDefined();
      expect(evA!.monotonic_ns).toBe(evB!.monotonic_ns);
      expect(evA!.server_tick).toBe(evB!.server_tick);
      expect(evA!.turn).toBe(evB!.turn);
      expect(evA!.phase).toBe(evB!.phase);
    }
  });

  it('2. monotonic_ns strictly increases', () => {
    const events = runFixedScript(freshRuntime('enc_B'), 0n, 10);
    expect(events.length).toBe(30); // 10 turns × 3 phases
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const curr = events[i];
      expect(prev).toBeDefined();
      expect(curr).toBeDefined();
      expect(curr!.monotonic_ns > prev!.monotonic_ns).toBe(true);
    }
  });

  it('3. server_tick is exactly +1 per event from 0', () => {
    const events = runFixedScript(freshRuntime('enc_C'), 0n, 7);
    expect(events.length).toBe(21);
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      expect(ev).toBeDefined();
      expect(ev!.server_tick).toBe(i);
    }
  });

  it('4. begin/aura_guard/end phases stamp in script order per turn', () => {
    const events = runFixedScript(freshRuntime('enc_D'), 0n, 3);
    const expected_phases = ['begin', 'aura_guard', 'end'];
    for (let t = 0; t < 3; t++) {
      const base = t * 3;
      for (let p = 0; p < 3; p++) {
        const ev = events[base + p];
        expect(ev).toBeDefined();
        expect(ev!.turn).toBe(t + 1);
        expect(ev!.phase).toBe(expected_phases[p]);
      }
    }
  });

  it('5. Multi-turn ledger hash is stable across runs (whole-stream fingerprint)', () => {
    const h1 = hashLedger(runFixedScript(freshRuntime('enc_HASH'), 0n, 12));
    const h2 = hashLedger(runFixedScript(freshRuntime('enc_HASH'), 0n, 12));
    expect(h1).toBe(h2);
    // Different base_ns ⇒ different hash.
    const h3 = hashLedger(runFixedScript(freshRuntime('enc_HASH'), 1_000_000n, 12));
    expect(h3).not.toBe(h1);
  });
});

describe('R67 TickScheduler — input validation (regression)', () => {
  it('BUG-1: rejects negative turn', () => {
    const rt = freshRuntime('reg_neg');
    const sched = createR67TickScheduler({ clock: createDeterministicMonotonicClock(0n) });
    expect(() => sched.begin(rt, -1)).toThrow(/non-negative integer/);
    expect(() => sched.guard(rt, -10)).toThrow(/non-negative integer/);
    expect(() => sched.end(rt, -100)).toThrow(/non-negative integer/);
  });

  it('BUG-1: rejects non-integer turn (fractional, NaN, Infinity)', () => {
    const rt = freshRuntime('reg_frac');
    const sched = createR67TickScheduler({ clock: createDeterministicMonotonicClock(0n) });
    expect(() => sched.begin(rt, 1.5)).toThrow(/non-negative integer/);
    expect(() => sched.begin(rt, NaN)).toThrow(/non-negative integer/);
    expect(() => sched.begin(rt, Infinity)).toThrow(/non-negative integer/);
  });

  it('BUG-1: turn = 0 is accepted (boundary)', () => {
    const rt = freshRuntime('reg_zero');
    const sched = createR67TickScheduler({ clock: createDeterministicMonotonicClock(0n) });
    expect(() => sched.begin(rt, 0)).not.toThrow();
  });

  it('BUG-22: missing runtime.config throws clear error (not cryptic property access)', () => {
    const sched = createR67TickScheduler({ clock: createDeterministicMonotonicClock(0n) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => sched.begin({ auraGuard: {} } as any, 1)).toThrow(/runtime\.config is missing/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => sched.begin(null as any, 1)).toThrow(/runtime must be a CombatRuntime/);
  });

  it('BUG-22: non-string encounterId rejected', () => {
    const sched = createR67TickScheduler({ clock: createDeterministicMonotonicClock(0n) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeRt = { config: { encounterId: 12345 }, auraGuard: {} } as any;
    expect(() => sched.begin(fakeRt, 1)).toThrow(/encounterId must be a string/);
  });
});

describe('R67 TickScheduler — ledger encapsulation (regression)', () => {
  it('BUG-3: sequence() returns frozen snapshot — push throws', () => {
    const rt = freshRuntime('reg_freeze');
    const sched = createR67TickScheduler({ clock: createDeterministicMonotonicClock(0n) });
    sched.begin(rt, 1);
    sched.guard(rt, 1);
    const seq = sched.sequence();
    expect(seq.length).toBe(2);
    expect(Object.isFrozen(seq)).toBe(true);
    expect(() => (seq as R67TickEvent[]).push({
      monotonic_ns: 999n, server_tick: 999, turn: 999, phase: 'begin', encounter_id: 'evil',
    })).toThrow();
    // Internal ledger unaffected
    expect(sched.sequence().length).toBe(2);
  });

  it('BUG-3: sequence() snapshot does NOT update after later stamps', () => {
    const rt = freshRuntime('reg_snapshot');
    const sched = createR67TickScheduler({ clock: createDeterministicMonotonicClock(0n) });
    sched.begin(rt, 1);
    const snapshot = sched.sequence();
    sched.guard(rt, 1);
    sched.end(rt, 1);
    expect(snapshot.length).toBe(1);             // snapshot frozen at 1 event
    expect(sched.sequence().length).toBe(3);     // fresh call sees all 3
  });

  it('BUG-13: inner event object also frozen (cannot mutate via snapshot)', () => {
    const rt = freshRuntime('reg_inner_freeze');
    const sched = createR67TickScheduler({ clock: createDeterministicMonotonicClock(0n) });
    sched.begin(rt, 1);
    const seq = sched.sequence();
    expect(Object.isFrozen(seq[0])).toBe(true);
    // Strict-mode assignment to a frozen property throws.
    expect(() => {
      (seq[0] as { turn: number }).turn = 999;
    }).toThrow();
    expect(sched.sequence()[0]?.turn).toBe(1);
  });
});

describe('R67 TickScheduler — bounded ledger (regression BUG-14)', () => {
  it('BUG-14: max_ledger_size caps in-memory event count (ring buffer)', () => {
    const rt = freshRuntime('reg_cap');
    const sched = createR67TickScheduler({
      clock: createDeterministicMonotonicClock(0n),
      max_ledger_size: 5,
    });
    for (let t = 1; t <= 20; t++) {
      sched.begin(rt, t);
      sched.guard(rt, t);
      sched.end(rt, t);
    }
    const seq = sched.sequence();
    expect(seq.length).toBe(5);
    // 60 stamps total — last 5 are tail.
    expect(seq[0]!.turn).toBeGreaterThanOrEqual(18);
    // server_tick keeps growing — it is NOT bounded.
    expect(sched.next_server_tick()).toBe(60);
  });

  it('BUG-14: default unbounded (existing behavior preserved)', () => {
    const rt = freshRuntime('reg_uncap');
    const sched = createR67TickScheduler({ clock: createDeterministicMonotonicClock(0n) });
    for (let t = 1; t <= 30; t++) {
      sched.begin(rt, t);
      sched.guard(rt, t);
      sched.end(rt, t);
    }
    expect(sched.sequence().length).toBe(90);
  });

  it('BUG-14: max_ledger_size = 0 treated as unbounded (defensive)', () => {
    const rt = freshRuntime('reg_zero_cap');
    const sched = createR67TickScheduler({
      clock: createDeterministicMonotonicClock(0n),
      max_ledger_size: 0,
    });
    for (let t = 1; t <= 20; t++) {
      sched.begin(rt, t);
      sched.guard(rt, t);
      sched.end(rt, t);
    }
    expect(sched.sequence().length).toBe(60);
  });
});
