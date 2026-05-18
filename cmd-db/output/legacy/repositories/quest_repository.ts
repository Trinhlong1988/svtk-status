/**
 * Quest progress repository — CMD3 coord (CMD2 owns DDL only).
 *
 * objectives_jsonb shape defined by CMD3 progression schema. CMD2 stores
 * opaque blob with UNIQUE(char_id, quest_id) constraint and (char_id, completed_at)
 * index for "completed quests" lookups.
 *
 * Concurrency: progress updates use INSERT … ON CONFLICT UPDATE (upsert).
 */
import type { Pool } from 'pg';

export interface QuestProgressRow {
  id: string;
  char_id: string;
  quest_id: string;
  step: number;
  objectives_jsonb: unknown;
  completed_at: Date | null;
  schema_version: number;
  updated_at: Date;
}

export interface UpsertProgressInput {
  char_id: string;
  quest_id: string;
  step: number;
  objectives: unknown;
}

/**
 * Upsert quest progress. Increments step + replaces objectives blob.
 * Preserves completed_at if already set (idempotent on re-completion).
 */
export async function upsertProgress(
  pool: Pool,
  input: UpsertProgressInput,
): Promise<QuestProgressRow> {
  if (!Number.isInteger(input.step) || input.step < 0) {
    throw new Error(`upsertProgress: step must be non-negative integer, got ${input.step}`);
  }
  const { rows } = await pool.query<QuestProgressRow>(
    `INSERT INTO quest_progress (char_id, quest_id, step, objectives_jsonb, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW())
     ON CONFLICT (char_id, quest_id) DO UPDATE
       SET step = EXCLUDED.step,
           objectives_jsonb = EXCLUDED.objectives_jsonb,
           updated_at = NOW()
     RETURNING *`,
    [input.char_id, input.quest_id, input.step, JSON.stringify(input.objectives)],
  );
  const row = rows[0];
  if (!row) throw new Error('upsertProgress: upsert did not return row');
  return row;
}

/** Mark quest completed (sets completed_at = NOW() if not already set). */
export async function completeQuest(
  pool: Pool,
  charId: string,
  questId: string,
): Promise<QuestProgressRow | null> {
  const { rows } = await pool.query<QuestProgressRow>(
    `UPDATE quest_progress
     SET completed_at = COALESCE(completed_at, NOW()),
         updated_at = NOW()
     WHERE char_id = $1 AND quest_id = $2
     RETURNING *`,
    [charId, questId],
  );
  return rows[0] ?? null;
}

/** Read progress for one quest. */
export async function getProgress(
  pool: Pool,
  charId: string,
  questId: string,
): Promise<QuestProgressRow | null> {
  const { rows } = await pool.query<QuestProgressRow>(
    `SELECT * FROM quest_progress
     WHERE char_id = $1 AND quest_id = $2`,
    [charId, questId],
  );
  return rows[0] ?? null;
}

/** List all progress rows for a character, sorted by quest_id ASC (canonical). */
export async function listByCharacter(
  pool: Pool,
  charId: string,
): Promise<QuestProgressRow[]> {
  const { rows } = await pool.query<QuestProgressRow>(
    `SELECT * FROM quest_progress
     WHERE char_id = $1
     ORDER BY quest_id ASC`,
    [charId],
  );
  return rows;
}

/** List completed quest ids for a character. */
export async function listCompleted(pool: Pool, charId: string): Promise<string[]> {
  const { rows } = await pool.query<{ quest_id: string }>(
    `SELECT quest_id FROM quest_progress
     WHERE char_id = $1 AND completed_at IS NOT NULL
     ORDER BY quest_id ASC`,
    [charId],
  );
  return rows.map((r) => r.quest_id);
}
