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

/** Minimum session secret length — HMAC-SHA256 keys < 32 bytes weaken security
 *  (RFC 2104 allows shorter, but SVTK enforces 256-bit floor). */
export const MIN_SESSION_SECRET_BYTES = 32;
/** Max canonicalJson recursion depth — defense vs DoS payload (audit bug#26). */
export const MAX_CANONICAL_DEPTH = 64;

function validateSecret(s: unknown): asserts s is Buffer {
  if (!Buffer.isBuffer(s)) {
    throw new TypeError('sessionSecret must be a Buffer');
  }
  if (s.length < MIN_SESSION_SECRET_BYTES) {
    throw new RangeError(
      `sessionSecret must be ≥ ${MIN_SESSION_SECRET_BYTES} bytes (got ${s.length})`,
    );
  }
}

/**
 * Wrap a payload with seq+nonce+ts+HMAC signature for transmission.
 * Caller controls `seq` (monotonic per session) and `nonce` (anti-replay,
 * caller-injected for determinism — see file header).
 */
export function sealEnvelope<P>(p: SealParams<P>): PacketEnvelope<P> {
  validateSecret(p.sessionSecret); // audit bug#24/#25: reject empty/non-Buffer secret
  if (!Object.hasOwn(PACKET_CATEGORY_SPEC, p.category)) {
    throw new TypeError(`sealEnvelope: unknown category ${String(p.category)}`);
  }
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
  | { ok: false; reason: 'bad_signature' | 'stale' | 'unknown_category' | 'malformed' };

export interface OpenParams<P> {
  envelope: PacketEnvelope<P>;
  sessionSecret: Buffer;
  serverNowMs: number;
}

/**
 * Validate signature + stale window for an incoming envelope.
 * Does NOT enforce seq monotonicity or nonce uniqueness — that is the
 * caller's responsibility via ReplayCache (R69.2 + R66.3).
 *
 * Hardened against (audit 2026-05-18):
 *   - bug#7: prototype-pollution category lookup (use Object.hasOwn)
 *   - bug#1: future-timestamped packets (bound |age| ≤ maxAgeMs both directions)
 *   - bug#6: undefined/non-string sig (graceful bad_signature instead of crash)
 *   - bug#16: undefined/null envelope/tsMs (graceful malformed instead of NaN bypass)
 */
export function openEnvelope<P>(p: OpenParams<P>): OpenResult<P> {
  try {
    validateSecret(p.sessionSecret);
  } catch {
    // Server-side bug — caller passed bad secret. Treat as bad_signature for
    // consistent client-facing UX (don't reveal "your secret is misconfigured").
    return { ok: false, reason: 'bad_signature' };
  }
  const env = p.envelope as unknown as PacketEnvelope<P> | null | undefined;
  if (!env || typeof env !== 'object') return { ok: false, reason: 'malformed' };

  // Category whitelist — Object.hasOwn() prevents __proto__/constructor/toString lookup
  if (typeof env.category !== 'string' || !Object.hasOwn(PACKET_CATEGORY_SPEC, env.category)) {
    return { ok: false, reason: 'unknown_category' };
  }
  const spec = PACKET_CATEGORY_SPEC[env.category];

  if (typeof env.sig !== 'string' || env.sig.length === 0) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (typeof env.tsMs !== 'number' || !Number.isFinite(env.tsMs)) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof env.seq !== 'number' || !Number.isFinite(env.seq)) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof env.nonce !== 'string' || env.nonce.length === 0) {
    return { ok: false, reason: 'malformed' };
  }

  let expectedSig: string;
  try {
    expectedSig = computeSig({
      seq: env.seq,
      nonce: env.nonce,
      tsMs: env.tsMs,
      category: env.category,
      payload: env.payload,
      sessionSecret: p.sessionSecret,
    });
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const actual = Buffer.from(env.sig, 'hex');
  const expected = Buffer.from(expectedSig, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Stale window — guard both directions (clock-skew tolerance).
  // R66.3 mentions abs(now - timestamp) < 30s; here we use category.maxAgeMs
  // as the symmetric bound to keep deterministic per-category behavior.
  const ageMs = p.serverNowMs - env.tsMs;
  if (ageMs > spec.maxAgeMs || ageMs < -spec.maxAgeMs) {
    return { ok: false, reason: 'stale' };
  }

  return { ok: true, envelope: env };
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

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new RangeError(`canonicalJson: depth exceeds ${MAX_CANONICAL_DEPTH} (audit bug#26 DoS guard)`);
  }
  // Reject types JSON.stringify handles ambiguously (audit bug#2/#3/#4/#5):
  // - undefined / function / Symbol → JSON.stringify returns undefined (not a string)
  // - BigInt → throws TypeError
  // - NaN / Infinity / -Infinity → JSON.stringify returns "null" (collides with literal null)
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
  if (typeof value === 'bigint') {
    throw new TypeError('canonicalJson: BigInt not supported in wire payload');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`canonicalJson: non-finite number ${value} not supported`);
  }
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  // Date / Map / Set / RegExp serialize ambiguously — require explicit toJSON()
  if (value instanceof Date || value instanceof Map || value instanceof Set || value instanceof RegExp) {
    throw new TypeError(`canonicalJson: ${value.constructor.name} not supported (caller must serialize explicitly)`);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v, depth + 1)).join(',') + ']';
  }
  // Reject objects with Symbol keys (audit bug#27) — Object.entries silently drops them
  // so any data under a Symbol key would be invisible to signing.
  if (Object.getOwnPropertySymbols(value as object).length > 0) {
    throw new TypeError('canonicalJson: Symbol-keyed properties not supported (would be invisible to signing)');
  }
  // Reject non-plain objects (audit bug#28) — inherited enumerable props are silently
  // dropped by Object.entries, and class instances may behave unpredictably.
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    throw new TypeError('canonicalJson: only plain objects (null-proto or Object.prototype) supported');
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => typeof v !== 'undefined') // omit undefined fields (rather than emit invalid JSON)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    '{' +
    entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v, depth + 1)).join(',') +
    '}'
  );
}
