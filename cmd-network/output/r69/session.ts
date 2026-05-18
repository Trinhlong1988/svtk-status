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
  type PacketEnvelope,
} from './packet_envelope.js';
import { ReplayCache } from './replay_cache.js';
import { SessionWindow, type AdmitResult } from './session_window.js';
import { buildAck, buildNack, type AckOrNack } from './ack_protocol.js';

export type InboundRejectReason =
  | 'malformed'
  | 'bad_signature'
  | 'stale'
  | 'unknown_category'
  | 'replay'
  | 'out_of_order'
  | 'window_full';

export interface InboundResult<P> {
  /** Forward to game logic if and only if `delivered === true`. */
  delivered: boolean;
  envelope?: PacketEnvelope<P>;
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
}

export class Session {
  private readonly secret: Buffer;
  readonly replay: ReplayCache;
  readonly window: SessionWindow;

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

    // Monotonic seq check for ORDERED categories (R69.2).
    if (spec.ordered && !this.replay.admitSeq(env.seq)) {
      return { delivered: false, rejectReason: 'out_of_order' };
    }

    // Window admission for RELIABLE categories that require ACK (R69.4 + R69.5).
    if (spec.reliable && spec.ackRequired) {
      const admit: AdmitResult = this.window.tryAdmit(env.seq);
      if (!admit.admitted) {
        return {
          delivered: false,
          response: buildNack(env.seq, admit.retryAfterMs, this.secret),
          rejectReason: 'window_full',
        };
      }
      return {
        delivered: true,
        envelope: env,
        response: buildAck(env.seq, this.secret),
      };
    }

    // Unreliable or no-ack-required: just deliver, no response.
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
  }
}
