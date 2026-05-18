/**
 * R69.4 ACK Protocol — SVTK Foundation v2.8.0
 *
 * Server-to-client acknowledgement envelope. For reliable packet categories
 * (combat_action / chat_message / trade_confirm — see PACKET_CATEGORY_SPEC),
 * every processed packet emits an ACK. On overflow (sliding window full —
 * R69.5) the server emits NACK with a retry-after hint instead.
 *
 * Wire format (intentionally minimal — distinct from PacketEnvelope):
 *   ACK  : { kind: 'ack',  seq, status: 'processed' }
 *   NACK : { kind: 'nack', seq, retryAfterMs: <hint> }
 *
 * The ACK/NACK is signed by the same HMAC as the corresponding packet so
 * the client can verify the server actually processed it (not a forged ACK).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AckEnvelope {
  kind: 'ack';
  seq: number;
  status: 'processed';
  sig: string;
}

export interface NackEnvelope {
  kind: 'nack';
  seq: number;
  retryAfterMs: number;
  sig: string;
}

export type AckOrNack = AckEnvelope | NackEnvelope;

/** Maximum retry-after hint server can suggest (sanity clamp). */
export const MAX_RETRY_AFTER_MS = 30_000;

function ackSig(seq: number, kind: 'ack' | 'nack', extra: number, secret: Buffer): string {
  if (!Buffer.isBuffer(secret) || secret.length < 32) {
    throw new TypeError('ackSig: secret must be Buffer ≥ 32 bytes');
  }
  // Canonical concat — no JSON to avoid the canonicalJson depth/edge cases.
  const payload = `${kind}|${seq}|${extra}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Build a server-side ACK for a successfully-processed inbound packet.
 * `seq` must be a non-negative finite integer (same constraint as ReplayCache.admitSeq).
 */
export function buildAck(seq: number, sessionSecret: Buffer): AckEnvelope {
  if (!Number.isInteger(seq) || seq < 0) {
    throw new RangeError(`buildAck: seq must be non-negative integer (got ${seq})`);
  }
  return {
    kind: 'ack',
    seq,
    status: 'processed',
    sig: ackSig(seq, 'ack', 0, sessionSecret),
  };
}

/**
 * Build a NACK with retry-after hint. Caller decides retryAfterMs based on
 * window pressure (e.g., window-full → retryAfterMs proportional to pending).
 * retryAfterMs is clamped to [0, MAX_RETRY_AFTER_MS].
 */
export function buildNack(seq: number, retryAfterMs: number, sessionSecret: Buffer): NackEnvelope {
  if (!Number.isInteger(seq) || seq < 0) {
    throw new RangeError(`buildNack: seq must be non-negative integer (got ${seq})`);
  }
  if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs)) {
    throw new RangeError(`buildNack: retryAfterMs must be finite (got ${retryAfterMs})`);
  }
  const clamped = Math.max(0, Math.min(MAX_RETRY_AFTER_MS, Math.floor(retryAfterMs)));
  return {
    kind: 'nack',
    seq,
    retryAfterMs: clamped,
    sig: ackSig(seq, 'nack', clamped, sessionSecret),
  };
}

export type ParseAckResult =
  | { ok: true; envelope: AckOrNack }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'unknown_kind' };

/**
 * Client-side: parse + verify an ACK/NACK from the server.
 * Returns structured failure rather than throwing.
 */
export function parseAckOrNack(raw: unknown, sessionSecret: Buffer): ParseAckResult {
  if (!Buffer.isBuffer(sessionSecret) || sessionSecret.length < 32) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'malformed' };
  const obj = raw as Record<string, unknown>;
  if (typeof obj.seq !== 'number' || !Number.isInteger(obj.seq) || obj.seq < 0) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof obj.sig !== 'string' || obj.sig.length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  if (obj.kind === 'ack') {
    if (obj.status !== 'processed') return { ok: false, reason: 'malformed' };
    const expected = ackSig(obj.seq, 'ack', 0, sessionSecret);
    if (!sigMatches(obj.sig, expected)) return { ok: false, reason: 'bad_signature' };
    return { ok: true, envelope: { kind: 'ack', seq: obj.seq, status: 'processed', sig: obj.sig } };
  }
  if (obj.kind === 'nack') {
    if (typeof obj.retryAfterMs !== 'number' || !Number.isFinite(obj.retryAfterMs) || obj.retryAfterMs < 0) {
      return { ok: false, reason: 'malformed' };
    }
    if (obj.retryAfterMs > MAX_RETRY_AFTER_MS) return { ok: false, reason: 'malformed' };
    const expected = ackSig(obj.seq, 'nack', obj.retryAfterMs, sessionSecret);
    if (!sigMatches(obj.sig, expected)) return { ok: false, reason: 'bad_signature' };
    return {
      ok: true,
      envelope: { kind: 'nack', seq: obj.seq, retryAfterMs: obj.retryAfterMs, sig: obj.sig },
    };
  }
  return { ok: false, reason: 'unknown_kind' };
}

function sigMatches(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}
