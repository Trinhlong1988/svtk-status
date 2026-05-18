/**
 * COMPANION AFFINITY AUTO-SAVE — Phase 13 P2 #4 (CMD3).
 *
 * Subscriber-pattern wrapper around the frozen `CompanionAffinityStore` (Phase 12
 * §IV ownership lock — NO in-place mutation). Calls into the store via the
 * existing public API, then schedules a debounced persist callback so writes
 * batch instead of hitting the DB on every applyDelta.
 *
 * Why a wrapper:
 *   - Phase 12 froze CompanionAffinityStore; "save khi affinity change" requires
 *     an external observer, not a store-level side-effect.
 *   - Caller (server boot or save endpoint) passes in a `persist(questCharId)`
 *     adapter that bridges to companion_affinity_persistence.persistCompanionAffinityStore.
 *
 * Debounce semantics:
 *   - N changes within `debounceMs` (default 5000) → 1 persist call after the
 *     last change settles.
 *   - On persist failure → retry with exponential backoff up to `maxRetries`
 *     (default 3). Final failure surfaces via `onError` callback.
 *
 * Determinism: timers run via injectable `now`/`setTimeoutFn` for tests with
 * `vi.useFakeTimers()`.
 */
import type {
  CompanionAffinityStore,
} from './companion_affinity_store.js';
import type {
  AffinityApplyResult,
  AffinityDeltaContext,
} from './companion_progression_hook.js';
import type { QuestCharId } from './quest_types.js';

export const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 5_000;
export const DEFAULT_AUTOSAVE_MAX_RETRIES = 3;
export const DEFAULT_AUTOSAVE_RETRY_BASE_MS = 1_000;

export interface AutoSaveOptions {
  /** Debounce window — flush after this many ms of inactivity. Default 5000. */
  debounceMs?: number;
  /** Max retry attempts on persist failure. Default 3. */
  maxRetries?: number;
  /** Exponential backoff base. Attempt N waits `base * 2^(N-1)` ms. Default 1000. */
  retryBaseMs?: number;
  /** Called after `maxRetries` exhausted. */
  onError?: (questCharId: QuestCharId, err: unknown) => void;
  /** Override timer functions for deterministic tests. */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export type PersistFn = (questCharId: QuestCharId) => Promise<void>;

interface PendingFlush {
  timer: unknown;
  retries: number;
}

/**
 * Observer wrapper. Owns no store state — only timers + per-character pending
 * flushes. Pass-through `applyDelta` returns the underlying store result
 * unchanged so callers can swap the wrapper in transparently.
 */
export class CompanionAffinityAutoSaver {
  private readonly debounceMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly onError?: (q: QuestCharId, err: unknown) => void;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (h: unknown) => void;
  private readonly pending = new Map<QuestCharId, PendingFlush>();
  private disposed = false;

  constructor(
    private readonly store: CompanionAffinityStore,
    private readonly persist: PersistFn,
    opts: AutoSaveOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_AUTOSAVE_DEBOUNCE_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_AUTOSAVE_MAX_RETRIES;
    this.retryBaseMs = opts.retryBaseMs ?? DEFAULT_AUTOSAVE_RETRY_BASE_MS;
    if (opts.onError) this.onError = opts.onError;
    this.setTimeoutFn =
      opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms) as unknown);
    this.clearTimeoutFn =
      opts.clearTimeoutFn ??
      ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * Apply a delta + schedule a debounced flush when the change actually
   * mutated state (status ∈ {applied, tier_advanced, tier_demoted}). Duplicate
   * + no_change + cap-reached results do not trigger a flush.
   */
  applyDelta(ctx: AffinityDeltaContext): AffinityApplyResult {
    if (this.disposed) {
      throw new Error('CompanionAffinityAutoSaver disposed — cannot applyDelta');
    }
    const result = this.store.applyDelta(ctx);
    if (this.shouldFlush(result)) {
      this.scheduleFlush(ctx.char_id);
    }
    return result;
  }

  /**
   * Force immediate flush for a single character — cancels any pending timer.
   * Used at logout / shutdown to drain queued writes.
   */
  async flushNow(questCharId: QuestCharId): Promise<void> {
    const entry = this.pending.get(questCharId);
    if (entry) {
      this.clearTimeoutFn(entry.timer);
      this.pending.delete(questCharId);
    }
    await this.attemptPersist(questCharId, 0);
  }

  /**
   * Force flush every queued character. Returns when ALL queued persists
   * either succeed or exhaust retries.
   */
  async flushAll(): Promise<void> {
    const chars = [...this.pending.keys()];
    for (const c of chars) {
      await this.flushNow(c);
    }
  }

  /** Number of characters with a queued (not-yet-flushed) write. */
  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Stop scheduling new flushes + cancel pending timers. Idempotent. Does NOT
   * call `persist` — callers wanting durable shutdown should `await flushAll()`
   * first.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.pending.values()) {
      this.clearTimeoutFn(entry.timer);
    }
    this.pending.clear();
  }

  private shouldFlush(result: AffinityApplyResult): boolean {
    return (
      result.status === 'applied' ||
      result.status === 'tier_advanced' ||
      result.status === 'tier_demoted'
    );
  }

  private scheduleFlush(questCharId: QuestCharId): void {
    const existing = this.pending.get(questCharId);
    if (existing) this.clearTimeoutFn(existing.timer);
    const timer = this.setTimeoutFn(() => {
      this.pending.delete(questCharId);
      // Fire-and-forget — caller can await via flushNow / flushAll.
      // Error path handled inside attemptPersist via onError callback.
      void this.attemptPersist(questCharId, 0);
    }, this.debounceMs);
    this.pending.set(questCharId, { timer, retries: 0 });
  }

  private async attemptPersist(
    questCharId: QuestCharId,
    attempt: number,
  ): Promise<void> {
    try {
      await this.persist(questCharId);
    } catch (err) {
      if (attempt + 1 >= this.maxRetries) {
        this.onError?.(questCharId, err);
        return;
      }
      const delayMs = this.retryBaseMs * Math.pow(2, attempt);
      const timer = this.setTimeoutFn(() => {
        this.pending.delete(questCharId);
        void this.attemptPersist(questCharId, attempt + 1);
      }, delayMs);
      this.pending.set(questCharId, { timer, retries: attempt + 1 });
    }
  }
}
