import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const ObjectiveSchema = z.object({
  type: z.enum(['talk_to', 'kill_count', 'collect', 'deliver', 'escort', 'explore']),
  target_npc_id: z.number().int().positive(),
  count: z.number().int().positive().optional(),
}).refine(
  (o) => (o.type === 'kill_count' || o.type === 'collect') ? o.count !== undefined : true,
  { message: 'kill_count/collect must have count' }
);

const QuestSchema = z.object({
  quest_id: z.string().regex(/^SVTK_Q_\d{4}$/),
  name: z.string().min(1),
  chain_id: z.string().regex(/^SVTK_CHAIN_[A-Z_]+$/),
  chain_position: z.number().int().nonnegative(),
  category: z.enum(['main', 'side', 'lore']),
  era: z.enum(['f1', 'g1']),
  giver_npc_id: z.number().int().positive(),
  giver_npc_name: z.string().min(1),
  giver_scene_id: z.number().int().nonnegative(),
  level_req: z.number().int().min(1).max(99),
  prerequisites: z.array(z.string().regex(/^SVTK_Q_\d{4}$/)),
  objectives: z.array(ObjectiveSchema).min(1),
  rewards: z.object({
    exp: z.number().int().positive().max(1_000_000),
    gold: z.number().int().positive().max(1_000_000),
    items: z.array(z.string()),
  }),
  dialog_tree_ref: z.string().regex(/^DLG_SVTK_CHAIN_[A-Z_]+_\d+$/),
  status: z.enum(['scaffold', 'live', 'deprecated']),
  schema_version: z.string(),
  generated_by: z.string(),
  generated_at: z.string(),
});

describe('R2 — Zod strict schema validation', () => {
  const quests = readFileSync(
    'C:/Users/Administrator/Desktop/SVTK_UPLOAD_WORK/repo/cmd-quest/output/registry/quest_full.jsonl',
    'utf8'
  ).trim().split('\n').map((l) => JSON.parse(l));

  it('all 150 quests parse strict schema', () => {
    const errors: string[] = [];
    for (const q of quests) {
      const r = QuestSchema.safeParse(q);
      if (!r.success) {
        errors.push(`${q.quest_id}: ${r.error.errors.map((e) => e.path.join('.') + ' ' + e.message).join('; ')}`);
      }
    }
    expect(errors, errors.slice(0, 5).join('\n')).toEqual([]);
    expect(quests).toHaveLength(150);
  });
});
