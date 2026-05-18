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
