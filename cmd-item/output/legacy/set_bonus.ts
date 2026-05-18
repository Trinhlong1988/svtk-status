/**
 * SET BONUS — load sets.json + resolve active bonus theo piece count.
 *
 * spec/08 Mục VII. Set bonus = utility/conditional, KHÔNG flat damage (R27).
 *
 * Pure function. Deterministic.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Item } from './item_registry.js';
import type { ItemPassive } from './itemization_types.js';
import { codepointCompare } from '../_shared/codepoint_compare.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, '../../data');

// ───────── Conflict Policy (CMD2.docx FINAL FIX #9) ─────────
export const SetBonusConflictPolicySchema = z.enum([
  'strongest_only',     // Lấy bonus mạnh nhất per passive_type
  'additive',           // Cộng dồn value_bp_or_raw
  'exclusive_group',    // Chỉ 1 set active (highest piece count wins)
  'diminishing_return', // Stack với DR /2 mỗi entry sau
]);
export type SetBonusConflictPolicy = z.infer<typeof SetBonusConflictPolicySchema>;

// ───────── Schema ─────────
const SetBonusEntrySchema = z.object({
  pieces: z.number().int().positive(),
  passive_type: z.string().min(1),
  value_bp_or_raw: z.number().int(),
  condition: z.string().optional(),
});

const SetSchema = z.object({
  set_id: z.string().regex(/^set_/),
  name_vi: z.string().min(1),
  archetype: z.string().optional(),
  pieces: z.array(z.string().regex(/^item_/)).optional().transform(v => v ?? []),
  conflict_policy: SetBonusConflictPolicySchema.default('strongest_only'),
  bonuses: z.array(SetBonusEntrySchema),
});
export type SetDef = z.infer<typeof SetSchema>;

const SetsFileSchema = z.object({
  sets: z.array(SetSchema),
}).passthrough();

let cachedSets: Map<string, SetDef> | null = null;

function loadSets(): Map<string, SetDef> {
  if (cachedSets) return cachedSets;
  const raw = JSON.parse(readFileSync(join(DATA_ROOT, 'sets.json'), 'utf8'));
  const parsed = SetsFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`[SetBonus] sets.json FAIL:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
  const map = new Map<string, SetDef>();
  for (const s of parsed.data.sets) map.set(s.set_id, s);
  cachedSets = map;
  return cachedSets;
}

/**
 * Resolve set bonus active từ items equipped.
 *
 * @param items   Items equipped
 * @returns       { active_set_ids, bonus_passives } — bonus apply như passive
 */
export function resolveSetBonuses(items: readonly Item[]): {
  active_set_ids: string[];
  bonus_passives: ItemPassive[];
} {
  const sets = loadSets();

  // Count pieces per set
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.set_id) continue;
    counts.set(item.set_id, (counts.get(item.set_id) ?? 0) + 1);
  }

  const active_set_ids: string[] = [];
  const bonus_passives: ItemPassive[] = [];

  // Sort set_ids alphabetical cho deterministic order
  const sortedSetIds = [...counts.keys()].sort((a, b) => codepointCompare(a, b));

  for (const set_id of sortedSetIds) {
    const def = sets.get(set_id);
    if (!def) continue; // unknown set_id silently skip
    const piece_count = counts.get(set_id)!;
    let any_active = false;
    // Sort bonuses by pieces threshold ASC
    const sortedBonuses = [...def.bonuses].sort((a, b) => a.pieces - b.pieces);
    for (const b of sortedBonuses) {
      if (piece_count >= b.pieces) {
        any_active = true;
        bonus_passives.push({
          type: b.passive_type,
          value_bp_or_raw: b.value_bp_or_raw,
          condition: b.condition,
          passive_priority: 200, // Set bonus priority — lower than item passive (100) for tie-break
        });
      }
    }
    if (any_active) active_set_ids.push(set_id);
  }

  // Apply per-set conflict policy at type level
  const polished = applyConflictPolicy(bonus_passives, sets);

  return { active_set_ids, bonus_passives: polished };
}

/** Apply conflict policy aggregation per passive_type. */
function applyConflictPolicy(
  bonuses: ItemPassive[],
  sets: Map<string, SetDef>,
): ItemPassive[] {
  if (bonuses.length === 0) return bonuses;

  // Group by passive_type
  const byType = new Map<string, ItemPassive[]>();
  for (const b of bonuses) {
    const list = byType.get(b.type) ?? [];
    list.push(b);
    byType.set(b.type, list);
  }

  // Find policy per passive_type — lookup từ first set có passive_type này
  // (Spec assumption: passive_type belong to 1 set policy. Multi-set same passive: use 'strongest_only' default.)
  const policy_for_type = new Map<string, SetBonusConflictPolicy>();
  for (const set_def of sets.values()) {
    for (const bonus of set_def.bonuses) {
      if (!policy_for_type.has(bonus.passive_type)) {
        policy_for_type.set(bonus.passive_type, set_def.conflict_policy);
      }
    }
  }

  const result: ItemPassive[] = [];
  // Sort types deterministic
  const sortedTypes = [...byType.keys()].sort((a, b) => codepointCompare(a, b));
  for (const type of sortedTypes) {
    const list = byType.get(type)!;
    const policy = policy_for_type.get(type) ?? 'strongest_only';
    if (list.length === 1) {
      result.push(list[0]!);
      continue;
    }
    switch (policy) {
      case 'strongest_only': {
        // Pick highest value_bp_or_raw, ties broken by passive_priority ASC
        const sorted = [...list].sort((a, b) => {
          if (a.value_bp_or_raw !== b.value_bp_or_raw) return b.value_bp_or_raw - a.value_bp_or_raw;
          return a.passive_priority - b.passive_priority;
        });
        result.push(sorted[0]!);
        break;
      }
      case 'additive': {
        const total = list.reduce((s, p) => s + p.value_bp_or_raw, 0);
        result.push({
          type,
          value_bp_or_raw: total,
          passive_priority: list[0]!.passive_priority,
        });
        break;
      }
      case 'exclusive_group': {
        // Pick first deterministic (sorted by value DESC then priority ASC)
        const sorted = [...list].sort((a, b) => {
          if (a.value_bp_or_raw !== b.value_bp_or_raw) return b.value_bp_or_raw - a.value_bp_or_raw;
          return a.passive_priority - b.passive_priority;
        });
        result.push(sorted[0]!);
        break;
      }
      case 'diminishing_return': {
        // 1st full, 2nd /2, 3rd /4...
        const sorted = [...list].sort((a, b) => b.value_bp_or_raw - a.value_bp_or_raw);
        let total = 0;
        for (let i = 0; i < sorted.length; i++) {
          const divisor = 1 << i; // 1, 2, 4, 8...
          total += Math.floor(sorted[i]!.value_bp_or_raw / divisor);
        }
        result.push({
          type,
          value_bp_or_raw: total,
          passive_priority: sorted[0]!.passive_priority,
        });
        break;
      }
    }
  }
  return result;
}

/** Test-only cache reset. */
export function _resetSetsCache(): void {
  cachedSets = null;
}
