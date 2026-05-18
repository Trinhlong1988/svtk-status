import { describe, it, expect } from 'vitest';
import {
  PACKET_CATEGORY_SPEC,
  sealEnvelope,
  openEnvelope,
  type PacketCategory,
} from '../output/r69/packet_envelope.js';

const SECRET = Buffer.from('a'.repeat(64), 'hex');

function buildBase(cat: PacketCategory) {
  return {
    seq: 1,
    nonce: '0123456789abcdef0123456789abcdef',
    tsMs: 1_000_000,
    category: cat,
    payload: { skillId: 'skill_kim_cuong_tram', targetId: 'npc_quy_long' },
    sessionSecret: SECRET,
  };
}

describe('R69 packet_envelope — category spec', () => {
  it('exposes 5 categories with Foundation v2.8.0 maxAgeMs values', () => {
    expect(PACKET_CATEGORY_SPEC.combat_action.maxAgeMs).toBe(1000);
    expect(PACKET_CATEGORY_SPEC.movement.maxAgeMs).toBe(200);
    expect(PACKET_CATEGORY_SPEC.chat_message.maxAgeMs).toBe(30_000);
    expect(PACKET_CATEGORY_SPEC.ping_heartbeat.maxAgeMs).toBe(5_000);
    expect(PACKET_CATEGORY_SPEC.trade_confirm.maxAgeMs).toBe(60_000);
  });

  it('combat_action is reliable + ordered + ack_required', () => {
    const c = PACKET_CATEGORY_SPEC.combat_action;
    expect(c.reliable).toBe(true);
    expect(c.ordered).toBe(true);
    expect(c.ackRequired).toBe(true);
  });

  it('movement is unreliable, ordered, no-ack', () => {
    const m = PACKET_CATEGORY_SPEC.movement;
    expect(m.reliable).toBe(false);
    expect(m.ordered).toBe(true);
    expect(m.ackRequired).toBe(false);
  });
});

describe('R69 sealEnvelope + openEnvelope round-trip', () => {
  it('accepts a fresh sealed envelope', () => {
    const env = sealEnvelope(buildBase('combat_action'));
    const r = openEnvelope({ envelope: env, sessionSecret: SECRET, serverNowMs: 1_000_500 });
    expect(r.ok).toBe(true);
  });

  it('rejects an envelope with tampered payload (bad signature)', () => {
    const env = sealEnvelope(buildBase('combat_action'));
    const tampered = { ...env, payload: { skillId: 'skill_hack', targetId: 'npc_quy_long' } };
    const r = openEnvelope({ envelope: tampered, sessionSecret: SECRET, serverNowMs: 1_000_500 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('rejects an envelope past category maxAgeMs (stale)', () => {
    const env = sealEnvelope(buildBase('combat_action'));
    // combat_action maxAgeMs=1000; tsMs=1_000_000; serverNow=1_002_000 → age 2000ms > 1000ms
    const r = openEnvelope({ envelope: env, sessionSecret: SECRET, serverNowMs: 1_002_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('stale');
  });

  it('rejects unknown category', () => {
    const env = sealEnvelope(buildBase('combat_action'));
    const bad = { ...env, category: 'no_such_cat' as PacketCategory };
    const r = openEnvelope({ envelope: bad, sessionSecret: SECRET, serverNowMs: 1_000_500 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_category');
  });

  it('signature is deterministic for same inputs', () => {
    const a = sealEnvelope(buildBase('combat_action'));
    const b = sealEnvelope(buildBase('combat_action'));
    expect(a.sig).toBe(b.sig);
  });

  it('signature differs across sessionSecret (timing-safe path)', () => {
    const a = sealEnvelope(buildBase('combat_action'));
    const otherSecret = Buffer.from('b'.repeat(64), 'hex');
    const b = sealEnvelope({ ...buildBase('combat_action'), sessionSecret: otherSecret });
    expect(a.sig).not.toBe(b.sig);
  });

  it('canonical JSON makes payload key-order irrelevant', () => {
    const env1 = sealEnvelope({
      ...buildBase('chat_message'),
      payload: { a: 1, b: 2, c: 3 },
    });
    const env2 = sealEnvelope({
      ...buildBase('chat_message'),
      payload: { c: 3, b: 2, a: 1 },
    });
    expect(env1.sig).toBe(env2.sig);
  });

  it('chat_message allows 29s age (under 30s window)', () => {
    const env = sealEnvelope(buildBase('chat_message'));
    const r = openEnvelope({ envelope: env, sessionSecret: SECRET, serverNowMs: 1_029_000 });
    expect(r.ok).toBe(true);
  });
});
