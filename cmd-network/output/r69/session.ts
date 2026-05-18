/**
 * R69 Session Orchestrator — Tuần 4 final wiring.
 *
 * Combines the four R69 primitives into one server-side session boundary:
 *   - packet_envelope (R69.1/3 + R66.3 sig)        → cryptographic input gate
 *   - replay_cache     (R69.2/6 + R66.3 nonce ring) → dedupe + monotonic seq
 *   - ack_protocol     (R69.4)                      → response semantics
 *   - session_window   (R69.5)                      → backpressure
 *
 * Each inbound packet flows through this single `inbound()` entry which
 * returns either a delivery decision (forward to game logic) or an
 * ACK/NACK envelope to send back to the client.
 */

import {
  openEnvelope,
  PACKET_CATEGORY_SPEC,
  type PacketCategory,
  type PacketEnvelope,
} from './packet_envelope.js';
import { ReplayCache } from './replay_cache.js';
import { SessionWindow, type AdmitResult } from './session_window.js';
import { buildAck, buildNack, type AckOrNack } from './ack_protocol.js';
import { OrderedReceiver } from './ordered_receiver.js';

export type InboundRejectReason =
  | 'malformed'
  | 'bad_signature'
  | 'stale'
  | 'unknown_category'
  | 'replay'
  | 'out_of_order'
  | 'buffered'
  | 'window_full';

export interface InboundResult<P> {
  /** Forward to game logic if and only if `delivered === true`. */
  delivered: boolean;
  /** Primary envelope delivered (only first if multiple drained from buffer). */
  envelope?: PacketEnvelope<P>;
  /**
   * For reliable+ordered categories, multiple envelopes may drain from the
   * out-of-order buffer (audit bug#39 — Foundation R69.2 "buffer cho đến khi
   * sequence liền trước đến"). Includes `envelope` first if delivered.
   */
  drained?: Array<PacketEnvelope<P>>;
  /** Response to send back to client (ACK on success, NACK on backpressure, nothing on hard reject). */
  response?: AckOrNack;
  /** Why the packet was rejected, if delivered=false. */
  rejectReason?: InboundRejectReason;
}

export interface SessionParams {
  sessionSecret: Buffer;
  replayCapacity?: number;
  windowSize?: number;
  retryHintPerPendingMs?: number;
  /** Out-of-order buffer per (reliable+ordered) category. Default 64. */
  orderedBufferLimit?: number;
}

export class Session {
  private readonly secret: Buffer;
  readonly replay: ReplayCache;
  readonly window: SessionWindow;
  /** Per-category OrderedReceiver for reliable+ordered categories (R69.2 buffering). */
  private readonly orderedReceivers: Partial<
    Record<PacketCategory, OrderedReceiver<PacketEnvelope<unknown>>>
  > = {};
  private readonly orderedBufferLimit: number;

  constructor(p: SessionParams) {
    if (!Buffer.isBuffer(p.sessionSecret) || p.sessionSecret.length < 32) {
      throw new TypeError('Session: sessionSecret must be Buffer ≥ 32 bytes');
    }
    this.secret = p.sessionSecret;
    this.replay = new ReplayCache({ capacity: p.replayCapacity });
    this.window = new SessionWindow({
      windowSize: p.windowSize,
      retryHintPerPendingMs: p.retryHintPerPendingMs,
    });
    this.orderedBufferLimit = p.orderedBufferLimit ?? 64;
  }

  private getOrderedReceiver<P>(
    cat: PacketCategory,
  ): OrderedReceiver<PacketEnvelope<P>> {
    let r = this.orderedReceivers[cat] as
      | OrderedReceiver<PacketEnvelope<P>>
      | undefined;
    if (!r) {
      r = new OrderedReceiver<PacketEnvelope<P>>({ bufferLimit: this.orderedBufferLimit });
      this.orderedReceivers[cat] = r as OrderedReceiver<PacketEnvelope<unknown>>;
    }
    return r;
  }

