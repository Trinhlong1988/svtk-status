/**
 * COMPANION AFFINITY PERSISTENCE — Phase 13 Tuần 1 (CMD3 Day 3).
 *
 * Bridges in-memory `CompanionAffinityStore` ↔ DB `companion_affinity` table.
 *
 * Storage strategy:
 *   - One row per (char_id, companion_id) pair.
 *   - `char_id` column = numeric DB character.id (FK to characters).
 *   - `companion_id` column = QuestCharId string (e.g. `companion_yet_kieu_p1`).
 *   - `tier` / `points` / `next_tier_threshold` / `last_bond_ordinal` columns mirror
 *     the in-memory CompanionAffinity shape 1:1.
 *   - `schema_version` column defaults 2 (R32 DETERMINISM SWEEP — sort drift gate).
 *
 * The DB row does NOT store the QuestCharId string of the OWNER character —
 * that's a per-row constant for any (char_id) selection. The caller (API layer)
 * supplies `ownerQuestCharId` when hydrating so every returned record gets the
 * correct `char_id: QuestCharId` field re-attached.
 *
 * R32: rejects rows whose `schema_version < 2` on load.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  CompanionAffinity,
  CompanionAffinityTier,
  QuestCharId,
} from './quest_types.js';
import { codepointCompare } from '../../_shared/codepoint_compare.js';
import { CompanionAffinityStore } from './companion_affinity_store.js';

export const COMPANION_AFFINITY_MIN_SCHEMA_VERSION = 2;

const KNOWN_TIERS: readonly CompanionAffinityTier[] = [
  'stranger',
  'familiar',
  'trusted',
  'bonded',
  'soulbound',
];

interface AffinityRow {
  companion_id: string;
  tier: string;
  points: string | number;
  next_tier_threshold: string | number;
  last_bond_ordinal: string | number;
  schema_version: number;
}

/**
 * Upsert one affinity row. Idempotent on re-save.
 */
export async function saveCompanionAffinity(
  client: Pool | PoolClient,
  dbCharId: string,
  affinity: CompanionAffinity,
): Promise<void> {
  await client.query(
    `INSERT INTO companion_affinity
       (char_id, companion_id, tier, points, next_tier_threshold, last_bond_ordinal,
        schema_version, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (char_id, companion_id) DO UPDATE
       SET tier                = EXCLUDED.tier,
           points              = EXCLUDED.points,
           next_tier_threshold = EXCLUDED.next_tier_threshold,
           last_bond_ordinal   = EXCLUDED.last_bond_ordinal,
           schema_version      = EXCLUDED.schema_version,
           updated_at          = NOW()`,
    [
      dbCharId,
      affinity.companion_id,
      affinity.tier,
      affinity.points,
      affinity.next_tier_threshold,
      affinity.last_bond_ordinal,
      COMPANION_AFFINITY_MIN_SCHEMA_VERSION,
    ],
  );
}

/**
 * Bulk save all affinity rows for one character atomically.
 */
export async function saveAllCompanionAffinity(
  pool: Pool,
  dbCharId: string,
  affinities: readonly CompanionAffinity[],
): Promise<void> {
  if (affinities.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sorted = affinities.slice().sort((a, b) =>
      codepointCompare(a.companion_id, b.companion_id),
    );
    for (const a of sorted) {
      await saveCompanionAffinity(client, dbCharId, a);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Load all affinity rows for one character. Returns canonical (companion_id ASC)
 * order with `char_id` field rebound to caller-supplied QuestCharId.
 */
export async function loadAllCompanionAffinity(
  pool: Pool | PoolClient,
  dbCharId: string,
  ownerQuestCharId: QuestCharId,
): Promise<CompanionAffinity[]> {
  const { rows } = await pool.query<AffinityRow>(
    `SELECT companion_id, tier, points, next_tier_threshold, last_bond_ordinal,
            schema_version
     FROM companion_affinity
     WHERE char_id = $1
     ORDER BY companion_id ASC`,
    [dbCharId],
  );
  const result: CompanionAffinity[] = [];
  for (const r of rows) {
    if (r.schema_version < COMPANION_AFFINITY_MIN_SCHEMA_VERSION) {
      throw new Error(
        `companion_affinity row schema_version ${r.schema_version} < ` +
          `${COMPANION_AFFINITY_MIN_SCHEMA_VERSION} for char ${dbCharId} ` +
          `companion ${r.companion_id} — run migration before reload`,
      );
    }
    if (!isKnownTier(r.tier)) {
      throw new Error(
        `companion_affinity row tier '${r.tier}' unknown for char ${dbCharId} ` +
          `companion ${r.companion_id}`,
      );
    }
    result.push({
      char_id: ownerQuestCharId,
      companion_id: r.companion_id as QuestCharId,
      tier: r.tier,
      points: Number(r.points),
      next_tier_threshold: Number(r.next_tier_threshold),
      last_bond_ordinal: Number(r.last_bond_ordinal),
    });
  }
  return result;
}

/**
 * Hydrate a `CompanionAffinityStore` from DB state. Replaces the store's
 * in-memory map atomically via the existing `restore()` API.
 */
export async function hydrateCompanionAffinityStore(
  pool: Pool | PoolClient,
  dbCharId: string,
  ownerQuestCharId: QuestCharId,
  store: CompanionAffinityStore,
  ordinal: number,
): Promise<void> {
  const affinities = await loadAllCompanionAffinity(pool, dbCharId, ownerQuestCharId);
  store.restore({
    schema_version: 1,
    affinities,
    ordinal,
  });
}

/**
 * Persist current in-memory store state for one character. Reads
 * `listCompanionsForChar(ownerQuestCharId)` and bulk-upserts.
 */
export async function persistCompanionAffinityStore(
  pool: Pool,
  dbCharId: string,
  ownerQuestCharId: QuestCharId,
  store: CompanionAffinityStore,
): Promise<void> {
  const affinities = store.listCompanionsForChar(ownerQuestCharId);
  await saveAllCompanionAffinity(pool, dbCharId, affinities);
}

function isKnownTier(tier: string): tier is CompanionAffinityTier {
  return (KNOWN_TIERS as readonly string[]).includes(tier);
}
