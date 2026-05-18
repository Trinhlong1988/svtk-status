/**
 * RECURSION GRAPH — chain telemetry + abort guard (FIX #8).
 *
 * Reflect → burn (DOT) → on-tick passive → reflect → ... loop nguy hiểm khi:
 *   - hệ effect chain depth > MAX_EFFECT_CHAIN_DEPTH
 *   - cùng listener fired N lần trong 1 root event
 *
 * Track:
 *   - root_event:    event đầu tiên trigger chain
 *   - current_event: event đang xử
 *   - parent_event:  ngay trước
 *   - listener:      ID listener
 *   - depth:         chain depth từ root
 *   - chain_path:    array of (event_type, listener) tuples (audit trail)
 *
 * Abort: khi depth >= MAX_EFFECT_CHAIN_DEPTH → throw RecursionAbortError + emit telemetry
 * recursion_abort severity=high.
 */
import { StatusConstants } from './status_constants.js';
import { recordStatusEvent } from './status_events.js';
import type { Telemetry } from '../server/telemetry.js';

export class RecursionAbortError extends Error {
  constructor(
    public readonly chainPath: ReadonlyArray<{ event: string; listener: string }>,
    public readonly depth: number,
  ) {
    super(
      `[RecursionAbort] depth=${depth} >= MAX (${StatusConstants.MAX_EFFECT_CHAIN_DEPTH}) ` +
      `chain=${chainPath.map((e) => `${e.event}@${e.listener}`).join(' → ')}`,
    );
    this.name = 'RecursionAbortError';
  }
}

export interface RecursionFrame {
  rootEvent: string;
  currentEvent: string;
  parentEvent: string | null;
  listener: string;
  depth: number;
  chainPath: ReadonlyArray<{ event: string; listener: string }>;
}

/**
 * Singleton tracker per encounter — caller create + pass to listener.
 * NOT global — would corrupt cross-encounter chain if shared.
 */
export class RecursionTracker {
  private depth = 0;
  private chainPath: { event: string; listener: string }[] = [];
  private rootEvent: string | null = null;
  private parentEvent: string | null = null;

  enter(eventType: string, listenerId: string): RecursionFrame {
    if (this.depth === 0) this.rootEvent = eventType;
    this.depth += 1;
    if (this.depth > StatusConstants.MAX_EFFECT_CHAIN_DEPTH) {
      const frozen = [...this.chainPath, { event: eventType, listener: listenerId }];
      throw new RecursionAbortError(frozen, this.depth);
    }
    this.chainPath.push({ event: eventType, listener: listenerId });
    const frame: RecursionFrame = {
      rootEvent: this.rootEvent ?? eventType,
      currentEvent: eventType,
      parentEvent: this.parentEvent,
      listener: listenerId,
      depth: this.depth,
      chainPath: [...this.chainPath],
    };
    this.parentEvent = eventType;
    return frame;
  }

  exit(): void {
    this.chainPath.pop();
    this.depth = Math.max(0, this.depth - 1);
    if (this.depth === 0) {
      this.rootEvent = null;
      this.parentEvent = null;
    } else {
      this.parentEvent = this.chainPath[this.chainPath.length - 1]?.event ?? null;
    }
  }

  /** Snapshot for telemetry. */
  snapshot(): { depth: number; chainPath: ReadonlyArray<{ event: string; listener: string }> } {
    return { depth: this.depth, chainPath: [...this.chainPath] };
  }
}

/**
 * Emit recursion_abort telemetry + re-throw — caller wrap dispatch trong try/catch.
 */
export function emitRecursionAbort(
  tel: Telemetry,
  encounterId: string,
  turn: number,
  err: RecursionAbortError,
): void {
  recordStatusEvent(tel, {
    encounterId,
    turn,
    kind: 'recursion_abort',
    severity: 'high',
    meta: {
      depth: err.depth,
      chainPath: err.chainPath,
      maxDepth: StatusConstants.MAX_EFFECT_CHAIN_DEPTH,
    },
  });
}
