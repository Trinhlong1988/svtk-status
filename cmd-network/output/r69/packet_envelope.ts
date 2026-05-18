/**
 * R69 Packet Envelope — SVTK Foundation v2.8.0
 *
 * Wraps every client→server packet with:
 *   - seq      : monotonic sequence number per session (R69.2)
 *   - nonce    : 128-bit anti-replay (R66.3)
 *   - ts_ms    : client timestamp for stale rejection (R69.3)
 *   - category : delivery semantics tag (R69.1)
 *   - sig      : HMAC-SHA256(session_secret, payload || seq || nonce || ts_ms)
 *
 * Categories (R69.1): combat_action / movement / chat_message / ping_heartbeat / trade_confirm.
 *
 * Determinism: KHÔNG dùng Math.random — caller injects `nonceFn` (R6 SVTK CLAUDE.md).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type PacketCategory =
  | 'combat_action'
  | 'movement'
  | 'chat_message'
  | 'ping_heartbeat'
  | 'trade_confirm';

export interface CategorySpec {
  reliable: boolean;
  ordered: boolean;
  maxAgeMs: number;
  ackRequired: boolean;
}

/**
 * R69.1 — Packet category delivery semantics.
 * Values pulled verbatim from Foundation v2.8.0 R69.1 YAML config.
 * Edit Foundation first; this constant mirrors it.
 */
export const PACKET_CATEGORY_SPEC: Record<PacketCategory, CategorySpec> = {
  combat_action: { reliable: true, ordered: true, maxAgeMs: 1000, ackRequired: true },
  movement: { reliable: false, ordered: true, maxAgeMs: 200, ackRequired: false },
  chat_message: { reliable: true, ordered: false, maxAgeMs: 30_000, ackRequired: true },
  ping_heartbeat: { reliable: false, ordered: false, maxAgeMs: 5_000, ackRequired: false },
  trade_confirm: { reliable: true, ordered: true, maxAgeMs: 60_000, ackRequired: true },
};

export interface PacketEnvelope<P = unknown> {
  seq: number;
  nonce: string;
  tsMs: number;
  category: PacketCategory;
  payload: P;
  sig: string;
}

export interface SealParams<P> {
  seq: number;
  nonce: string;
  tsMs: number;
  category: PacketCategory;
  payload: P;
  sessionSecret: Buffer;
}

/**
 * Wrap a payload with seq+nonce+ts+HMAC signature for transmission.
 * Caller controls `seq` (monotonic per session) and `nonce` (anti-replay,
 * caller-injected for determinism — see file header).
 */
export function sealEnvelope<P>(p: SealParams<P>): PacketEnvelope<P> {
  const sig = computeSig({
    seq: p.seq,
    nonce: p.nonce,
    tsMs: p.tsMs,
    category: p.category,
    payload: p.payload,
    sessionSecret: p.sessionSecret,
  });
  return { seq: p.seq, nonce: p.nonce, tsMs: p.tsMs, category: p.category, payload: p.payload, sig };
}

export type OpenResult<P> =
  | { ok: true; envelope: PacketEnvelope<P> }
  | { ok: false; reason: 'bad_signature' | 'stale' | 'unknown_category' };

export interface OpenParams<P> {
  envelope: PacketEnvelope<P>;
  sessionSecret: Buffer;
  serverNowMs: number;
}

/**
 * Validate signature + stale window for an incoming envelope.
 * Does NOT enforce seq monotonicity or nonce uniqueness — that is the
 * caller's responsibility via ReplayCache (R69.2 + R66.3).
 */
export function openEnvelope<P>(p: OpenParams<P>): OpenResult<P> {
  const spec = PACKET_CATEGORY_SPEC[p.envelope.category];
  if (!spec) return { ok: false, reason: 'unknown_category' };

  const expectedSig = computeSig({
    seq: p.envelope.seq,
    nonce: p.envelope.nonce,
    tsMs: p.envelope.tsMs,
    category: p.envelope.category,
    payload: p.envelope.payload,
    sessionSecret: p.sessionSecret,
  });
  const actual = Buffer.from(p.envelope.sig, 'hex');
  const expected = Buffer.from(expectedSig, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const ageMs = p.serverNowMs - p.envelope.tsMs;
  if (ageMs > spec.maxAgeMs) {
    return { ok: false, reason: 'stale' };
  }

  return { ok: true, envelope: p.envelope };
}

interface SigParams {
  seq: number;
  nonce: string;
  tsMs: number;
  category: PacketCategory;
  payload: unknown;
  sessionSecret: Buffer;
}

function computeSig(p: SigParams): string {
  const canonical = canonicalJson({
    seq: p.seq,
    nonce: p.nonce,
    ts_ms: p.tsMs,
    category: p.category,
    payload: p.payload,
  });
  return createHmac('sha256', p.sessionSecret).update(canonical).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
}
