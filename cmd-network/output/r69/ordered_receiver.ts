/**
 * R69.2 Ordered Receiver — Foundation v2.8.0 buffering semantics.
 *
 * Foundation explicit: "Ordered: buffer cho đến khi sequence liền trước đến"
 * (audit bug#39 fix — previously em dropped out-of-order packets which is
 * compliant with the "duplicate" rule but VIOLATES the "out-of-order" rule).
 *
 * Behavior per Foundation R69.2:
 *   - seq < expectedNext      → DROP (duplicate / replay)
 *   - seq === expectedNext    → DELIVER + drain consecutive buffered seqs
 *   - seq > expectedNext      → BUFFER (until predecessor arrives)
 *   - buffer overflow         → DROP newest (caller signals backpressure)
 *
 * Usage: one OrderedReceiver per (session × ordered+reliable category).
 * Unreliable+ordered categories (movement) keep using the simpler
 * ReplayCache.admitSeq "newer overrides older" path — that's Foundation
 * compliant for movement too ("Unordered: process immediately" + the
 * movement spec "Newer overrides older").
 */

export interface OrderedReceiverParams<T> {
  /** Initial expected sequence number. Default 0. */
  initialSeq?: number;
  /**
   * Max buffered out-of-order seqs. Default 64. When full, new seqs
   * beyond `expectedNext` are dropped (caller can NACK with retry hint).
   */
  bufferLimit?: number;
  /** Optional payload type discriminator — type-only, runtime no-op. */
  _phantom?: T;
}

export interface ReceiveResult<T> {
  /** Payloads ready to be processed, IN ORDER. May be empty. */
  delivered: T[];
  /** True if the incoming seq was dropped as duplicate (seq < expectedNext). */
  duplicate: boolean;
  /** True if the incoming seq was buffered (gap from expectedNext, not yet deliverable). */
  buffered: boolean;
  /** True if buffer was full and the incoming seq was dropped. */
  overflow: boolean;
}

export class OrderedReceiver<T> {
  private expectedNext: number;
  private readonly bufferLimit: number;
  private readonly buffer = new Map<number, T>();

  constructor(params: OrderedReceiverParams<T> = {}) {
    const init = params.initialSeq ?? 0;
    if (!Number.isInteger(init) || init < 0) {
      throw new RangeError(`OrderedReceiver: initialSeq must be non-negative integer (got ${init})`);
    }
    const bl = params.bufferLimit ?? 64;
    if (!Number.isInteger(bl) || bl < 1) {
      throw new RangeError(`OrderedReceiver: bufferLimit must be positive integer (got ${bl})`);
    }
    this.expectedNext = init;
    this.bufferLimit = bl;
  }

  /**
   * Submit a packet with sequence number `seq` and payload `payload`.
   * Returns 0..N payloads that can now be processed in-order.
   */
  receive(seq: number, payload: T): ReceiveResult<T> {
    if (!Number.isInteger(seq) || seq < 0 || seq > Number.MAX_SAFE_INTEGER) {
      return { delivered: [], duplicate: false, buffered: false, overflow: false };
    }
    if (seq < this.expectedNext || this.buffer.has(seq)) {
      return { delivered: [], duplicate: true, buffered: false, overflow: false };
    }
    if (seq === this.expectedNext) {
      const delivered: T[] = [payload];
      this.expectedNext += 1;
      // Drain any contiguous buffered seqs.
      while (this.buffer.has(this.expectedNext)) {
        const next = this.buffer.get(this.expectedNext) as T;
        this.buffer.delete(this.expectedNext);
        delivered.push(next);
        this.expectedNext += 1;
      }
      return { delivered, duplicate: false, buffered: false, overflow: false };
    }
    // seq > expectedNext — buffer the gap.
    if (this.buffer.size >= this.bufferLimit) {
      return { delivered: [], duplicate: false, buffered: false, overflow: true };
    }
    this.buffer.set(seq, payload);
    return { delivered: [], duplicate: false, buffered: true, overflow: false };
  }

  /** R69.6 — reset on reconnect / session close. */
  reset(): void {
    this.expectedNext = 0;
    this.buffer.clear();
  }

  getExpectedNext(): number {
    return this.expectedNext;
  }

  getBufferSize(): number {
    return this.buffer.size;
  }

  /** Snapshot buffered seqs (sorted asc) — for diagnostics. */
  bufferedSeqs(): number[] {
    return [...this.buffer.keys()].sort((a, b) => a - b);
  }
}
