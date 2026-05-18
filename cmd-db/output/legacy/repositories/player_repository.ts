/**
 * Player repository — account-level CRUD.
 *
 * Auth-adjacent (CMD4 wire signup/login on top). password_hash treated opaque;
 * argon2id hashing lives in CMD4 password_hash.ts.
 *
 * Functions take Pool as first param (no implicit singleton — tests inject mock).
 */
import type { Pool } from 'pg';

export interface PlayerRow {
  /** BIGSERIAL — pg driver returns as string to preserve >2^53 range. */
  id: string;
  username: string;
  email: string;
  password_hash: string;
  zalo_id: string | null;
  created_at: Date;
  last_login: Date | null;
}

export interface CreatePlayerInput {
  username: string;
  email: string;
  password_hash: string;
  zalo_id?: string | null;
}

/** Insert new player; throws on UNIQUE violation (username/email/zalo_id). */
export async function createPlayer(pool: Pool, input: CreatePlayerInput): Promise<PlayerRow> {
  const { rows } = await pool.query<PlayerRow>(
    `INSERT INTO players (username, email, password_hash, zalo_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, username, email, password_hash, zalo_id, created_at, last_login`,
    [input.username, input.email, input.password_hash, input.zalo_id ?? null],
  );
  const row = rows[0];
  if (!row) throw new Error('createPlayer: INSERT did not return row');
  return row;
}

/** Find player by id; null if not found. */
export async function findById(pool: Pool, id: string): Promise<PlayerRow | null> {
  const { rows } = await pool.query<PlayerRow>(
    `SELECT id, username, email, password_hash, zalo_id, created_at, last_login
     FROM players WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Find player by username (email/password login lookup). */
export async function findByUsername(pool: Pool, username: string): Promise<PlayerRow | null> {
  const { rows } = await pool.query<PlayerRow>(
    `SELECT id, username, email, password_hash, zalo_id, created_at, last_login
     FROM players WHERE username = $1`,
    [username],
  );
  return rows[0] ?? null;
}

/** Find player by email (recovery flow). */
export async function findByEmail(pool: Pool, email: string): Promise<PlayerRow | null> {
  const { rows } = await pool.query<PlayerRow>(
    `SELECT id, username, email, password_hash, zalo_id, created_at, last_login
     FROM players WHERE email = $1`,
    [email],
  );
  return rows[0] ?? null;
}

/** Find player by Zalo OAuth subject (primary auth path per Decision Point 2). */
export async function findByZaloId(pool: Pool, zaloId: string): Promise<PlayerRow | null> {
  const { rows } = await pool.query<PlayerRow>(
    `SELECT id, username, email, password_hash, zalo_id, created_at, last_login
     FROM players WHERE zalo_id = $1`,
    [zaloId],
  );
  return rows[0] ?? null;
}

/** Update last_login = NOW(). Idempotent. */
export async function touchLastLogin(pool: Pool, id: string): Promise<void> {
  await pool.query(`UPDATE players SET last_login = NOW() WHERE id = $1`, [id]);
}

/**
 * Account age in milliseconds (anti-bot age gate wire).
 *
 * Returns:
 *  - `-1` if player not found (distinct sentinel from "just created").
 *  - `0` if `nowMs < created_at` (clock skew clamp — prevents negative ages
 *    confusing downstream gates that check `age >= MIN_AGE`).
 *  - otherwise `nowMs - created_at.getTime()`.
 */
export async function accountAgeMs(pool: Pool, id: string, nowMs: number): Promise<number> {
  if (!Number.isFinite(nowMs)) throw new Error('accountAgeMs: nowMs must be finite');
  const { rows } = await pool.query<{ created_at: Date }>(
    `SELECT created_at FROM players WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return -1;
  const delta = nowMs - row.created_at.getTime();
  return delta < 0 ? 0 : delta;
}
