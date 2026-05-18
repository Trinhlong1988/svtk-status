/**
 * R69 Replay Cache — SVTK Foundation v2.8.0
 *
 * Per-session bounded nonce ring (R66.3 anti-replay):
 *   - Track last `capacity` nonces (default 10_000)
 *   - has(nonce) → already seen → drop packet
 *   - admit(nonce) → record; if full, evict oldest
 *   - Monotonic seq tracking (R69.2): rejects seq ≤ lastSeq for ORDERED categories
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

  /** Default capacity 10_000 per session (R66.3 spec). Throws if ≤ 0. */
  constructor(params: ReplayCacheParams = {}) {
    this.capacity = params.capacity ?? 10_000;
    if (this.capacity <= 0) throw new Error('replay_cache: capacity must be > 0');
  }

  /** Returns true if `nonce` has been admitted in the current session window. */
  has(nonce: string): boolean {
    return this.seen.has(nonce);
  }

  /** Records `nonce`. Evicts oldest when full. No-op if already present. */
  admit(nonce: string): void {
    if (this.seen.has(nonce)) return;
    this.seen.add(nonce);
    this.order.push(nonce);
    if (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
  }

  /**
   * Check + admit in one call.
   * Returns true if nonce was new (caller should proceed),
   * false if it was a replay (caller should drop the packet).
   */
  checkAndAdmit(nonce: string): boolean {
    if (this.seen.has(nonce)) return false;
    this.admit(nonce);
    return true;
  }

  /**
   * Monotonic sequence check for ORDERED categories (R69.2).
   * Returns true if seq is strictly greater than lastSeq (caller proceeds).
   * Returns false on duplicate or out-of-order.
   */
  admitSeq(seq: number): boolean {
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
