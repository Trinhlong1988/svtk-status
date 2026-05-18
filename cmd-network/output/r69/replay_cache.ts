/**
 * R69 Replay Cache — SVTK Foundation v2.8.0
 *
 * Per-session bounded nonce ring (R66.3 anti-replay):
 *   - Track last `capacity` nonces (default 10_000)
 *   - has(nonce) → already seen → drop packet
 *   - admit(nonce) → record; if full, evict oldest
 *   - Monotonic seq tracking (R69.2): rejects seq ≤ lastSeq for ORDERED categories
 *
 * THREAD/ASYNC SAFETY (audit bug#20 — caller pattern):
 *   All methods are synchronous and Node single-thread is atomic per call.
 *   HOWEVER, caller patterns like:
 *       if (!cache.has(nonce)) { await someAsync(); cache.admit(nonce); }
 *   create a TOCTOU window across the await. ALWAYS use `checkAndAdmit()`
 *   instead of `has()+admit()` for replay-safety.
 *
 * NOTE: in-memory only. R66.3 Gap 1 (persistent replay_cache via Redis/PG)
 *       deferred to runtime svtk_runtime v2.6.5+. Foundation defines rule;
 *       this implementation gives bounded volatile cache.
 */

export interface ReplayCacheParams {
  capacity?: number;
}

export class ReplayCache {
  private readonly capacity: number;
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private lastSeq = -1;

  /** Default capacity 10_000 per session (R66.3 spec). Throws if not positive integer. */
  constructor(params: ReplayCacheParams = {}) {
    this.capacity = params.capacity ?? 10_000;
    if (!Number.isInteger(this.capacity) || this.capacity < 1) {
      // Hardened (audit bug#12/#13): NaN/Infinity/0.5 previously passed the `<= 0` guard.
      throw new Error(`replay_cache: capacity must be a positive integer (got ${this.capacity})`);
    }
  }

  /** Returns true if `nonce` has been admitted in the current session window. */
  has(nonce: string): boolean {
    if (typeof nonce !== 'string' || nonce.length === 0) return false;
    return this.seen.has(nonce);
  }

  /**
   * Records `nonce`. Evicts oldest when full. No-op if already present.
   * Returns false if nonce is invalid (empty or non-string — audit bug#10/#11).
   */
  admit(nonce: string): boolean {
    if (typeof nonce !== 'string' || nonce.length === 0) return false;
    if (this.seen.has(nonce)) return true; // already admitted, idempotent OK
    this.seen.add(nonce);
    this.order.push(nonce);
    if (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
    return true;
  }

  /**
   * Check + admit in one call.
   * Returns true if nonce was new (caller should proceed),
   * false if it was a replay OR invalid input (caller should drop the packet).
   */
  checkAndAdmit(nonce: string): boolean {
    if (typeof nonce !== 'string' || nonce.length === 0) return false;
    if (this.seen.has(nonce)) return false;
    this.admit(nonce);
    return true;
  }

  /**
   * Monotonic sequence check for ORDERED categories (R69.2).
   * Returns true if seq is a non-negative finite integer strictly greater than lastSeq.
   * Returns false on duplicate, out-of-order, NaN, Infinity, negative, or non-integer
   * (audit bug#8/#9/#14 — NaN previously broke monotonic, Infinity caused DoS).
   */
  admitSeq(seq: number): boolean {
    if (!Number.isInteger(seq) || seq < 0) return false;
    if (seq <= this.lastSeq) return false;
    this.lastSeq = seq;
    return true;
  }

  /** R69.6 — reset on reconnect / session close. */
  reset(): void {
    this.seen.clear();
    this.order.length = 0;
    this.lastSeq = -1;
  }

  size(): number {
    return this.seen.size;
  }

  getLastSeq(): number {
    return this.lastSeq;
  }
}
