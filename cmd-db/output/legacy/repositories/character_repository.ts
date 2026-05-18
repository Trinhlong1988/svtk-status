/**
 * Character repository — per-player game character CRUD.
 *
 * Currencies (gold/linh_chau/luong) stored BIGINT (string in driver). Caller
 * must use BigInt-safe arithmetic or treat as string for large balances.
 *
 * Level/exp atomic update via SQL (no read-modify-write race).
 */
import type { Pool } from 'pg';

export interface CharacterRow {
  id: string;
  player_id: string;
  name: string;
  class: string;
  level: number;
  /** BIGINT → string from driver. */
  exp: string;
  gold: string;
  linh_chau: string;
  luong: string;
  schema_version: number;
  created_at: Date;
}

export interface CreateCharacterInput {
  player_id: string;
  name: string;
  class: string;
}

/** Insert new character; UNIQUE(player_id, name) prevents duplicate. */
export async function createCharacter(
  pool: Pool,
  input: CreateCharacterInput,
): Promise<CharacterRow> {
  const { rows } = await pool.query<CharacterRow>(
    `INSERT INTO characters (player_id, name, class)
     VALUES ($1, $2, $3)
     RETURNING id, player_id, name, class, level, exp, gold, linh_chau, luong, schema_version, created_at`,
    [input.player_id, input.name, input.class],
  );
  const row = rows[0];
  if (!row) throw new Error('createCharacter: INSERT did not return row');
  return row;
}

/** Load single character by id. */
export async function findById(pool: Pool, id: string): Promise<CharacterRow | null> {
  const { rows } = await pool.query<CharacterRow>(
    `SELECT id, player_id, name, class, level, exp, gold, linh_chau, luong, schema_version, created_at
     FROM characters WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** List all characters for a player (account screen). */
export async function listByPlayer(pool: Pool, playerId: string): Promise<CharacterRow[]> {
  const { rows } = await pool.query<CharacterRow>(
    `SELECT id, player_id, name, class, level, exp, gold, linh_chau, luong, schema_version, created_at
     FROM characters WHERE player_id = $1 ORDER BY created_at ASC`,
    [playerId],
  );
  return rows;
}

/** Atomic level-up: set level=newLevel, exp=0 (or keep remainder per spec). */
export async function levelUp(
  pool: Pool,
  charId: string,
  newLevel: number,
  remainderExp: bigint = 0n,
): Promise<CharacterRow> {
  if (!Number.isInteger(newLevel) || newLevel < 1) {
    throw new Error(`levelUp: newLevel must be positive integer, got ${newLevel}`);
  }
  if (remainderExp < 0n) {
    throw new Error(`levelUp: remainderExp must be non-negative, got ${remainderExp}`);
  }
  const { rows } = await pool.query<CharacterRow>(
    `UPDATE characters
     SET level = $2, exp = $3
     WHERE id = $1
     RETURNING id, player_id, name, class, level, exp, gold, linh_chau, luong, schema_version, created_at`,
    [charId, newLevel, remainderExp.toString()],
  );
  const row = rows[0];
  if (!row) throw new Error(`levelUp: character ${charId} not found`);
  return row;
}

/** Atomic exp increment (negative delta supported for refund/correction). */
export async function addExp(pool: Pool, charId: string, delta: bigint): Promise<CharacterRow> {
  const { rows } = await pool.query<CharacterRow>(
    `UPDATE characters
     SET exp = GREATEST(0, exp + $2::bigint)
     WHERE id = $1
     RETURNING id, player_id, name, class, level, exp, gold, linh_chau, luong, schema_version, created_at`,
    [charId, delta.toString()],
  );
  const row = rows[0];
  if (!row) throw new Error(`addExp: character ${charId} not found`);
  return row;
}

export type Currency = 'gold' | 'linh_chau' | 'luong';

const CURRENCY_COLUMNS: Record<Currency, string> = {
  gold: 'gold',
  linh_chau: 'linh_chau',
  luong: 'luong',
};

/**
 * Strict allowlist of column names interpolated into UPDATE. Defense-in-depth
 * against callers casting around the Currency type. Any value not in this Set
 * is rejected before SQL interpolation.
 */
const ALLOWED_CURRENCY_COLUMNS: ReadonlySet<string> = new Set(
  Object.values(CURRENCY_COLUMNS),
);

/**
 * Atomic currency mutation. Throws if would go negative (CHECK constraint).
 * Caller wraps in transaction with economy_repository.logTransaction for audit.
 *
 * SQL safety: `col` is identifier-interpolated (not parameterized — pg has no
 * placeholder for column names). It is sourced only from the static
 * CURRENCY_COLUMNS map and verified against ALLOWED_CURRENCY_COLUMNS before
 * use, so it cannot carry caller-controlled input.
 */
export async function addCurrency(
  pool: Pool,
  charId: string,
  currency: Currency,
  delta: bigint,
): Promise<CharacterRow> {
  const col = CURRENCY_COLUMNS[currency];
  if (!col || !ALLOWED_CURRENCY_COLUMNS.has(col)) {
    throw new Error(`addCurrency: unknown currency ${currency}`);
  }
  const { rows } = await pool.query<CharacterRow>(
    `UPDATE characters
     SET ${col} = ${col} + $2::bigint
     WHERE id = $1
     RETURNING id, player_id, name, class, level, exp, gold, linh_chau, luong, schema_version, created_at`,
    [charId, delta.toString()],
  );
  const row = rows[0];
  if (!row) throw new Error(`addCurrency: character ${charId} not found`);
  return row;
}
