/**
 * R44 W2 — T2 REPEATABLE READ action transaction wrapper
 *
 * Per-action (skill cast, item use, loot, gold change, reward claim) wrapper
 * with REPEATABLE READ isolation. Lower than SERIALIZABLE for throughput on
 * read-mostly action paths while still preventing non-repeatable reads.
 *
 * Same idempotency semantics as `executeWithIdempotency` — uses the
 * `pending_actions` table for nonce dedup + payload-hash spoof detection.
 *
 * Per CMD_DB v2.4.2 § P1.1 SERIALIZABLE retry loop is the strong default;
 * this REPEATABLE READ variant is exposed separately so callers can opt-in.
 */
import type { Pool, PoolClient } from 'pg';
import {
  EXPIRE_MAP,
  computePayloadHash,
  type ActionType,
  type IdempotencyResult,
} from '../anti_dupe/anti_dupe.js';

/** Action types eligible for W2 REPEATABLE READ wrap (per Foundation v2.8.0 R44). */
export type W2ActionType = Extract<
  ActionType,
  'skill_cast' | 'item_use' | 'trade' | 'gold_change' | 'reward_claim'
>;

const W2_ACTION_TYPES: ReadonlySet<W2ActionType> = new Set([
  'skill_cast', 'item_use', 'trade', 'gold_change', 'reward_claim',
]);

/** W2 — REPEATABLE READ action with idempotency + retry. */
export async function withActionTxn<T>(
  pool: Pool,
  nonce: string,
  action_type: W2ActionType,
  player_id: string,
  payload: unknown,
  executor: (client: PoolClient) => Promise<T>,
  maxRetries: number = 3,
): Promise<IdempotencyResult<T>> {
  if (!W2_ACTION_TYPES.has(action_type)) {
    throw new Error(`W2 rejects action_type ${action_type} (use W1 for battle_*, AD12 for rollback)`);
  }
  const payloadHash = computePayloadHash(payload);
  const expireInterval = EXPIRE_MAP[action_type];
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query("SET LOCAL statement_timeout = '1s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '5s'");

      const existing = await client.query(
        'SELECT result, status, payload_hash FROM pending_actions WHERE nonce = $1 FOR UPDATE',
        [nonce],
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.payload_hash !== payloadHash) {
          throw new Error('Nonce reuse with different payload (spoof attempt)');
        }
        if (row.status === 'committed') {
          await client.query('COMMIT');
          return { result: row.result as T, fromCache: true };
        }
        if (row.status === 'duplicate_rejected' || row.status === 'failed') {
          throw new Error(`Action ${nonce} already ${row.status}`);
        }
      } else {
        await client.query(
          `INSERT INTO pending_actions
             (nonce, action_type, player_id, payload, payload_hash, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'pending', NOW() + ($6)::interval)`,
          [nonce, action_type, player_id, JSON.stringify(payload), payloadHash, expireInterval],
        );
      }

      const result = await executor(client);

      await client.query(
        'UPDATE pending_actions SET status = $1, result = $2, completed_at = NOW() WHERE nonce = $3',
        ['committed', JSON.stringify(result), nonce],
      );

      await client.query('COMMIT');
      return { result, fromCache: false };
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => {});
      lastErr = err;
      const sqlstate = (err as { code?: string; sqlstate?: string }).code
        ?? (err as { code?: string; sqlstate?: string }).sqlstate;
      if ((sqlstate === '40001' || sqlstate === '40P01') && attempt < maxRetries - 1) {
        const sleepMs = 30 * Math.pow(2, attempt) + Math.random() * 30;
        await new Promise(r => setTimeout(r, sleepMs));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`W2 max retries exceeded: ${msg}`);
}
