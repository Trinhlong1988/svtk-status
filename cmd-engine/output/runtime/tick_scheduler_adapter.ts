/**
 * TICK SCHEDULER ADAPTER (R67) — wraps combat_runtime.ts tick semantics.
 *
 * Foundation v2.8.0 R67: every combat tick MUST be stamped with:
 *   - monotonic_ns: a strictly-increasing high-resolution nanosecond timestamp
 *     (replay-safe — derived from turn × phase to be deterministic by default).
 *   - server_tick:  a strictly-increasing sequence counter, server-authoritative.
 *
 * This adapter is STRICTLY ADDITIVE: it does NOT modify combat_runtime.ts.
 * It wraps `beginCombatTurn` / `tickAuraGuard` / `endCombatTurn` so each call
 * also emits an R67TickEvent into an ordered ledger.
 *
 * Determinism:
 *   - Default `deriveMonotonicNs` is a pure function of (turn, phase_index).
 *     Same encounter + same turn sequence → same monotonic_ns stream.
 *   - Inject `nowNs()` override for live wall-clock mode (production server).
 *
 * Server-authoritative pattern (5-layer architecture):
 *   - Layer 1 (server): owns this adapter. Stamps every tick BEFORE broadcast.
 *   - Layer 2 (network): forwards stamped events to clients.
 *   - Client: replays events verbatim — never generates stamps.
 */
import {
  type CombatRuntime,
  beginCombatTurn,
  endCombatTurn,
} from '../legacy/combat_runtime.js';
import { tickAuraGuard } from '../legacy/aura_propagation_guard.js';

// ─────────────────────────────────────────────────────────
// R67 event types
// ─────────────────────────────────────────────────────────

/** Phase of a single tick within a combat turn. */
export type R67TickPhase = 'begin' | 'aura_guard' | 'end';

/** R67 stamped event — one per phase call. */
export interface R67TickEvent {
  /** Monotonic high-resolution nanosecond timestamp. STRICTLY increasing within a session. */
  readonly monotonic_ns: bigint;
  /** Server-authoritative tick counter. STRICTLY increasing, 0-based. */
  readonly server_tick: number;
  /** Combat turn this phase belongs to (matches `CombatRuntime.currentTurn`). */
  readonly turn: number;
  /** Which lifecycle phase fired. */
  readonly phase: R67TickPhase;
  /** Encounter id pulled from runtime config (for cross-encounter audit). */
  readonly encounter_id: string;
}

// ─────────────────────────────────────────────────────────
// Clock injector
// ─────────────────────────────────────────────────────────

/** Source of monotonic_ns. Inject wall clock in prod, deterministic in test/replay. */
export interface MonotonicClock {
  /** Returns a strictly-increasing bigint nanosecond stamp. */
  now_ns(): bigint;
}

/**
 * Deterministic clock — derives monotonic_ns from (turn, phase_index, base_ns).
 * Same inputs → same outputs. Replay-safe.
 *
 *  - base_ns: offset (lets multiple deterministic clocks coexist with disjoint ranges).
 *  - phase_index: begin=0, aura_guard=1, end=2 — packs into low 2 bits.
 *  - turn: packs into bits [2..].
 *
 * Formula: ns = base_ns + (turn << 2 | phase_index) × QUANTUM_NS
 * QUANTUM_NS = 1000n (1 microsecond) to give plenty of headroom between turns.
 */
export interface DeterministicMonotonicClock extends MonotonicClock {
  readonly mode: 'deterministic';
  /** Advance internal pointer; called by adapter between phase emits. */
  step(turn: number, phase: R67TickPhase): bigint;
}

const QUANTUM_NS = 1000n;

const PHASE_INDEX: Readonly<Record<R67TickPhase, number>> = {
  begin: 0,
  aura_guard: 1,
  end: 2,
};

export function createDeterministicMonotonicClock(
  base_ns: bigint = 0n,
): DeterministicMonotonicClock {
  let last: bigint = base_ns - 1n;
  return {
    mode: 'deterministic',
    now_ns(): bigint {
      // Direct call without phase context: just bump by 1 quantum.
      last += QUANTUM_NS;
      return last;
    },
    step(turn: number, phase: R67TickPhase): bigint {
      const slot = (BigInt(turn) << 2n) | BigInt(PHASE_INDEX[phase]);
      const stamp = base_ns + slot * QUANTUM_NS;
      // Enforce strict monotonicity even if caller invokes phases out of order.
      if (stamp <= last) {
        last += 1n;
        return last;
      }
      last = stamp;
      return stamp;
    },
  };
}

