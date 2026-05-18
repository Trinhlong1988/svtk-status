/**
 * BAN PIPELINE — Phase 13 Tuần 3 (CMD1).
 *
 * Receives `CombatDivergenceReport` from Layer 3 anti-cheat probe (server-side
 * comparator over `captureRunSnapshot`/`compareRunSnapshots`) and tracks a
 * per-actor sliding window of divergences. Emits a `BanEvent` whose severity
 * is determined by the count within the configured window:
 *
 *   1 divergence  → WARN
 *   3 / 60 turn   → SOFT_BAN     (brief CMD1 Tuần 3 threshold chốt)
 *   5 / 60 turn   → HARD_BAN
 *
 * Subscriber wire-point: CMD4 Tuần 3 `AlertRouter` subscribes via `subscribe()`
 * → Discord notify + flag-in-DB. CMD1 only emits — never touches transports.
 *
 * Layer 3 server-stateful per encounter-shard. Pure mutation on local Map; no
 * I/O. Replay-safe: same divergence sequence in → same ban-event sequence out
 * (deterministic clock injection optional via `BanPipelineDeps.clock`).
 *
 * EventBus wire (post_log phase) — `attachToEventBus(bus, opts)` registers a
 * wildcard listener at `EVENT_PRIORITY_GROUPS.anti_cheat` so future in-encounter
 * anomaly detectors can plug in without re-architecting (FIX #5 priority group).
 *
 * Wire-point hint (Mr.Long 2026-05-15 Tuần 3 trigger):
 *   import { makeJwtVerifierAdapter } from '../../api/auth_adapter.js'
 * khi expose HTTP endpoint cần verify ban-issuer actor identity. Pipeline core
 * không depend auth — verifier wired ở route handler layer.
 *
 * Hiến pháp:
 *   - mục 5.6 deterministic clock (currentClock().nowIso())
 *   - R31 Layer 3 server-stateful (NOT combat hot-path)
 *   - R33 wildcard listener post_log = OBSERVATION ONLY (read-only event)
 *   - § VI clock + sampling injection
 */
import { currentClock } from '../../logic/deterministic_clock.js';
import {
  EVENT_PRIORITY_GROUPS,
  makePriority,
  type CombatEvent,
  type EventBus,
} from '../../logic/event_bus.js';
import type {
  CombatDivergenceReport,
  DivergenceKind,
} from '../../logic/combat_divergence_diagnostics.js';

// ─────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────

export type BanSeverity = 'WARN' | 'SOFT_BAN' | 'HARD_BAN';

export interface BanEvent {
  readonly actorId: string;
  readonly severity: BanSeverity;
  /** Stable summary suitable for log/alert payload. */
  readonly reason: string;
  readonly divergenceKind: DivergenceKind;
  readonly turn: number;
  /** Divergence count inside the current sliding window (incl. this one). */
  readonly windowDivergenceCount: number;
  /** Deterministic clock timestamp (replay-safe when clock injected). */
  readonly timestampIso: string;
  /** Encounter pair surfaced by the diagnostic comparator. */
  readonly encounterA: string;
  readonly encounterB: string;
}

export interface BanPipelineConfig {
  readonly warnThreshold: number;
  readonly softBanThreshold: number;
  readonly hardBanThreshold: number;
  /** Sliding window size measured in combat turns. */
  readonly windowTurns: number;
}

export const DEFAULT_BAN_CONFIG: BanPipelineConfig = Object.freeze({
  warnThreshold: 1,
  softBanThreshold: 3,
  hardBanThreshold: 5,
  windowTurns: 60,
});

export interface DivergenceRecord {
  readonly turn: number;
  readonly kind: DivergenceKind;
  readonly summary: string;
}

export type BanEventHandler = (event: BanEvent) => void;

/**
 * Optional sink for subscriber-thrown errors. Called when a `BanEventHandler`
 * throws during dispatch; pipeline catches the throw to keep other subscribers
 * + the originating `recordDivergence` call intact (audit-B hardening).
 *
 * Sink ITSELF must not throw — pipeline swallows secondary errors silently.
 */
