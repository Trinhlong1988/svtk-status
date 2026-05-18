/**
 * Minimal Redis abstraction used by anti-bot modules.
 *
 * `RedisLike` is a subset of the ioredis API: SET/GET/INCR/EXPIRE/DEL +
 * key TTL inspection. anti-bot modules accept this interface so tests can
 * supply an in-process Map-backed stub (no infra dep) while production wires
 * a real ioredis client via `wrapIoRedis`.
 *
 * CMD4 docker-compose (Tuần 2) provisions Redis; CMD2 ships the abstraction
 * + InMemoryRedis fallback so tests run without external infra.
 */

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: 'EX', ttlSec?: number): Promise<'OK'>;
  incr(key: string): Promise<number>;
  expire(key: string, ttlSec: number): Promise<number>;
  del(key: string): Promise<number>;
  /** TTL in seconds. -2 = no key, -1 = no expiry. */
  ttl(key: string): Promise<number>;
}

interface Entry {
  value: string;
  /** Expiry timestamp in ms; null = no expiry. */
  expireAtMs: number | null;
}

/**
 * In-process Map-backed RedisLike for tests / single-process dev.
 *
 * Uses an injected `now()` for deterministic test control. Production never
 * uses this — Redis cluster handles cross-process state.
 */
export class InMemoryRedis implements RedisLike {
  private readonly store = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private isExpired(entry: Entry): boolean {
    return entry.expireAtMs !== null && entry.expireAtMs <= this.now();
  }

  private read(key: string): Entry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.read(key)?.value ?? null;
  }

  async set(key: string, value: string, mode?: 'EX', ttlSec?: number): Promise<'OK'> {
    let expireAtMs: number | null = null;
    if (mode === 'EX') {
      if (ttlSec === undefined || !Number.isInteger(ttlSec) || ttlSec < 1) {
        throw new Error(`set EX ttlSec must be positive integer, got ${ttlSec}`);
      }
      expireAtMs = this.now() + ttlSec * 1000;
    }
    this.store.set(key, { value, expireAtMs });
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    const existing = this.read(key);
    const next = existing ? Number(existing.value) + 1 : 1;
    if (!Number.isFinite(next)) {
      throw new Error(`incr: existing value not numeric for key ${key}`);
    }
    this.store.set(key, {
      value: String(next),
      expireAtMs: existing?.expireAtMs ?? null,
    });
    return next;
  }

  async expire(key: string, ttlSec: number): Promise<number> {
    if (!Number.isInteger(ttlSec) || ttlSec < 1) {
      throw new Error(`expire ttlSec must be positive integer, got ${ttlSec}`);
    }
    const entry = this.read(key);
    if (!entry) return 0;
    entry.expireAtMs = this.now() + ttlSec * 1000;
    return 1;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return -2;
    if (entry.expireAtMs === null) return -1;
    const remainingMs = entry.expireAtMs - this.now();
    if (remainingMs <= 0) {
      this.store.delete(key);
      return -2;
    }
    // Integer ceiling without Math.ceil (R31 — NO FLOAT in Layer 3 hot path).
    // `floor((x + denom - 1) / denom)` is the canonical INT ceil; denom = 1000ms/s.
    return Math.floor((remainingMs + 999) / 1000);
  }
}
