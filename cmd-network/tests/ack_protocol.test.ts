import { describe, it, expect } from 'vitest';
import {
  buildAck,
  buildNack,
  parseAckOrNack,
  MAX_RETRY_AFTER_MS,
} from '../output/r69/ack_protocol.js';

const SECRET = Buffer.alloc(32, 1);
const OTHER = Buffer.alloc(32, 2);

describe('R69.4 ACK envelope', () => {
  it('builds + parses ACK round-trip', () => {
    const ack = buildAck(42, SECRET);
    expect(ack.kind).toBe('ack');
    expect(ack.seq).toBe(42);
    expect(ack.status).toBe('processed');
    const r = parseAckOrNack(ack, SECRET);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.envelope.kind).toBe('ack');
  });

  it('rejects negative seq at build time', () => {
    expect(() => buildAck(-1, SECRET)).toThrow(/non-negative integer/);
  });

  it('rejects non-integer seq at build time', () => {
    expect(() => buildAck(1.5, SECRET)).toThrow(/non-negative integer/);
    expect(() => buildAck(NaN, SECRET)).toThrow(/non-negative integer/);
  });

  it('rejects ACK with bad sig (different secret)', () => {
    const ack = buildAck(7, SECRET);
    const r = parseAckOrNack(ack, OTHER);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('rejects ACK with tampered seq', () => {
    const ack = buildAck(7, SECRET);
    const tampered = { ...ack, seq: 8 };
    const r = parseAckOrNack(tampered, SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('rejects ACK with malformed status', () => {
    const ack = buildAck(7, SECRET);
    const r = parseAckOrNack({ ...ack, status: 'evil' as 'processed' }, SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed');
  });
});

describe('R69.4 NACK envelope', () => {
  it('builds NACK with retry hint and clamps over-max', () => {
    const nack = buildNack(5, MAX_RETRY_AFTER_MS + 9999, SECRET);
    expect(nack.kind).toBe('nack');
    expect(nack.retryAfterMs).toBe(MAX_RETRY_AFTER_MS);
  });

  it('clamps negative retryAfterMs to 0', () => {
    const nack = buildNack(5, -100, SECRET);
    expect(nack.retryAfterMs).toBe(0);
  });

  it('rejects non-finite retryAfterMs', () => {
    expect(() => buildNack(5, NaN, SECRET)).toThrow(/finite/);
    expect(() => buildNack(5, Infinity, SECRET)).toThrow(/finite/);
  });

  it('parses NACK round-trip', () => {
    const nack = buildNack(99, 500, SECRET);
    const r = parseAckOrNack(nack, SECRET);
    expect(r.ok).toBe(true);
    if (r.ok && r.envelope.kind === 'nack') {
      expect(r.envelope.retryAfterMs).toBe(500);
    }
  });

  it('rejects NACK with tampered retryAfterMs', () => {
    const nack = buildNack(99, 500, SECRET);
    const tampered = { ...nack, retryAfterMs: 1 };
    const r = parseAckOrNack(tampered, SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('rejects NACK with retryAfterMs beyond cap (defense in depth)', () => {
    const nack = buildNack(99, 500, SECRET);
    const tampered = { ...nack, retryAfterMs: MAX_RETRY_AFTER_MS + 1 };
    const r = parseAckOrNack(tampered, SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed');
  });
});

describe('Input validation', () => {
  it('parseAckOrNack rejects undefined / null / non-object', () => {
    for (const v of [undefined, null, 'string', 42, true]) {
      const r = parseAckOrNack(v, SECRET);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('malformed');
    }
  });

  it('parseAckOrNack rejects unknown kind', () => {
    const r = parseAckOrNack({ kind: 'ping', seq: 0, sig: 'ab' }, SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_kind');
  });

  it('parseAckOrNack rejects too-short secret server-side', () => {
    const ack = buildAck(0, SECRET);
    const r = parseAckOrNack(ack, Buffer.alloc(16));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('buildAck rejects too-short secret', () => {
    expect(() => buildAck(0, Buffer.alloc(16))).toThrow(/Buffer ≥ 32 bytes/);
  });
});
