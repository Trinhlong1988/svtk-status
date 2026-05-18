/**
 * R69.5 Sliding Window — SVTK Foundation v2.8.0
 *
 * Per-session bounded set of un-ACKed reliable packet sequence numbers.
 * Foundation default = 50 unACKed; over that, server replies NACK with
 * retryAfterMs hint instead of processing.
 *
 * Single-thread atomic: each public method is sync and self-contained.
 * Caller must NOT split `tryAdmit() + ack()` across await boundaries (see
 * ReplayCache JSDoc for the same TOCTOU guidance — audit bug#20).
 */

export interface SessionWindowParams {
  /** Max number of un-ACKed reliable packets in flight per session. Default 50 (Foundation R69.5). */
  windowSize?: number;
  /** Multiplier for retryAfterMs hint when window is full. Default: 50ms × pending. */
  retryHintPerPendingMs?: number;
}

export interface AdmitResult {
  admitted: boolean;
  /** When admitted=false, suggested retry-after for NACK (R69.4 + R69.5 link). */
  retryAfterMs: number;
  /** Pending unacked count BEFORE this attempt (so observers can plot pressure). */
  pendingBefore: number;
}

export class SessionWindow {
  private readonly windowSize: number;
  private readonly retryHintPerPendingMs: number;
  private readonly pending = new Set<number>();

  constructor(params: SessionWindowParams = {}) {
    const ws = params.windowSize ?? 50;
    if (!Number.isInteger(ws) || ws < 1) {
      throw new RangeError(`SessionWindow: windowSize must be positive integer (got ${ws})`);
    }
    const hint = params.retryHintPerPendingMs ?? 50;
    if (!Number.isFinite(hint) || hint < 0) {
      throw new RangeError(`SessionWindow: retryHintPerPendingMs must be non-negative finite`);
    }
    this.windowSize = ws;
    this.retryHintPerPendingMs = hint;
  }

  /**
   * Atomic check-and-admit a sequence into the unACKed set.
   * Returns admitted=true if room available; admitted=false + retryAfterMs hint if full.
   * If seq is already pending (duplicate), returns admitted=false (caller dedup'd already).
   */
  tryAdmit(seq: number): AdmitResult {
    if (!Number.isInteger(seq) || seq < 0 || seq > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(
        `tryAdmit: seq must be integer in [0, MAX_SAFE_INTEGER] (got ${seq})`,
      );
    }
    const pendingBefore = this.pending.size;
    if (this.pending.has(seq)) {
      // Duplicate in-flight — treat as backpressure rather than silently accept.
      return { admitted: false, retryAfterMs: this.retryHintPerPendingMs, pendingBefore };
    }
    if (pendingBefore >= this.windowSize) {
      const hint = Math.max(1, Math.floor(this.retryHintPerPendingMs * pendingBefore));
      return { admitted: false, retryAfterMs: hint, pendingBefore };
    }
    this.pending.add(seq);
    return { admitted: true, retryAfterMs: 0, pendingBefore };
  }

  /**
   * Mark `seq` as ACKed by the client (server-side bookkeeping when ACK lands).
   * Returns true if seq was pending (now removed), false if seq was unknown.
   */
  ack(seq: number): boolean {
    if (!Number.isInteger(seq) || seq < 0) return false;
    return this.pending.delete(seq);
  }

  /** Current count of in-flight unACKed packets. */
  pendingCount(): number {
    return this.pending.size;
  }

  /** Snapshot of pending seqs (sorted ascending) — for debug / dashboard. */
  pendingSnapshot(): number[] {
    return [...this.pending].sort((a, b) => a - b);
  }

  /** R69.6 — reset on reconnect / session close. */
  reset(): void {
    this.pending.clear();
  }

  /** True if the window is at capacity. */
  isFull(): boolean {
    return this.pending.size >= this.windowSize;
  }

  /** Max allowed unACKed (Foundation default 50). */
  getWindowSize(): number {
    return this.windowSize;
  }
}
