/**
 * R44 W1 — T1 SERIALIZABLE battle transaction wrapper
 *
 * Wraps combat session lifecycle (start/end) in PostgreSQL SERIALIZABLE
 * isolation with idempotency + retry. Used by cmd-engine (CMD1) for combat
 * session bracketing per Foundation v2.8.0 R44.
 *
 * Contract:
 *   - SERIALIZABLE isolation (max conflict detection)
 *   - 40001/40P01 → retry up to 3× with exponential backoff + jitter
 *   - nonce reuse with same payload → cached return (idempotent)
 *   - nonce reuse with different payload → spoof error
 *
 * Cross-CMD: cmd-engine combat_runtime calls `withBattleStart` / `withBattleEnd`.
 */
import type { Pool, PoolClient } from 'pg';
import { executeWithIdempotency, type IdempotencyResult } from '../anti_dupe/anti_dupe.js';

export interface BattleStartPayload {
  encounter_id: string;
  seed_root: string;
  party_ids: readonly string[];
  boss_id?: string;
}

export interface BattleEndPayload {
  encounter_id: string;
  outcome: 'victory' | 'defeat' | 'flee' | 'aborted';
  turn_count: number;
}

/** W1 START — open battle session, T1 SERIALIZABLE. */
export async function withBattleStart<T>(
  pool: Pool,
  nonce: string,
  player_id: string,
  payload: BattleStartPayload,
  executor: (client: PoolClient) => Promise<T>,
): Promise<IdempotencyResult<T>> {
  return executeWithIdempotency<T>(pool, nonce, 'battle_start', player_id, payload, executor);
}

/** W1 END — close battle session, T1 SERIALIZABLE. */
export async function withBattleEnd<T>(
  pool: Pool,
  nonce: string,
  player_id: string,
  payload: BattleEndPayload,
  executor: (client: PoolClient) => Promise<T>,
): Promise<IdempotencyResult<T>> {
  return executeWithIdempotency<T>(pool, nonce, 'battle_end', player_id, payload, executor);
}
