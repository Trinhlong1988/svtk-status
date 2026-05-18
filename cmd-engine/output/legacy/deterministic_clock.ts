/**
 * DETERMINISTIC CLOCK — replay-safe timestamp source (Phase 11 follow-on).
 *
 * Per CMD1.docx Phase 11 § VI: "same replay = same result ALWAYS."
 *
 * Existing telemetry callers (status_events / threat_events / action_lock /
 * threat_snapshot_serializer) use `new Date().toISOString()` as DEFAULT param.
 * That works for live runtime but produces drift in replay-from-events.
 *
 * STRICT additive — this module provides a **clock injector** that REPLACES
 * Date.now() WITHOUT modifying any existing file. Caller hands the injector
 * to callsites that need deterministic timestamps (replay / test fixtures);
 * legacy callers continue with wall-clock Date.
 *
 * 3 clock modes:
 *
 *   - 'wall' (default)        : real Date.now() — live runtime
 *   - 'replay'                : caller supplies recorded timestamps verbatim
 *   - 'turn-derived'          : `${encounterId}@t${turn}` — same encounter +
 *                               same turn → same timestamp (zero drift)
 *
 * Pattern:
 *   ```
 *   const clock = createTurnDerivedClock('enc_1');
 *   clock.tickTurn(5);
 *   const ts = clock.nowIso();   // 'turn-derived-enc_1-t5'
 *   ```
 */

// ─────────────────────────────────────────────────────────
// Clock interface
// ─────────────────────────────────────────────────────────

export interface DeterministicClock {
  readonly mode: 'wall' | 'replay' | 'turn-derived';
  nowIso(): string;
  /** Optionally advance to a specific turn (for turn-derived / replay modes). */
  tickTurn?(turn: number): void;
}

// ─────────────────────────────────────────────────────────
// Wall clock (default — live runtime, NOT replay-safe)
// ─────────────────────────────────────────────────────────

export function createWallClock(): DeterministicClock {
  return {
    mode: 'wall',
    nowIso(): string {
      // eslint-disable-next-line no-restricted-syntax
      return new Date().toISOString();
    },
  };
}

// ─────────────────────────────────────────────────────────
// Turn-derived clock (recommended for replay-safe telemetry)
// ─────────────────────────────────────────────────────────

export interface TurnDerivedClockState {
  encounterId: string;
  currentTurn: number;
}

export function createTurnDerivedClock(encounterId: string): DeterministicClock & TurnDerivedClockState {
  const state: TurnDerivedClockState & { mode: 'turn-derived' } = {
    encounterId,
    currentTurn: 0,
    mode: 'turn-derived',
  };
  return {
    ...state,
    get mode(): 'turn-derived' { return 'turn-derived'; },
    nowIso(): string {
      return `t:${state.encounterId}@${state.currentTurn}`;
    },
    tickTurn(turn: number): void {
      state.currentTurn = turn;
    },
    get encounterId(): string { return state.encounterId; },
    get currentTurn(): number { return state.currentTurn; },
  } as DeterministicClock & TurnDerivedClockState;
}

// ─────────────────────────────────────────────────────────
// Replay clock (recorded timestamps)
// ─────────────────────────────────────────────────────────

export function createReplayClock(
  timestamps: readonly string[],
): DeterministicClock & { remaining(): number; consumed(): number } {
  const queue = timestamps.slice();
  let idx = 0;
  return {
    mode: 'replay',
    nowIso(): string {
      const ts = queue[idx];
      if (ts === undefined) {
        throw new Error(`[ReplayClock] exhausted timestamps at index ${idx}; recorded ${timestamps.length}`);
      }
      idx += 1;
      return ts;
    },
    remaining(): number { return queue.length - idx; },
    consumed(): number { return idx; },
  };
}

// ─────────────────────────────────────────────────────────
// Module singleton — caller may swap mid-encounter for tests
// ─────────────────────────────────────────────────────────

/**
 * Global injectable clock. Defaults to wall clock.
 *
 * Production caller (server orchestration) may install a turn-derived clock
 * via `installClock()` at encounter boot to make ALL telemetry timestamps
 * deterministic. The existing callsites continue using `new Date()` (default
 * param) UNLESS the caller passes the clock's `nowIso()` result explicitly.
 *
 * Recommended pattern: leave wall clock as default; for replay tests use:
 *   ```
 *   const tdc = createTurnDerivedClock('enc');
 *   tdc.tickTurn(5);
 *   recordStatusEvent(tel, { ... }, tdc.nowIso());   // explicit override
 *   ```
 */
let _installed: DeterministicClock = createWallClock();
let _deterministicMode = false;

export function installClock(clock: DeterministicClock): void {
  _installed = clock;
}

/**
 * Enable/disable deterministic mode. When ON, `currentClock()` THROWS if the
 * installed clock is wall-clock — blocking accidental wall-clock fallback in
 * replay/orchestration paths (per CMD1 PHASE 11B FINALIZATION § VI rule
 * "FORBID wall-clock fallback").
 *
 * Orchestrator owns lifecycle: ON at encounter_start, OFF at finalize.
 */
export function setDeterministicMode(on: boolean): void {
  _deterministicMode = on;
}

export function isDeterministicMode(): boolean {
  return _deterministicMode;
}

export class WallClockFallbackForbiddenError extends Error {
  constructor() {
    super('[DeterministicClock] FORBIDDEN: wall-clock fallback during deterministic runtime. Install turn-derived or replay clock before encounter_start.');
    this.name = 'WallClockFallbackForbiddenError';
  }
}

/**
 * Return currently installed clock. Throws `WallClockFallbackForbiddenError`
 * if `setDeterministicMode(true)` is active AND the installed clock is still
 * wall-clock — caller forgot to `installClock(createTurnDerivedClock(...))`.
 */
export function currentClock(): DeterministicClock {
  if (_deterministicMode && _installed.mode === 'wall') {
    throw new WallClockFallbackForbiddenError();
  }
  return _installed;
}

export function resetToWallClock(): void {
  _installed = createWallClock();
  _deterministicMode = false;
}

/** Convenience — returns ISO string using currently installed clock. */
export function nowIso(): string {
  return currentClock().nowIso();
}