  /**
   * Process one inbound packet end-to-end. Returns delivery decision +
   * optional ACK/NACK to send back. NEVER throws on attacker input — all
   * failure paths return structured results.
   */
  inbound<P>(envelope: PacketEnvelope<P>, serverNowMs: number): InboundResult<P> {
    const opened = openEnvelope<P>({ envelope, sessionSecret: this.secret, serverNowMs });
    if (!opened.ok) {
      // Hard reject — no ACK/NACK back (don't leak that secret is misconfigured).
      return { delivered: false, rejectReason: opened.reason };
    }
    const env = opened.envelope;
    const spec = PACKET_CATEGORY_SPEC[env.category];

    // Anti-replay nonce check (R66.3).
    if (!this.replay.checkAndAdmit(env.nonce)) {
      return { delivered: false, rejectReason: 'replay' };
    }

    // Reliable+ordered (combat_action, trade_confirm) — use OrderedReceiver
    // buffering per Foundation R69.2 (audit bug#39 fix).
    if (spec.reliable && spec.ordered && spec.ackRequired) {
      // Window admission first — protect server resources before buffering.
      const admit: AdmitResult = this.window.tryAdmit(env.seq);
      if (!admit.admitted) {
        return {
          delivered: false,
          response: buildNack(env.seq, admit.retryAfterMs, this.secret, serverNowMs),
          rejectReason: 'window_full',
        };
      }
      const recv = this.getOrderedReceiver<P>(env.category);
      const result = recv.receive(env.seq, env);
      if (result.duplicate) {
        // Already saw this seq — free the window slot we just allocated and drop.
        this.window.ack(env.seq);
        return { delivered: false, rejectReason: 'replay' };
      }
      if (result.overflow) {
        this.window.ack(env.seq);
        return {
          delivered: false,
          response: buildNack(env.seq, 1_000, this.secret, serverNowMs),
          rejectReason: 'window_full',
        };
      }
      if (result.buffered) {
        // Wait for predecessor. ACK the receipt so client doesn't retransmit;
        // the gap will be filled when the missing seq arrives.
        return {
          delivered: false,
          response: buildAck(env.seq, this.secret, serverNowMs),
          rejectReason: 'buffered',
        };
      }
      // result.delivered has 1+ envelopes ready in order.
      const drained = result.delivered;
      return {
        delivered: true,
        envelope: drained[0],
        drained,
        response: buildAck(env.seq, this.secret, serverNowMs),
      };
    }

    // Unreliable+ordered (movement) — keep "newer overrides older" via
    // ReplayCache.admitSeq (Foundation R69.1 movement spec).
    if (spec.ordered && !this.replay.admitSeq(env.seq)) {
      return { delivered: false, rejectReason: 'out_of_order' };
    }

    // Reliable+unordered (chat_message) — window admission, ACK, but no
    // ordering buffer (R69.1 chat_message: "OK out of order").
    if (spec.reliable && spec.ackRequired) {
      const admit: AdmitResult = this.window.tryAdmit(env.seq);
      if (!admit.admitted) {
        return {
          delivered: false,
          response: buildNack(env.seq, admit.retryAfterMs, this.secret, serverNowMs),
          rejectReason: 'window_full',
        };
      }
      return {
        delivered: true,
        envelope: env,
        response: buildAck(env.seq, this.secret, serverNowMs),
      };
    }

    // Unreliable + no-ack-required (ping_heartbeat, movement): deliver only.
    return { delivered: true, envelope: env };
  }

  /** Server side: client ACK landed — free the window slot. */
  onClientAck(seq: number): boolean {
    return this.window.ack(seq);
  }

  /** R69.6 — reset on reconnect or session close. */
  reset(): void {
    this.replay.reset();
    this.window.reset();
    for (const cat of Object.keys(this.orderedReceivers) as PacketCategory[]) {
      this.orderedReceivers[cat]?.reset();
    }
  }
}
