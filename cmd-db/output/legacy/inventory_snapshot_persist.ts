/**
 * Wire InventorySnapshot ↔ Postgres — Phase 13 Tuần 1 Mục 2.5.
 *
 * Save path (atomic single tx):
 *   1. Canonicalize input (codepoint sort per R32).
 *   2. INSERT combat_replays — authoritative blob + FNV-1a32 hash.
 *   3. REPLACE inventory_items — denormalized rows for SQL queryability.
 *
 * Load path:
 *   - loadLatestSnapshot — read combat_replays.snapshot_jsonb (authoritative).
 *   - reconstructSnapshotFromItems — rebuild from inventory_items rows via
 *     buildCanonicalInventorySnapshot (codepointCompare ordering).
 *
 * verifySnapshotIntegrity — re-hash loaded blob, match against stored hash.
 */
import type { Pool } from 'pg';
import {
  type InventorySnapshot,
  type InventoryItemSnapshot,
  type ActiveSetSnapshot,
  type CompanionEquipmentSnapshot,
  buildCanonicalInventorySnapshot,
  InventorySnapshotSchema,
  InventoryItemSnapshotSchema,
} from '../../../cmd-engine/output/economy/inventory_snapshot_schema.js';
import {
  serializeInventorySnapshot,
  computeInventoryChecksum,
} from '../../../cmd-engine/output/economy/economy_serialization_contract.js';
import { addItem } from './repositories/inventory_repository.js';

export interface SaveSnapshotInput {
  encounter_id: string;
  char_id: string;
  snapshot: InventorySnapshot;
}

export interface SaveSnapshotResult {
  replay_id: string;
  hash: string;
}

/**
 * Persist snapshot atomically (combat_replays + inventory_items).
 * UNIQUE(encounter_id, hash) absorbs idempotent re-save (same hash) — returns
 * existing replay_id instead of erroring.
 */
export async function saveSnapshot(
  pool: Pool,
  input: SaveSnapshotInput,
): Promise<SaveSnapshotResult> {
  const canonical = buildCanonicalInventorySnapshot(input.snapshot);
  const json = serializeInventorySnapshot(canonical, { skipCanonicalize: true });
  const hash = computeInventoryChecksum(canonical);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const replayRes = await client.query<{ id: string }>(
      `INSERT INTO combat_replays (encounter_id, char_id, snapshot_jsonb, hash, schema_version)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (encounter_id, hash) DO UPDATE SET schema_version = EXCLUDED.schema_version
       RETURNING id`,
      [input.encounter_id, input.char_id, json, hash, canonical.snapshot_version],
    );
    const replayRow = replayRes.rows[0];
    if (!replayRow) throw new Error('saveSnapshot: combat_replays did not return row');

    await client.query('DELETE FROM inventory_items WHERE char_id = $1', [input.char_id]);
    for (const item of canonical.items) {
      await addItem(client, {
        char_id: input.char_id,
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
    return { replay_id: replayRow.id, hash };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface LoadSnapshotResult {
  snapshot: InventorySnapshot;
  hash: string;
  replay_id: string;
}

/**
 * Read most recent combat_replays row for character; deserialize via Zod.
 * Returns null if no snapshot exists.
 */
export async function loadLatestSnapshot(
  pool: Pool,
  charId: string,
): Promise<LoadSnapshotResult | null> {
  const { rows } = await pool.query<{ id: string; snapshot_jsonb: unknown; hash: string }>(
    `SELECT id, snapshot_jsonb, hash
     FROM combat_replays
     WHERE char_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [charId],
  );
  const row = rows[0];
  if (!row) return null;
  const parsed = InventorySnapshotSchema.safeParse(row.snapshot_jsonb);
  if (!parsed.success) {
    throw new Error(
      `loadLatestSnapshot: schema FAIL char_id=${charId}: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  return { snapshot: parsed.data, hash: row.hash, replay_id: row.id };
}

export interface ReconstructInput {
  char_id: string;
  player_id: string;
  snapshot_tick: number;
  active_sets: ActiveSetSnapshot[];
  companion_equipment: CompanionEquipmentSnapshot[];
  versioning: InventorySnapshot['versioning'];
}

/**
 * Rebuild canonical snapshot from inventory_items rows (denorm path).
 * Caller supplies auxiliary fields (active_sets / companion_equipment /
 * versioning) which are not stored in inventory_items.
 *
 * Sort canonical via buildCanonicalInventorySnapshot (codepointCompare).
 */
export async function reconstructSnapshotFromItems(
  pool: Pool,
  input: ReconstructInput,
): Promise<InventorySnapshot> {
  const { rows } = await pool.query<{
    instance_id: string;
    item_id: string;
    slot: string | null;
    rarity: string | null;
    stats_jsonb: unknown;
    affixes_jsonb: unknown;
    set_id: string | null;
    equipped_on_companion: string | null;
    upgrade_tier: number;
    acquired_tick: string;
  }>(
    `SELECT instance_id, item_id, slot, rarity, stats_jsonb, affixes_jsonb,
            set_id, equipped_on_companion, upgrade_tier, acquired_tick
     FROM inventory_items
     WHERE char_id = $1`,
    [input.char_id],
  );

  const items: InventoryItemSnapshot[] = rows.map((r) => {
    // BIGINT → string from pg driver. Guard against precision loss when
    // converting to JS number (Zod schema expects integer ≤ 2^53).
    const acquired = Number(r.acquired_tick);
    if (!Number.isSafeInteger(acquired)) {
      throw new Error(
        `reconstructSnapshotFromItems: acquired_tick exceeds Number.MAX_SAFE_INTEGER for item ${r.instance_id}: ${r.acquired_tick}`,
      );
    }
    const parsed = InventoryItemSnapshotSchema.safeParse({
      instance_id: r.instance_id,
      item_id: r.item_id,
      slot: r.slot,
      rarity: r.rarity,
      stats: r.stats_jsonb,
      affixes: r.affixes_jsonb,
      set_id: r.set_id,
      equipped_on_companion: r.equipped_on_companion,
      upgrade_tier: r.upgrade_tier,
      acquired_tick: acquired,
    });
    if (!parsed.success) {
      throw new Error(
        `reconstructSnapshotFromItems: item ${r.instance_id} schema FAIL: ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    return parsed.data;
  });

  return buildCanonicalInventorySnapshot({
    player_id: input.player_id,
    snapshot_tick: input.snapshot_tick,
    items,
    active_sets: input.active_sets,
    companion_equipment: input.companion_equipment,
    versioning: input.versioning,
  });
}

export interface IntegrityResult {
  ok: boolean;
  stored_hash?: string;
  recomputed_hash?: string;
}

/**
 * Verify byte-identical roundtrip: load combat_replays.snapshot_jsonb,
 * recompute checksum, compare with stored hash. Detects corruption / drift.
 */
export async function verifySnapshotIntegrity(
  pool: Pool,
  charId: string,
): Promise<IntegrityResult> {
  const loaded = await loadLatestSnapshot(pool, charId);
  if (!loaded) return { ok: false };
  const recomputed = computeInventoryChecksum(loaded.snapshot);
  return {
    ok: recomputed === loaded.hash,
    stored_hash: loaded.hash,
    recomputed_hash: recomputed,
  };
}
