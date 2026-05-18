import { describe, it, expect } from 'vitest';
import { sealEnvelope } from '../output/r69/packet_envelope.js';
import { Session } from '../output/r69/session.js';
import { parseAckOrNack } from '../output/r69/ack_protocol.js';

const SECRET = Buffer.alloc(32, 0xaa);
const NOW = 1_000_000;

function packet(seq: number, nonce: string, category: 'combat_action' | 'movement' | 'chat_message' = 'combat_action') {
  return sealEnvelope({
    seq,
    nonce,
    tsMs: NOW,
    category,
    payload: { ok: true },
    sessionSecret: SECRET,
  });
}

describe('R69 Session orchestrator — happy path', () => {
  it('delivers a fresh combat packet + emits ACK', () => {
    const s = new Session({ sessionSecret: SECRET });
    const env = packet(1, 'n1');
    const r = s.inbound(env, NOW + 100);
    expect(r.delivered).toBe(true);
    expect(r.response?.kind).toBe('ack');
    if (r.response) {
      const parsed = parseAckOrNack(r.response, SECRET);
      expect(parsed.ok).toBe(true);
    }
  });

  it('drops replayed nonce (R66.3) — no response either', () => {
    const s = new Session({ sessionSecret: SECRET });
    const env = packet(1, 'same-nonce');
    s.inbound(env, NOW + 100);
    const r2 = s.inbound(env, NOW + 200);
    expect(r2.delivered).toBe(false);
    expect(r2.response).toBeUndefined();
  });

  it('rejects out-of-order combat seq (ordered category, R69.2)', () => {
    const s = new Session({ sessionSecret: SECRET });
    s.inbound(packet(5, 'n5'), NOW + 100);
    const r = s.inbound(packet(3, 'n3'), NOW + 200);
    expect(r.delivered).toBe(false);
    expect(r.response).toBeUndefined();
  });

  it('movement (unreliable, no ack required) delivers WITHOUT response', () => {
    const s = new Session({ sessionSecret: SECRET });
    const env = packet(1, 'm1', 'movement');
    const r = s.inbound(env, NOW + 50);
    expect(r.delivered).toBe(true);
    expect(r.response).toBeUndefined();
  });
});

describe('R69 Session orchestrator — backpressure (R69.5)', () => {
  it('emits NACK when window full', () => {
    const s = new Session({ sessionSecret: SECRET, windowSize: 2 });
    s.inbound(packet(1, 'n1'), NOW + 10);
    s.inbound(packet(2, 'n2'), NOW + 20);
    const r3 = s.inbound(packet(3, 'n3'), NOW + 30);
    expect(r3.delivered).toBe(false);
    expect(r3.response?.kind).toBe('nack');
    if (r3.response && r3.response.kind === 'nack') {
      expect(r3.response.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('frees a slot after onClientAck — next packet admitted', () => {
    const s = new Session({ sessionSecret: SECRET, windowSize: 1 });
    s.inbound(packet(1, 'n1'), NOW + 10);
    const blocked = s.inbound(packet(2, 'n2'), NOW + 20);
    expect(blocked.delivered).toBe(false);
    expect(s.onClientAck(1)).toBe(true);
    const ok = s.inbound(packet(3, 'n3'), NOW + 30);
    expect(ok.delivered).toBe(true);
  });
});

describe('R69 Session orchestrator — input validation', () => {
  it('rejects too-short sessionSecret at construction', () => {
    expect(() => new Session({ sessionSecret: Buffer.alloc(16) })).toThrow(/≥ 32 bytes/);
  });

  it('reset() clears replay cache + window', () => {
    const s = new Session({ sessionSecret: SECRET, windowSize: 1 });
    s.inbound(packet(1, 'n1'), NOW + 10);
    s.inbound(packet(2, 'n2'), NOW + 20); // blocked
    s.reset();
    const r = s.inbound(packet(1, 'n1'), NOW + 30); // would replay before reset, OK after
    expect(r.delivered).toBe(true);
  });

  it('hard-rejects malformed envelope (no response)', () => {
    const s = new Session({ sessionSecret: SECRET });
    const r = s.inbound({ seq: 1, nonce: 'x', tsMs: NaN, category: 'combat_action', payload: {}, sig: 'ab' } as unknown as Parameters<Session['inbound']>[0], NOW + 10);
    expect(r.delivered).toBe(false);
    expect(r.response).toBeUndefined();
    expect(r.rejectReason).toBeDefined();
  });
});
