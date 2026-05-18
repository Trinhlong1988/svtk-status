import { describe, it, expect } from 'vitest';
import {
  sealEnvelope,
  openEnvelope,
  PACKET_CATEGORY_SPEC,
  type PacketCategory,
} from '../output/r69/packet_envelope.js';

const SECRET = Buffer.from('a'.repeat(64), 'hex');

function base(cat: PacketCategory) {
  return {
    seq: 1,
    nonce: 'n1',
    tsMs: 1_000_000,
    category: cat,
    payload: { ok: true },
    sessionSecret: SECRET,
  };
}

describe('Hardening — clock skew (bug#1)', () => {
  it('rejects future-stamped packet beyond +maxAgeMs', () => {
    const env = sealEnvelope(base('combat_action'));
    // tsMs=1_000_000, combat maxAgeMs=1000. Server clock 2s in PAST → age=-2000 → stale.
    const r = openEnvelope({ envelope: env, sessionSecret: SECRET, serverNowMs: 998_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('stale');
  });

  it('accepts packet within negative skew window', () => {
    const env = sealEnvelope(base('combat_action'));
    // serverNowMs 500ms behind → age=-500 → within ±1000
    const r = openEnvelope({ envelope: env, sessionSecret: SECRET, serverNowMs: 999_500 });
    expect(r.ok).toBe(true);
  });
});

describe('Hardening — prototype pollution (bug#7)', () => {
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])(
    'rejects category = %s (Object.prototype key)',
    (cat) => {
      const env = sealEnvelope(base('combat_action'));
      const bad = { ...env, category: cat as PacketCategory };
      const r = openEnvelope({ envelope: bad, sessionSecret: SECRET, serverNowMs: 1_000_500 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('unknown_category');
    },
  );
});

describe('Hardening — malformed envelope (bug#6, #16)', () => {
  it('rejects undefined sig gracefully (no crash)', () => {
    const env = sealEnvelope(base('combat_action'));
    const bad = { ...env, sig: undefined as unknown as string };
    const r = openEnvelope({ envelope: bad, sessionSecret: SECRET, serverNowMs: 1_000_500 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('rejects NaN tsMs (would otherwise NaN > maxAge === false)', () => {
    const env = sealEnvelope(base('combat_action'));
    const bad = { ...env, tsMs: NaN };
    const r = openEnvelope({ envelope: bad, sessionSecret: SECRET, serverNowMs: 1_000_500 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed');
  });

  it('rejects null envelope', () => {
    const r = openEnvelope({
      envelope: null as unknown as Parameters<typeof openEnvelope>[0]['envelope'],
      sessionSecret: SECRET,
      serverNowMs: 1_000_500,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed');
  });

  it('rejects empty nonce', () => {
    const env = sealEnvelope(base('combat_action'));
    const bad = { ...env, nonce: '' };
    const r = openEnvelope({ envelope: bad, sessionSecret: SECRET, serverNowMs: 1_000_500 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed');
  });

  it('rejects non-finite seq', () => {
    const env = sealEnvelope(base('combat_action'));
    const bad = { ...env, seq: Infinity };
    const r = openEnvelope({ envelope: bad, sessionSecret: SECRET, serverNowMs: 1_000_500 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed');
  });
});

describe('Hardening — canonicalJson type rejection (bug#2, #3, #4, #5)', () => {
  it('throws on BigInt payload (sealEnvelope catches via computeSig)', () => {
    expect(() =>
      sealEnvelope({ ...base('chat_message'), payload: { v: 1n as unknown as number } }),
    ).toThrow(/BigInt/);
  });

  it('throws on NaN in payload (would collide with null hash)', () => {
    expect(() => sealEnvelope({ ...base('chat_message'), payload: { hp: NaN } })).toThrow(
      /non-finite/,
    );
  });

  it('throws on Infinity in payload', () => {
    expect(() => sealEnvelope({ ...base('chat_message'), payload: { x: Infinity } })).toThrow(
      /non-finite/,
    );
  });

  it('throws on Date in payload (ambiguous serialization)', () => {
    expect(() =>
      sealEnvelope({ ...base('chat_message'), payload: { at: new Date(0) } }),
    ).toThrow(/Date/);
  });

  it('throws on Map / Set / RegExp in payload', () => {
    expect(() =>
      sealEnvelope({ ...base('chat_message'), payload: { m: new Map() } }),
    ).toThrow(/Map/);
    expect(() =>
      sealEnvelope({ ...base('chat_message'), payload: { s: new Set() } }),
    ).toThrow(/Set/);
    expect(() =>
      sealEnvelope({ ...base('chat_message'), payload: { r: /x/ as unknown as string } }),
    ).toThrow(/RegExp/);
  });

  it('omits undefined fields (rather than emitting invalid JSON)', () => {
    const a = sealEnvelope({
      ...base('chat_message'),
      payload: { y: 1, x: undefined as unknown as number },
    });
    const b = sealEnvelope({ ...base('chat_message'), payload: { y: 1 } });
    expect(a.sig).toBe(b.sig);
  });

  it('encodes arrays canonically (covers L143 branch)', () => {
    const env = sealEnvelope({ ...base('chat_message'), payload: [1, 2, 3] });
    expect(env.sig).toMatch(/^[0-9a-f]{64}$/);
    // Different array → different sig
    const env2 = sealEnvelope({ ...base('chat_message'), payload: [1, 2, 4] });
    expect(env.sig).not.toBe(env2.sig);
  });
});

describe('Category spec sanity (no Object.prototype contamination)', () => {
  it('Object.hasOwn returns true only for whitelisted categories', () => {
    expect(Object.hasOwn(PACKET_CATEGORY_SPEC, 'combat_action')).toBe(true);
    expect(Object.hasOwn(PACKET_CATEGORY_SPEC, '__proto__')).toBe(false);
    expect(Object.hasOwn(PACKET_CATEGORY_SPEC, 'constructor')).toBe(false);
  });
});
