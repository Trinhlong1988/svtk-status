import { describe, it, expect } from 'vitest';
import {
  sealEnvelope,
  openEnvelope,
  MIN_SESSION_SECRET_BYTES,
  MAX_CANONICAL_DEPTH,
  type PacketCategory,
} from '../output/r69/packet_envelope.js';

const SECRET = Buffer.from('a'.repeat(64), 'hex');

function base(cat: PacketCategory = 'combat_action') {
  return {
    seq: 1,
    nonce: 'n1',
    tsMs: 1_000_000,
    category: cat,
    payload: {},
    sessionSecret: SECRET,
  };
}

describe('Deep hardening — secret validation (bug#24, #25)', () => {
  it('rejects empty Buffer secret', () => {
    expect(() =>
      sealEnvelope({ ...base(), sessionSecret: Buffer.alloc(0) }),
    ).toThrow(/≥ 32 bytes/);
  });

  it('rejects undefined secret (no crash, throws TypeError)', () => {
    expect(() =>
      sealEnvelope({ ...base(), sessionSecret: undefined as unknown as Buffer }),
    ).toThrow(/Buffer/);
  });

  it('rejects string secret', () => {
    expect(() =>
      sealEnvelope({ ...base(), sessionSecret: 'too_short' as unknown as Buffer }),
    ).toThrow(/Buffer/);
  });

  it('rejects 16-byte secret (below 256-bit floor)', () => {
    expect(() =>
      sealEnvelope({ ...base(), sessionSecret: Buffer.alloc(16, 1) }),
    ).toThrow(new RegExp(`≥ ${MIN_SESSION_SECRET_BYTES} bytes`));
  });

  it('accepts 32-byte secret', () => {
    expect(() =>
      sealEnvelope({ ...base(), sessionSecret: Buffer.alloc(32, 1) }),
    ).not.toThrow();
  });
});

describe('Deep hardening — canonicalJson depth limit (bug#26 DoS)', () => {
  it(`rejects payload deeper than ${MAX_CANONICAL_DEPTH}`, () => {
    let deep: Record<string, unknown> = {};
    let cur: Record<string, unknown> = deep;
    for (let i = 0; i < MAX_CANONICAL_DEPTH + 5; i++) {
      cur.n = {};
      cur = cur.n as Record<string, unknown>;
    }
    expect(() => sealEnvelope({ ...base('chat_message'), payload: deep })).toThrow(/depth/);
  });

  it(`accepts payload at depth exactly ${MAX_CANONICAL_DEPTH}`, () => {
    let deep: Record<string, unknown> = {};
    let cur: Record<string, unknown> = deep;
    for (let i = 0; i < MAX_CANONICAL_DEPTH - 2; i++) {
      cur.n = {};
      cur = cur.n as Record<string, unknown>;
    }
    expect(() => sealEnvelope({ ...base('chat_message'), payload: deep })).not.toThrow();
  });
});

describe('Deep hardening — Symbol keys + prototype chain (bug#27, #28)', () => {
  it('throws on Symbol-keyed payload (would be invisible to signing)', () => {
    const sym = Symbol('hidden');
    expect(() =>
      sealEnvelope({
        ...base('chat_message'),
        payload: { [sym]: 'secret', a: 1 } as Record<string | symbol, unknown>,
      }),
    ).toThrow(/Symbol/);
  });

  it('throws on non-plain-object payload (Object.create + own prop)', () => {
    const child = Object.create({ inherited: 'leak' });
    child.own = 'mine';
    expect(() =>
      sealEnvelope({ ...base('chat_message'), payload: child as unknown as object }),
    ).toThrow(/plain objects/);
  });

  it('accepts null-prototype object', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.a = 1;
    expect(() =>
      sealEnvelope({ ...base('chat_message'), payload: o }),
    ).not.toThrow();
  });
});

describe('Deep hardening — unknown category at seal time', () => {
  it('throws on seal with __proto__ category', () => {
    expect(() =>
      sealEnvelope({ ...base(), category: '__proto__' as PacketCategory }),
    ).toThrow(/unknown category/);
  });
});

describe('Deep hardening — openEnvelope guards bad server-side secret', () => {
  it('returns bad_signature for invalid server-side secret (no crash)', () => {
    const env = sealEnvelope(base('combat_action'));
    const r = openEnvelope({
      envelope: env,
      sessionSecret: Buffer.alloc(0),
      serverNowMs: 1_000_500,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });
});