export type BanErrorSink = (err: unknown, event: BanEvent) => void;

export interface BanPipeline {
  /**
   * Record a divergence for an actor. Returns the emitted BanEvent when one
   * is dispatched to subscribers, or `null` for `none` kind / non-divergent
   * reports (still ignored — keeps caller-side branching ergonomic).
   */
  recordDivergence(
    actorId: string,
    currentTurn: number,
    report: CombatDivergenceReport,
  ): BanEvent | null;

  /** Subscribe for ban events. Returns disposer. */
  subscribe(handler: BanEventHandler): () => void;

  /** Read-only view of actor's window contents (post-prune). */
  getActorHistory(actorId: string): readonly DivergenceRecord[];

  /** Reset window. Pass actorId to clear one; omit to clear all. */
  reset(actorId?: string): void;

  /**
   * Attach a wildcard observer at `post_log` phase. Returns disposer.
   * Currently a no-op observation hook — reserved for in-encounter anomaly
   * scanners that will plug into the same pipeline without changing public
   * API. Brief Tuần 3 wire-point per `EVENT_PRIORITY_GROUPS.anti_cheat`.
   */
  attachToEventBus(bus: EventBus): () => void;
}

export interface BanPipelineDeps {
  readonly config?: Partial<BanPipelineConfig>;
  /** Inject deterministic clock for tests. Defaults to `currentClock()`. */
  readonly clock?: { nowIso(): string };
  /**
   * Optional sink for subscriber-thrown errors. Defaults to silent swallow.
   * Production caller wires CMD4 telemetry/log here when integrated.
   */
  readonly errorSink?: BanErrorSink;
}

export class BanPipelineError extends Error {
  constructor(message: string) {
    super(`[BanPipeline] ${message}`);
    this.name = 'BanPipelineError';
  }
}

// ─────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────

interface Window {
  records: DivergenceRecord[];
}

class BanPipelineImpl implements BanPipeline {
  private readonly cfg: BanPipelineConfig;
  private readonly clock: { nowIso(): string };
  private readonly errorSink?: BanErrorSink;
  private readonly windows = new Map<string, Window>();
  private readonly handlers = new Set<BanEventHandler>();

  constructor(deps: BanPipelineDeps) {
    const merged: BanPipelineConfig = {
      warnThreshold: deps.config?.warnThreshold ?? DEFAULT_BAN_CONFIG.warnThreshold,
      softBanThreshold:
        deps.config?.softBanThreshold ?? DEFAULT_BAN_CONFIG.softBanThreshold,
      hardBanThreshold:
        deps.config?.hardBanThreshold ?? DEFAULT_BAN_CONFIG.hardBanThreshold,
      windowTurns: deps.config?.windowTurns ?? DEFAULT_BAN_CONFIG.windowTurns,
    };
    BanPipelineImpl.validateConfig(merged);
    this.cfg = Object.freeze(merged);
    this.clock = deps.clock ?? currentClock();
    if (deps.errorSink) this.errorSink = deps.errorSink;
  }

  private static validateConfig(cfg: BanPipelineConfig): void {
    if (!Number.isInteger(cfg.warnThreshold) || cfg.warnThreshold < 1) {
      throw new BanPipelineError('warnThreshold must be integer >= 1');
    }
    if (!Number.isInteger(cfg.softBanThreshold) || cfg.softBanThreshold < 1) {
      throw new BanPipelineError('softBanThreshold must be integer >= 1');
    }
    if (!Number.isInteger(cfg.hardBanThreshold) || cfg.hardBanThreshold < 1) {
      throw new BanPipelineError('hardBanThreshold must be integer >= 1');
    }
    if (!Number.isInteger(cfg.windowTurns) || cfg.windowTurns < 1) {
      throw new BanPipelineError('windowTurns must be integer >= 1');
    }
    if (cfg.softBanThreshold < cfg.warnThreshold) {
      throw new BanPipelineError('softBanThreshold must be >= warnThreshold');
    }
    if (cfg.hardBanThreshold < cfg.softBanThreshold) {
      throw new BanPipelineError('hardBanThreshold must be >= softBanThreshold');
    }
  }

