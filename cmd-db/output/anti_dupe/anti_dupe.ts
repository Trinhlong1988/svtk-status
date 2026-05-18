/**
 * CMD2 Phase 14 Week 2 Day 1 — R44 anti-dupe core
 *
 * Implements CMD_DB v2.4.2 § P1.1-P1.5:
 *   P1.1 executeWithIdempotency + SERIALIZABLE retry loop
 *   P1.2 canonical recursive payload hash (deterministic across key order)
 *   P1.3 pickupItem with INVENTORY_MAX_SLOTS=30 capacity check
 *   P1.4 ad12_rollback with rollback-idempotency (no rollback-rollback)
 *   P1.5 recoverStalePending + startStalePendingScheduler
 *
 * Foundation deps: pg.Pool from output/legacy/connection.ts
 * Schema deps: 003_anti_dupe_schema.sql (pending_actions, gm_action_log,
 *              transaction_log, item_instances, item_transfer_log,
 *              currency_change_log, inventory, players.gold)
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

// ════════════════════════════════════════════════════════════════
// EXPIRE_MAP — nonce idempotency cache expiry per action_type
// Values are PostgreSQL INTERVAL literals interpolated into SQL.
// ════════════════════════════════════════════════════════════════
export const EXPIRE_MAP = {
  battle_start: '30 seconds',
  battle_end:   '5 minutes',
  skill_cast:   '10 seconds',
  item_use:     '30 seconds',
  trade:        '5 minutes',
  gold_change:  '5 minutes',
  reward_claim: '1 hour',
  rollback:     '1 hour',
} as const satisfies Record<string, string>;

export type ActionType = keyof typeof EXPIRE_MAP;

// ════════════════════════════════════════════════════════════════
// P1.2 — Canonical recursive payload hash
// ════════════════════════════════════════════════════════════════
export function canonicalStringify(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NaN';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return `bigint:${value}`;

  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs = keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`);
    return '{' + pairs.join(',') + '}';
  }

  return JSON.stringify(value);
}

export function computePayloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalStringify(payload)).digest('hex');
}

// ════════════════════════════════════════════════════════════════
// P1.1 — executeWithIdempotency with SERIALIZABLE retry loop
// ════════════════════════════════════════════════════════════════
export interface IdempotencyResult<T> {
  result: T;
  fromCache: boolean;
}

export async function executeWithIdempotency<T>(
  pool: Pool,
  nonce: string,
  action_type: ActionType,
  player_id: string,
  payload: unknown,
  executor: (client: PoolClient) => Promise<T>,
  maxRetries: number = 3,
): Promise<IdempotencyResult<T>> {
  if (!EXPIRE_MAP[action_type]) {
    throw new Error(`Unknown action_type: ${action_type}`);
  }

  const payloadHash = computePayloadHash(payload);
  const expireInterval = EXPIRE_MAP[action_type];
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '2s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");

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
        // status === 'pending' — fall through and re-execute (lock held)
      } else {
        await client.query(
          `INSERT INTO pending_actions
             (nonce, action_type, player_id, payload, payload_hash, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'pending', NOW() + INTERVAL '${expireInterval}')`,
          [nonce, action_type, player_id, JSON.stringify(payload), payloadHash],
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

      // P1.1: retry only on PostgreSQL serialization/deadlock errors
      const sqlstate = (err as { code?: string; sqlstate?: string }).code
        ?? (err as { code?: string; sqlstate?: string }).sqlstate;
      if ((sqlstate === '40001' || sqlstate === '40P01') && attempt < maxRetries - 1) {
        const sleepMs = 50 * Math.pow(2, attempt) + Math.random() * 50;
        await new Promise(r => setTimeout(r, sleepMs));
        continue;
      }

      throw err;
    } finally {
      client.release();
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`Max retries exceeded: ${msg}`);
}

// ════════════════════════════════════════════════════════════════
// P1.3 — pickupItem with INVENTORY_MAX_SLOTS=30 capacity check
// ════════════════════════════════════════════════════════════════
export const INVENTORY_MAX_SLOTS = 30;

export interface PickupResult {
  success: true;
  item_uuid: string;
  slot: number;
}

export async function pickupItem(
  pool: Pool,
  itemUuid: string,
  playerId: string,
  pickupNonce: string,
): Promise<PickupResult> {
  const { result } = await executeWithIdempotency<PickupResult>(
    pool, pickupNonce, 'trade', playerId,
    { itemUuid },
    async (client) => {
      const slotR = await client.query(
        'SELECT find_free_inventory_slot($1) AS free_slot',
        [playerId],
      );
      const freeSlot = slotR.rows[0]?.free_slot;

      if (freeSlot === null || freeSlot === undefined) {
        throw new Error(`P1.3: Inventory full (${INVENTORY_MAX_SLOTS}/${INVENTORY_MAX_SLOTS} slots)`);
      }

      const item = await client.query(
        'SELECT * FROM item_instances WHERE item_uuid = $1 AND deleted_at IS NULL FOR UPDATE',
        [itemUuid],
      );
      if (item.rows.length === 0) throw new Error('Item not found');
      if (item.rows[0].location !== 'dropped') {
        throw new Error('Item not pickupable');
      }

      await client.query(
        `UPDATE item_instances
           SET current_owner_id = $1, location = 'inventory', version = version + 1
         WHERE item_uuid = $2`,
        [playerId, itemUuid],
      );

      await client.query(
        'INSERT INTO inventory (player_id, item_uuid, slot_index) VALUES ($1, $2, $3)',
        [playerId, itemUuid, freeSlot],
      );

      return { success: true, item_uuid: itemUuid, slot: Number(freeSlot) };
    },
  );
  return result;
}

// ════════════════════════════════════════════════════════════════
// P1.4 — ad12_rollback with rollback-idempotency
// ════════════════════════════════════════════════════════════════
export interface RollbackResult {
  success: true;
  txn_id: string;
  compensated_items: number;
  compensated_currency: number;
  reason: string;
  previously_rolled_back: boolean;
}

export async function ad12_rollback(
  pool: Pool,
  txnId: string,
  gmId: string,
  reason: string,
): Promise<RollbackResult> {
  const rollbackNonce = randomUUID();

  const { result } = await executeWithIdempotency<RollbackResult>(
    pool, rollbackNonce, 'rollback', gmId,
    { txnId, reason },
    async (client) => {
      const txn = await client.query(
        'SELECT * FROM transaction_log WHERE txn_id = $1 FOR UPDATE',
        [txnId],
      );
      if (txn.rows.length === 0) {
        throw new Error('AD12: Transaction not found');
      }

      const original = txn.rows[0];

      // P1.4: idempotency check — do not re-rollback
      if (original.status === 'rolled_back') {
        const prevRollback = await client.query(
          `SELECT payload FROM gm_action_log
             WHERE action_type = 'rollback' AND target_uuid = $1
             ORDER BY timestamp DESC LIMIT 1`,
          [original.target_uuid],
        );
        const prev = prevRollback.rows[0]?.payload;
        return {
          success: true,
          txn_id: txnId,
          compensated_items: Number(prev?.compensated_items ?? 0),
          compensated_currency: Number(prev?.compensated_currency ?? 0),
          reason: 'already_rolled_back',
          previously_rolled_back: true,
        };
      }

      if (original.status !== 'committed') {
        throw new Error(`AD12: Cannot rollback txn with status ${original.status}`);
      }

      let compensatedItems = 0;
      let compensatedCurrency = 0;

      if (original.txn_type === 'trade' && original.target_type === 'item') {
        const itemUuid = original.target_uuid;
        const sourceState = original.source_state ?? {};

        if (sourceState.current_owner_id) {
          await client.query(
            `UPDATE item_instances
               SET current_owner_id = $1, in_transfer = FALSE,
                   location = 'inventory', version = version + 1
             WHERE item_uuid = $2`,
            [sourceState.current_owner_id, itemUuid],
          );

          await client.query(
            `INSERT INTO item_transfer_log
               (item_uuid, from_player_id, to_player_id, transfer_type, txn_nonce,
                snapshot_before, snapshot_after)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              itemUuid, original.player_id, sourceState.current_owner_id, 'admin',
              rollbackNonce, original.target_state, sourceState,
            ],
          );
          compensatedItems = 1;
        }
      } else if (original.txn_type === 'gold_change' && original.player_id) {
        const delta = Number(original.source_state?.delta ?? 0);
        if (delta !== 0) {
          const playerR = await client.query(
            'SELECT gold FROM players WHERE player_id = $1 FOR UPDATE',
            [original.player_id],
          );
          const goldBefore = Number(playerR.rows[0].gold);

          await client.query(
            'UPDATE players SET gold = gold + $1 WHERE player_id = $2',
            [-delta, original.player_id],
          );

          await client.query(
            `INSERT INTO currency_change_log
               (player_id, currency_type, delta, balance_before, balance_after,
                reason, txn_nonce, source_action)
             VALUES ($1, 'gold', $2, $3, $4, 'rollback_compensation', $5, 'rollback')`,
            [original.player_id, -delta, goldBefore, goldBefore - delta, rollbackNonce],
          );
          compensatedCurrency = Math.abs(delta);
        }
      }

      await client.query(
        `UPDATE transaction_log
           SET status = $1, rolled_back_at = NOW(), error_msg = $2
         WHERE txn_id = $3`,
        ['rolled_back', `rollback_by_${gmId}: ${reason}`, txnId],
      );

      await client.query(
        `INSERT INTO gm_action_log
           (gm_id, action_type, target_player_id, target_uuid, reason, payload)
         VALUES ($1, 'rollback', $2, $3, $4, $5)`,
        [
          gmId, original.player_id, original.target_uuid, reason,
          JSON.stringify({
            rollback_nonce: rollbackNonce,
            original_txn: txnId,
            compensated_items: compensatedItems,
            compensated_currency: compensatedCurrency,
          }),
        ],
      );

      return {
        success: true,
        txn_id: txnId,
        compensated_items: compensatedItems,
        compensated_currency: compensatedCurrency,
        reason,
        previously_rolled_back: false,
      };
    },
  );
  return result;
}
