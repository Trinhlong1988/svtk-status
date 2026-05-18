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
  tsMs: number; // audit bug#38 — server timestamp prevents ACK replay
  sig: string;
}

export interface NackEnvelope {
  kind: 'nack';
  seq: number;
  retryAfterMs: number;
  tsMs: number; // audit bug#38 — server timestamp prevents NACK replay
  sig: string;
}

export type AckOrNack = AckEnvelope | NackEnvelope;

/** Maximum retry-after hint server can suggest (sanity clamp). */
export const MAX_RETRY_AFTER_MS = 30_000;
/** Max age of an ACK/NACK before client should treat as stale (anti-replay window). */
export const MAX_ACK_AGE_MS = 60_000;

function ackSig(
  seq: number,
  kind: 'ack' | 'nack',
  extra: number,
  tsMs: number,
  secret: Buffer,
): string {
  if (!Buffer.isBuffer(secret) || secret.length < 32) {
    throw new TypeError('ackSig: secret must be Buffer ≥ 32 bytes');
  }
  // Canonical concat — no JSON to avoid the canonicalJson depth/edge cases.
  // tsMs included in sig binds the envelope to its issue time (bug#38).
  const payload = `${kind}|${seq}|${extra}|${tsMs}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Validate seq is integer in safe range (audit bug#37). */
function checkSeq(seq: number, where: string): void {
  if (!Number.isInteger(seq) || seq < 0 || seq > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(
      `${where}: seq must be integer in [0, Number.MAX_SAFE_INTEGER] (got ${seq})`,
    );
  }
}

/**
 * Build a server-side ACK for a successfully-processed inbound packet.
 * `seq` must be a non-negative finite integer ≤ MAX_SAFE_INTEGER.
 * `serverNowMs` is recorded so the client can detect stale ACK replay.
 */
export function buildAck(seq: number, sessionSecret: Buffer, serverNowMs: number): AckEnvelope {
  checkSeq(seq, 'buildAck');
  if (typeof serverNowMs !== 'number' || !Number.isFinite(serverNowMs)) {
    throw new RangeError(`buildAck: serverNowMs must be finite (got ${serverNowMs})`);
  }
  return {
    kind: 'ack',
    seq,
    status: 'processed',
    tsMs: serverNowMs,
    sig: ackSig(seq, 'ack', 0, serverNowMs, sessionSecret),
  };
}

/**
 * Build a NACK with retry-after hint. Caller decides retryAfterMs based on
 * window pressure (e.g., window-full → retryAfterMs proportional to pending).
 * retryAfterMs is clamped to [0, MAX_RETRY_AFTER_MS].
 */
export function buildNack(
  seq: number,
  retryAfterMs: number,
  sessionSecret: Buffer,
  serverNowMs: number,
): NackEnvelope {
  checkSeq(seq, 'buildNack');
  if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs)) {
    throw new RangeError(`buildNack: retryAfterMs must be finite (got ${retryAfterMs})`);
  }
  if (typeof serverNowMs !== 'number' || !Number.isFinite(serverNowMs)) {
    throw new RangeError(`buildNack: serverNowMs must be finite (got ${serverNowMs})`);
  }
  const clamped = Math.max(0, Math.min(MAX_RETRY_AFTER_MS, Math.floor(retryAfterMs)));
  return {
    kind: 'nack',
    seq,
    retryAfterMs: clamped,
    tsMs: serverNowMs,
    sig: ackSig(seq, 'nack', clamped, serverNowMs, sessionSecret),
  };
}

export type ParseAckResult =
  | { ok: true; envelope: AckOrNack }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'unknown_kind' | 'stale' };

export interface ParseAckParams {
  raw: unknown;
  sessionSecret: Buffer;
  /** Current client time; ACK/NACK older than MAX_ACK_AGE_MS rejected as stale. */
  clientNowMs: number;
}

/**
 * Client-side: parse + verify an ACK/NACK from the server.
 * Returns structured failure rather than throwing.
 * Audit bug#38: validates `tsMs` is within MAX_ACK_AGE_MS to prevent replay.
 */
export function parseAckOrNack(p: ParseAckParams): ParseAckResult {
  const { raw, sessionSecret, clientNowMs } = p;
  if (!Buffer.isBuffer(sessionSecret) || sessionSecret.length < 32) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (typeof clientNowMs !== 'number' || !Number.isFinite(clientNowMs)) {
    return { ok: false, reason: 'malformed' };
  }
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'malformed' };
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.seq !== 'number' ||
    !Number.isInteger(obj.seq) ||
    obj.seq < 0 ||
    obj.seq > Number.MAX_SAFE_INTEGER
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof obj.tsMs !== 'number' || !Number.isFinite(obj.tsMs)) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof obj.sig !== 'string' || obj.sig.length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  // Stale window — reject ACKs older than MAX_ACK_AGE_MS or too-far-future
  // (clock skew protection same as packet_envelope openEnvelope).
  const ageMs = clientNowMs - obj.tsMs;
  if (ageMs > MAX_ACK_AGE_MS || ageMs < -MAX_ACK_AGE_MS) {
    return { ok: false, reason: 'stale' };
  }
  if (obj.kind === 'ack') {
    if (obj.status !== 'processed') return { ok: false, reason: 'malformed' };
    const expected = ackSig(obj.seq, 'ack', 0, obj.tsMs, sessionSecret);
    if (!sigMatches(obj.sig, expected)) return { ok: false, reason: 'bad_signature' };
    return {
      ok: true,
      envelope: {
        kind: 'ack',
        seq: obj.seq,
        status: 'processed',
        tsMs: obj.tsMs,
        sig: obj.sig,
      },
    };
  }
  if (obj.kind === 'nack') {
    if (
      typeof obj.retryAfterMs !== 'number' ||
      !Number.isFinite(obj.retryAfterMs) ||
      obj.retryAfterMs < 0
    ) {
      return { ok: false, reason: 'malformed' };
    }
    if (obj.retryAfterMs > MAX_RETRY_AFTER_MS) return { ok: false, reason: 'malformed' };
    const expected = ackSig(obj.seq, 'nack', obj.retryAfterMs, obj.tsMs, sessionSecret);
    if (!sigMatches(obj.sig, expected)) return { ok: false, reason: 'bad_signature' };
    return {
      ok: true,
      envelope: {
        kind: 'nack',
        seq: obj.seq,
        retryAfterMs: obj.retryAfterMs,
        tsMs: obj.tsMs,
        sig: obj.sig,
      },
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
