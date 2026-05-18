/**
 * Argon2id password hashing wrapper.
 *
 * Phase 13 Tuần 1 (CMD4): cost params chốt theo brief — memory 64 MB,
 * iterations 3, parallelism 1. argon2id chống cả side-channel + GPU brute force.
 *
 * Layer 3 server infrastructure (auth). KHÔNG hot-path combat → no INT BP rule.
 * Tuy nhiên scanner `check_int_convention.mjs` vẫn scan src/server/ → mọi
 * literal số PHẢI integer. Memory=KiB, time=iteration count, parallelism=threads.
 */
import argon2 from 'argon2';

/** Argon2id cost parameters. All fields integer. */
export interface PasswordHashConfig {
  /** argon2 type id: 0=argon2d, 1=argon2i, 2=argon2id (BẮT BUỘC dùng 2). */
  readonly type: 0 | 1 | 2;
  /** Memory cost in KiB. Brief: 64 MB → 65536 KiB. */
  readonly memoryCostKb: number;
  /** Time cost (number of iterations). Brief: 3. */
  readonly timeCost: number;
  /** Parallelism (lanes). Brief implicit: 1. */
  readonly parallelism: number;
}

/** Default config matching Phase 13 Tuần 1 brief. */
export const DEFAULT_PASSWORD_HASH_CONFIG: PasswordHashConfig = Object.freeze({
  type: 2,
  memoryCostKb: 65536,
  timeCost: 3,
  parallelism: 1,
});

/**
 * Hash a plain-text password. Returns the encoded `$argon2id$v=19$m=...$...$...`
 * string — store this verbatim in the database. Includes salt + params, so no
 * separate salt column needed.
 *
 * @throws if plain is not a non-empty string, or if argon2 native call fails.
 */
export async function hashPassword(
  plain: string,
  config: PasswordHashConfig = DEFAULT_PASSWORD_HASH_CONFIG,
): Promise<string> {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('hashPassword: password must be a non-empty string');
  }
  return argon2.hash(plain, {
    type: config.type,
    memoryCost: config.memoryCostKb,
    timeCost: config.timeCost,
    parallelism: config.parallelism,
  });
}

/**
 * Verify a plain-text password against a stored encoded hash.
 *
 * Returns `false` (does NOT throw) on any verify failure: mismatch, malformed
 * hash, empty inputs, native error. Auth flow callers can branch on a single
 * boolean without try/catch — fewer ways to leak timing/error details.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  if (typeof hash !== 'string' || hash.length === 0) return false;
  if (typeof plain !== 'string' || plain.length === 0) return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * Heuristic check whether a stored hash was produced with weaker parameters
 * than the current config — signal to re-hash on next successful login.
 * Parses the `$argon2id$v=19$m=NNNN,t=N,p=N$...` header.
 *
 * Returns true if hash is malformed (cannot parse) — caller should re-hash.
 */
export function needsRehash(
  hash: string,
  config: PasswordHashConfig = DEFAULT_PASSWORD_HASH_CONFIG,
): boolean {
  if (typeof hash !== 'string') return true;
  const match = hash.match(/^\$argon2(id|i|d)\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/);
  if (!match) return true;
  const algo = match[1];
  const m = match[2];
  const t = match[3];
  const p = match[4];
  if (m === undefined || t === undefined || p === undefined) return true;
  const expectedAlgo = config.type === 2 ? 'id' : config.type === 1 ? 'i' : 'd';
  if (algo !== expectedAlgo) return true;
  return (
    Number.parseInt(m, 10) < config.memoryCostKb ||
    Number.parseInt(t, 10) < config.timeCost ||
    Number.parseInt(p, 10) < config.parallelism
  );
}
