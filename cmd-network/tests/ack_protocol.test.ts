import { describe, it, expect } from 'vitest';
import {
  buildAck,
  buildNack,
  parseAckOrNack,
  MAX_RETRY_AFTER_MS,
  MAX_ACK_AGE_MS,
} from '../output/r69/ack_protocol.js';

const SECRET = Buffer.alloc(32, 1);
const OTHER = Buffer.alloc(32, 2);
const NOW = 1_000_000;

describe('R69.4 ACK envelope', () => {
  it('builds + parses ACK round-trip with timestamp', () => {
    const ack = buildAck(42, SECRET, NOW);
    expect(ack.kind).toBe('ack');
    expect(ack.seq).toBe(42);
    expect(ack.status).toBe('processed');
    expect(ack.tsMs).toBe(NOW);
    const r = parseAckOrNack({ raw: ack, sessionSecret: SECRET, clientNowMs: NOW + 100 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.envelope.kind).toBe('ack');
  });

  it('rejects negative seq at build time', () => {
    expect(() => buildAck(-1, SECRET, NOW)).toThrow(/integer in/);
  });

  it('rejects seq > MAX_SAFE_INTEGER (audit bug#37)', () => {
    expect(() => buildAck(Number.MAX_SAFE_INTEGER + 1, SECRET, NOW)).toThrow(/integer in/);
  });

  it('rejects non-integer seq at build time', () => {
    expect(() => buildAck(1.5, SECRET, NOW)).toThrow(/integer in/);
    expect(() => buildAck(NaN, SECRET, NOW)).toThrow(/integer in/);
  });

  it('rejects ACK with bad sig (different secret)', () => {
    const ack = buildAck(7, SECRET, NOW);
    const r = parseAckOrNack({ raw: ack, sessionSecret: OTHER, clientNowMs: NOW + 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('rejects ACK with tampered seq', () => {
    const ack = buildAck(7, SECRET, NOW);
    const tampered = { ...ack, seq: 8 };
    const r = parseAckOrNack({ raw: tampered, sessionSecret: SECRET, clientNowMs: NOW + 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('rejects ACK with tampered tsMs', () => {
    const ack = buildAck(7, SECRET, NOW);
    const tampered = { ...ack, tsMs: NOW + 1 };
    const r = parseAckOrNack({
      raw: tampered,
      sessionSecret: SECRET,
      clientNowMs: NOW + 100,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('rejects ACK with malformed status', () => {
    const ack = buildAck(7, SECRET, NOW);
    const r = parseAckOrNack({
      raw: { ...ack, status: 'evil' as 'processed' },
      sessionSecret: SECRET,
      clientNowMs: NOW + 100,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed');
  });
});

describe('R69.4 NACK envelope', () => {
  it('builds NACK with retry hint and clamps over-max', () => {
    const nack = buildNack(5, MAX_RETRY_AFTER_MS + 9999, SECRET, NOW);
    expect(nack.kind).toBe('nack');
    expect(nack.retryAfterMs).toBe(MAX_RETRY_AFTER_MS);
    expect(nack.tsMs).toBe(NOW);
  });

  it('clamps negative retryAfterMs to 0', () => {
    const nack = buildNack(5, -100, SECRET, NOW);
    expect(nack.retryAfterMs).toBe(0);
  });

  it('rejects non-finite retryAfterMs', () => {
    expect(() => buildNack(5, NaN, SECRET, NOW)).toThrow(/finite/);
    expect(() => buildNack(5, Infinity, SECRET, NOW)).toThrow(/finite/);
  });

  it('parses NACK round-trip', () => {
    const nack = buildNack(99, 500, SECRET, NOW);
    const r = parseAckOrNack({ raw: nack, sessionSecret: SECRET, clientNowMs: NOW + 100 });
    expect(r.ok).toBe(true);
    if (r.ok && r.envelope.kind === 'nack') {
      expect(r.envelope.retryAfterMs).toBe(500);
      expect(r.envelope.tsMs).toBe(NOW);
    }
  });

  it('rejects NACK with tampered retryAfterMs', () => {
    const nack = buildNack(99, 500, SECRET, NOW);
    const tampered = { ...nack, retryAfterMs: 1 };
    const r = parseAckOrNack({
      raw: tampered,
      sessionSecret: SECRET,
      clientNowMs: NOW + 100,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('rejects NACK with retryAfterMs beyond cap (defense in depth)', () => {
    const nack = buildNack(99, 500, SECRET, NOW);
    const tampered = { ...nack, retryAfterMs: MAX_RETRY_AFTER_MS + 1 };
    const r = parseAckOrNack({
      raw: tampered,
      sessionSecret: SECRET,
      clientNowMs: NOW + 100,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed');
  });
});

describe('Anti-replay timestamp (audit bug#38)', () => {
  it('rejects ACK older than MAX_ACK_AGE_MS (replay attack)', () => {
    const ack = buildAck(1, SECRET, NOW);
    const r = parseAckOrNack({
      raw: ack,
      sessionSecret: SECRET,
      clientNowMs: NOW + MAX_ACK_AGE_MS + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('stale');
  });

  it('rejects ACK with future tsMs > +MAX_ACK_AGE_MS (clock skew)', () => {
    const ack = buildAck(1, SECRET, NOW);
    const r = parseAckOrNack({
      raw: ack,
      sessionSecret: SECRET,
      clientNowMs: NOW - MAX_ACK_AGE_MS - 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('stale');
  });

  it('rejects NACK older than MAX_ACK_AGE_MS', () => {
    const nack = buildNack(1, 500, SECRET, NOW);
    const r = parseAckOrNack({
      raw: nack,
      sessionSecret: SECRET,
      clientNowMs: NOW + MAX_ACK_AGE_MS + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('stale');
  });
});

describe('Input validation', () => {
  it('parseAckOrNack rejects undefined / null / non-object', () => {
    for (const v of [undefined, null, 'string', 42, true]) {
      const r = parseAckOrNack({ raw: v, sessionSecret: SECRET, clientNowMs: NOW });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('malformed');
    }
  });

  it('parseAckOrNack rejects unknown kind', () => {
    const r = parseAckOrNack({
      raw: { kind: 'ping', seq: 0, tsMs: NOW, sig: 'ab' },
      sessionSecret: SECRET,
      clientNowMs: NOW + 100,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_kind');
  });

  it('parseAckOrNack rejects clientNowMs = NaN', () => {
    const ack = buildAck(0, SECRET, NOW);
    const r = parseAckOrNack({ raw: ack, sessionSecret: SECRET, clientNowMs: NaN });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed');
  });

  it('parseAckOrNack rejects too-short secret server-side', () => {
    const ack = buildAck(0, SECRET, NOW);
    const r = parseAckOrNack({ raw: ack, sessionSecret: Buffer.alloc(16), clientNowMs: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('buildAck rejects too-short secret', () => {
    expect(() => buildAck(0, Buffer.alloc(16), NOW)).toThrow(/Buffer ≥ 32 bytes/);
  });

  it('buildAck rejects non-finite serverNowMs', () => {
    expect(() => buildAck(0, SECRET, NaN)).toThrow(/finite/);
  });
});