/**
 * Wall clock — production. Uses `process.hrtime.bigint()` when available
 * (Node ≥ 10.7), else falls back to Date.now() × 1_000_000.
 *
 * Monotonicity is enforced — if the underlying source ever returns a stamp
 * ≤ the previous one (e.g. clock skew), bump by 1 ns.
 */
export function createWallMonotonicClock(): MonotonicClock {
  const hr = (globalThis as { process?: { hrtime?: { bigint?: () => bigint } } })
    .process?.hrtime?.bigint;
  let last: bigint = 0n;
  return {
    now_ns(): bigint {
      const raw = hr ? hr() : BigInt(Date.now()) * 1_000_000n;
      if (raw <= last) {
        last += 1n;
        return last;
      }
      last = raw;
      return raw;
    },
  };
}

// ─────────────────────────────────────────────────────────
// Scheduler state
// ─────────────────────────────────────────────────────────

export interface R67TickScheduler {
  /** Wrap `beginCombatTurn` + emit R67 'begin' event. */
  begin(rt: CombatRuntime, turn: number): R67TickEvent;
  /** Stand-alone aura-guard tick (covers `beginCombatTurn` callers that need to re-tick). */
  guard(rt: CombatRuntime, turn: number): R67TickEvent;
  /** Wrap `endCombatTurn` + emit R67 'end' event. */
  end(rt: CombatRuntime, turn: number): R67TickEvent;
  /** Ordered ledger of every emitted event since scheduler creation. */
  sequence(): readonly R67TickEvent[];
  /** Current server tick counter (next value to be assigned). */
  next_server_tick(): number;
}

export interface R67TickSchedulerConfig {
  /**
   * Clock source. Defaults to a deterministic clock with base_ns = 0.
   * Pass `createWallMonotonicClock()` for live server.
   */
  clock?: MonotonicClock | DeterministicMonotonicClock;
}

/**
 * Validate turn input — R67 requires non-negative finite integer.
 * Matches ReplayFrameSchema constraint `turn: z.number().int().nonnegative()`.
 */
function assertValidTurn(turn: number): void {
  if (!Number.isInteger(turn) || turn < 0) {
    throw new RangeError(
      `R67TickScheduler: turn must be a non-negative integer, got ${turn}`,
    );
  }
}

export function createR67TickScheduler(
  config: R67TickSchedulerConfig = {},
): R67TickScheduler {
  const clock = config.clock ?? createDeterministicMonotonicClock(0n);
  const ledger: R67TickEvent[] = [];
  let server_tick = 0;

  function isDeterministic(c: MonotonicClock | DeterministicMonotonicClock): c is DeterministicMonotonicClock {
    return (c as DeterministicMonotonicClock).mode === 'deterministic';
  }

  function stamp(turn: number, phase: R67TickPhase, encounter_id: string): R67TickEvent {
    const monotonic_ns = isDeterministic(clock)
      ? clock.step(turn, phase)
      : clock.now_ns();
    const ev: R67TickEvent = {
      monotonic_ns,
      server_tick,
      turn,
      phase,
      encounter_id,
    };
    server_tick += 1;
    ledger.push(ev);
    return ev;
  }

  return {
    begin(rt: CombatRuntime, turn: number): R67TickEvent {
      assertValidTurn(turn);
      beginCombatTurn(rt, turn);
      return stamp(turn, 'begin', rt.config.encounterId);
    },
    guard(rt: CombatRuntime, turn: number): R67TickEvent {
      assertValidTurn(turn);
      tickAuraGuard(rt.auraGuard, turn);
      return stamp(turn, 'aura_guard', rt.config.encounterId);
    },
    end(rt: CombatRuntime, turn: number): R67TickEvent {
      assertValidTurn(turn);
      endCombatTurn(rt, turn);
      return stamp(turn, 'end', rt.config.encounterId);
    },
    sequence(): readonly R67TickEvent[] {
      // Return frozen snapshot — internal ledger is private. Prevents external
      // mutation that would corrupt subsequent sequence() reads.
      return Object.freeze(ledger.slice());
    },
    next_server_tick(): number {
      return server_tick;
    },
  };
}