  recordDivergence(
    actorId: string,
    currentTurn: number,
    report: CombatDivergenceReport,
  ): BanEvent | null {
    if (!actorId || actorId.trim().length === 0) {
      throw new BanPipelineError('actorId must be non-empty');
    }
    if (!Number.isInteger(currentTurn) || currentTurn < 0) {
      throw new BanPipelineError('currentTurn must be non-negative integer');
    }
    // Non-divergent reports are NOT noise — caller can pipe every comparator
    // output without branching. Return null + drop silently.
    if (!report.divergent || report.kind === 'none') {
      return null;
    }

    const window = this.getOrCreate(actorId);
    // Prune records outside `(currentTurn - windowTurns, currentTurn]`.
    const cutoff = currentTurn - this.cfg.windowTurns;
    window.records = window.records.filter((r) => r.turn > cutoff);
    window.records.push({
      turn: currentTurn,
      kind: report.kind,
      summary: report.summary,
    });

    const count = window.records.length;
    const severity = this.classify(count);
    if (severity === null) return null;

    const event: BanEvent = Object.freeze({
      actorId,
      severity,
      reason: report.summary,
      divergenceKind: report.kind,
      turn: currentTurn,
      windowDivergenceCount: count,
      timestampIso: this.clock.nowIso(),
      encounterA: report.encounterA,
      encounterB: report.encounterB,
    });

    // Audit-B hardening: isolate subscriber faults. One handler throwing must
    // not skip the rest, and must not propagate up to the encounter loop that
    // produced the divergence. Secondary errorSink failures are also swallowed
    // — logging is best-effort.
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        if (this.errorSink) {
          try {
            this.errorSink(err, event);
          } catch {
            // intentional: sink failure is non-fatal, never re-throw
          }
        }
      }
    }
    return event;
  }

  subscribe(handler: BanEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  getActorHistory(actorId: string): readonly DivergenceRecord[] {
    const w = this.windows.get(actorId);
    if (!w) return [];
    return w.records.slice();
  }

  reset(actorId?: string): void {
    if (actorId === undefined) {
      this.windows.clear();
      return;
    }
    this.windows.delete(actorId);
  }

  attachToEventBus(bus: EventBus): () => void {
    // Reserved future hook — observation-only wildcard at anti_cheat priority.
    // Currently no in-encounter anomaly detection (CMD2 anti-bot owns that surface);
    // pipeline still registers a no-op listener so future scanners plug in via
    // the same priority group without API churn.
    const priority = makePriority('anti_cheat', 0);
    const noop = (_event: Readonly<CombatEvent>): void => {
      // Intentional no-op (per R33: post_log = observation only).
    };
    const dispose = bus.on('*', noop, { phase: 'post_log', priority });
    return dispose;
  }

  // ─────────────────────────────────────────────────────────
  // internals
  // ─────────────────────────────────────────────────────────

  private getOrCreate(actorId: string): Window {
    let w = this.windows.get(actorId);
    if (!w) {
      w = { records: [] };
      this.windows.set(actorId, w);
    }
    return w;
  }

  private classify(count: number): BanSeverity | null {
    if (count >= this.cfg.hardBanThreshold) return 'HARD_BAN';
    if (count >= this.cfg.softBanThreshold) return 'SOFT_BAN';
    if (count >= this.cfg.warnThreshold) return 'WARN';
    return null;
  }
}

/**
 * Construct a `BanPipeline`. See module docstring for wire-point examples.
 */
export function createBanPipeline(deps: BanPipelineDeps = {}): BanPipeline {
  return new BanPipelineImpl(deps);
}
