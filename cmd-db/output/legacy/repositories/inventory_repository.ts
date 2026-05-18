/**
 * Inventory repository — per-character item instances.
 *
 * affixes_jsonb is stored sorted lex ASC by id (canonical per R32).
 * Caller is responsible for sorting before passing to addItem/saveItems;
 * helper sortAffixesCanonical lives in modules/economy/inventory_snapshot_schema.ts.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  InventoryItemSnapshot,
} from '../../../../cmd-engine/output/economy/inventory_snapshot_schema.js';

export interface InventoryRow {
  id: string;
  char_id: string;
  instance_id: string;
  item_id: string;
  qty: number;
  slot: string | null;
  rarity: string | null;
  stats_jsonb: unknown;
  affixes_jsonb: unknown;
  set_id: string | null;
  equipped_on_companion: string | null;
  upgrade_tier: number;
  /** BIGINT — string from driver. */
  acquired_tick: string;
  schema_version: number;
  created_at: Date;
}

export interface AddItemInput {
  char_id: string;
  instance_id: string;
  item_id: string;
  qty?: number;
  slot?: string | null;
  rarity?: string | null;
  stats?: unknown;
  affixes?: unknown;
  set_id?: string | null;
  equipped_on_companion?: string | null;
  upgrade_tier?: number;
  acquired_tick?: bigint;
}

/** Insert one item instance. Throws on duplicate (char_id, instance_id). */
export async function addItem(
  executor: Pool | PoolClient,
  input: AddItemInput,
): Promise<InventoryRow> {
  const { rows } = await executor.query<InventoryRow>(
    `INSERT INTO inventory_items (
       char_id, instance_id, item_id, qty, slot, rarity,
       stats_jsonb, affixes_jsonb, set_id, equipped_on_companion,
       upgrade_tier, acquired_tick
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7::jsonb, $8::jsonb, $9, $10,
       $11, $12::bigint
     ) RETURNING *`,
    [
      input.char_id,
      input.instance_id,
      input.item_id,
      input.qty ?? 1,
      input.slot ?? null,
      input.rarity ?? null,
      JSON.stringify(input.stats ?? {}),
      JSON.stringify(input.affixes ?? []),
      input.set_id ?? null,
      input.equipped_on_companion ?? null,
      input.upgrade_tier ?? 0,
      (input.acquired_tick ?? 0n).toString(),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('addItem: INSERT did not return row');
  return row;
}

/** Remove item by (char_id, instance_id). Returns deleted row or null. */
export async function removeItem(
  executor: Pool | PoolClient,
  charId: string,
  instanceId: string,
): Promise<InventoryRow | null> {
  const { rows } = await executor.query<InventoryRow>(
    `DELETE FROM inventory_items
     WHERE char_id = $1 AND instance_id = $2
     RETURNING *`,
    [charId, instanceId],
  );
  return rows[0] ?? null;
}

/** Load all items for a character, sorted by instance_id ASC (canonical). */
export async function listByCharacter(
  executor: Pool | PoolClient,
  charId: string,
): Promise<InventoryRow[]> {
  const { rows } = await executor.query<InventoryRow>(
    `SELECT * FROM inventory_items
     WHERE char_id = $1
     ORDER BY instance_id ASC`,
    [charId],
  );
  return rows;
}

/** Atomic slot swap (re-equip flow). */
export async function setSlot(
  executor: Pool | PoolClient,
  charId: string,
  instanceId: string,
  newSlot: string | null,
): Promise<InventoryRow | null> {
  const { rows } = await executor.query<InventoryRow>(
    `UPDATE inventory_items
     SET slot = $3
     WHERE char_id = $1 AND instance_id = $2
     RETURNING *`,
    [charId, instanceId, newSlot],
  );
  return rows[0] ?? null;
}

/**
 * Bulk replace character inventory with snapshot items. Single transaction
 * (caller may pass PoolClient inside outer tx; otherwise uses pool transaction).
 *
 * Strategy: DELETE all current items for char, then INSERT all snapshot items.
 * Caller responsible for sort canonicalization before passing (use
 * buildCanonicalInventorySnapshot).
 */
export async function replaceInventoryFromSnapshot(
  pool: Pool,
  charId: string,
  items: InventoryItemSnapshot[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM inventory_items WHERE char_id = $1', [charId]);
    for (const item of items) {
      await addItem(client, {
        char_id: charId,
        instance_id: item.instance_id,
        item_id: item.item_id,
        slot: item.slot,
        rarity: item.rarity,
        stats: item.stats,
        affixes: item.affixes,
        set_id: item.set_id,
        equipped_on_companion: item.equipped_on_companion,
        upgrade_tier: item.upgrade_tier,
        acquired_tick: BigInt(item.acquired_tick),
      });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
