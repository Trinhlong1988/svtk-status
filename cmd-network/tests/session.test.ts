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
    // OrderedReceiver expects initial seq=0 for ordered+reliable.
    const env = packet(0, 'n0');
    const r = s.inbound(env, NOW + 100);
    expect(r.delivered).toBe(true);
    expect(r.response?.kind).toBe('ack');
    if (r.response) {
      const parsed = parseAckOrNack({
        raw: r.response,
        sessionSecret: SECRET,
        clientNowMs: NOW + 200,
      });
      expect(parsed.ok).toBe(true);
    }
  });

  it('drops replayed nonce (R66.3) — no response either', () => {
    const s = new Session({ sessionSecret: SECRET });
    const env = packet(0, 'same-nonce');
    s.inbound(env, NOW + 100);
    const r2 = s.inbound(env, NOW + 200);
    expect(r2.delivered).toBe(false);
    expect(r2.response).toBeUndefined();
  });

  it('buffers out-of-order combat seq until predecessor arrives (R69.2 buffering)', () => {
    const s = new Session({ sessionSecret: SECRET });
    // First combat must start at seq=0 per OrderedReceiver default initialSeq.
    expect(s.inbound(packet(0, 'n0'), NOW + 100).delivered).toBe(true);
    // Send seq=2 out of order — should buffer.
    const buf = s.inbound(packet(2, 'n2'), NOW + 200);
    expect(buf.delivered).toBe(false);
    expect(buf.rejectReason).toBe('buffered');
    // Now send seq=1 — both 1 and 2 should drain in order.
    const drain = s.inbound(packet(1, 'n1'), NOW + 300);
    expect(drain.delivered).toBe(true);
    expect(drain.drained?.length).toBe(2);
    expect(drain.drained?.[0]?.seq).toBe(1);
    expect(drain.drained?.[1]?.seq).toBe(2);
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
    s.inbound(packet(0, 'n0'), NOW + 10);
    const blocked = s.inbound(packet(1, 'n1'), NOW + 20);
    expect(blocked.delivered).toBe(false);
    expect(s.onClientAck(0)).toBe(true);
    // Use a NEW nonce — the blocked retry by the same nonce would be rejected
    // as replay (which is exactly the semantics we want; clients must mint
    // fresh nonces on retry).
    const ok = s.inbound(packet(1, 'n1-retry'), NOW + 30);
    expect(ok.delivered).toBe(true);
  });
});

describe('R69 Session orchestrator — input validation', () => {
  it('rejects too-short sessionSecret at construction', () => {
    expect(() => new Session({ sessionSecret: Buffer.alloc(16) })).toThrow(/≥ 32 bytes/);
  });

  it('reset() clears replay cache + window + ordered buffers', () => {
    const s = new Session({ sessionSecret: SECRET, windowSize: 1 });
    s.inbound(packet(0, 'n0'), NOW + 10);
    s.inbound(packet(1, 'n1'), NOW + 20); // blocked by windowSize=1
    s.reset();
    const r = s.inbound(packet(0, 'n0'), NOW + 30); // OK after reset (nonce + seq both cleared)
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
