/**
 * LOOT GENERATION RUNTIME — Implementation (Phase 11 Batch 5.2).
 *
 * Replaces Phase 7 stub `loot_generation_hooks.ts` cho PROD pipeline.
 *
 * Determinism guarantee:
 *   - Cùng (seed_root, encounter_id, drop_index) → identical LootRollResult[]
 *   - rng_loot stream isolated từ rng_affix / rng_combat / rng_quest
 *   - Replay-safe: same context replay = same output ALWAYS
 *
 * Cross-module dependency:
 *   - itemization affix runtime (`createAffixRuntime`) — affix roll qua rng_affix
 *   - itemization item registry (`loadItemsRegistry`, `getItem`) — set piece resolve
 *
 * Layer 1 DATA: load `data/loot_tables.json` qua Zod (validate sum=10000 BP / table).
 * Layer 2 LOGIC: pure deterministic transform — no I/O sau khi load.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createRNG, type RNG } from '../../legacy/rng.js';
import {
  type EquipmentSlot,
  type Rarity,
  type ItemAffix,
  RaritySchema,
  EquipmentSlotSchema,
} from '../../../../cmd-item/output/legacy/itemization_types.js';
import { createAffixRuntime, type AffixRuntime } from '../../../../cmd-item/output/legacy/affix_runtime.js';
import { codepointCompare } from '../../_shared/codepoint_compare.js';
import { loadItemsRegistry, type Item } from '../../../../cmd-item/output/legacy/item_registry.js';
import {
  type LootGenerationRuntime,
  type LootContext,
  type LootRollResult,
  type LootTable,
  type LootReplayAuditResult,
  LootContextSchema,
  LootTableSchema,
} from './loot_generation_runtime.js';
import { stripDocKeys } from '../_schema_helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, '../../../../cmd-item/data');

// ───────── Loot table file schema (Batch 5.4 C1 strict) ─────────
// stripDocKeys() removes `_doc`/`_locked_by`/`_dna_lock`/`_seed_pattern`/`_validation` annotations.
// LootTableSchema strict mode rejects unknown keys per table (caller typo guard).
const LootTablesFileSchema = z.object({
  tables: z.record(z.string(), LootTableSchema.strict()),
}).strict();

const RARITY_LIST: readonly Rarity[] = ['common', 'rare', 'epic', 'legendary', 'mythic'];
const RARITY_WEIGHT_SUM_BP = 10000;

// ───────── Singleton cache ─────────
interface LootTablesCache {
  tables: Map<string, LootTable>;
  ids: readonly string[];
}
let cachedTables: LootTablesCache | null = null;

/** Load + validate loot_tables.json. Throws if rarity_weights sum != 10000 BP / table. */
function loadLootTables(): LootTablesCache {
  if (cachedTables) return cachedTables;
  const rawJson = JSON.parse(readFileSync(join(DATA_ROOT, 'loot_tables.json'), 'utf8'));
  // Batch 5.4 C1: strip safe doc keys at file level + nested table level → strict reject typo.
  const cleaned = stripDocKeys(rawJson);
  const parsed = LootTablesFileSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(
      `[LootRuntime] loot_tables.json STRICT FAIL:\n${JSON.stringify(parsed.error.issues, null, 2)}`,
    );
  }
  const map = new Map<string, LootTable>();
  for (const [id, raw_table] of Object.entries(parsed.data.tables)) {
    const t = raw_table as LootTable;
    const sum = RARITY_LIST.reduce((acc, r) => acc + (t.rarity_weights[r] ?? 0), 0);
    if (sum !== RARITY_WEIGHT_SUM_BP) {
      throw new Error(
        `[LootRuntime] table "${id}" rarity_weights sum = ${sum} BP, expect ${RARITY_WEIGHT_SUM_BP}`,
      );
    }
    if (t.drop_count_max < t.drop_count_min) {
      throw new Error(`[LootRuntime] table "${id}" drop_count_max < drop_count_min`);
    }
    map.set(id, Object.freeze(t));
  }
  cachedTables = {
    tables: map,
    ids: Object.freeze([...map.keys()].sort()),
  };
  return cachedTables;
}

/** Test-only cache reset. */
export function _resetLootTablesCache(): void {
  cachedTables = null;
}

// ───────── Seed composer ─────────
/**
 * Seed pattern lock (data/loot_tables.json `_seed_pattern`):
 *   rng_loot:<encounter_id>:<drop_index>[:<purpose>]
 *
 * Purpose suffix tách stream cho 4 roll independent:
 *   - no_drop / count / rarity / set_piece
 *
 * Adding new purpose KHÔNG shift existing roll sequence (string identity, not ordinal).
 */
function seedFor(ctx: LootContext, purpose: string, drop_index_override?: number): string {
  const di = drop_index_override ?? ctx.drop_index;
  return `${ctx.seed_root}:rng_loot:${ctx.encounter_id}:${di}:${purpose}`;
}

// ───────── Pure deterministic pickers ─────────

/**
 * Weighted rarity pick from BP weights — deterministic given rng.
 *
 * Sort keys lex để cross-platform stable iteration (JS Object.keys order
 * không guaranteed cross-engine cho all key types).
 */
function pickRarityWeighted(weights: Readonly<Record<string, number>>, rng: RNG): Rarity {
  const sortedKeys = [...RARITY_LIST].sort();
  let total = 0;
  for (const k of sortedKeys) total += weights[k] ?? 0;
  if (total <= 0) return 'common';
  const r = Math.floor(rng() * total);
  let cum = 0;
  for (const k of sortedKeys) {
    cum += weights[k] ?? 0;
    if (r < cum) return k as Rarity;
  }
  return sortedKeys[sortedKeys.length - 1] as Rarity;
}

/** Inclusive int range pick deterministic. */
function pickIntRange(min: number, max: number, rng: RNG): number {
  if (max <= min) return min;
  return min + Math.floor(rng() * (max - min + 1));
}

/** Slot pick deterministic by index (no RNG — same pattern as Phase 7 hooks). */
function pickSlotByIndex(slot_pool: readonly EquipmentSlot[], drop_index: number): EquipmentSlot {
  const sorted = [...slot_pool].sort();
  return sorted[drop_index % sorted.length] as EquipmentSlot;
}

// ───────── Set piece pool cache ─────────
/**
 * Lazy cache items grouped by set_id từ item_registry.
 * Reset khi `_resetLootTablesCache()` invoked (test scope).
 */
let cachedSetPool: Map<string, Item[]> | null = null;
function loadSetPool(): Map<string, Item[]> {
  if (cachedSetPool) return cachedSetPool;
  const reg = loadItemsRegistry();
  const map = new Map<string, Item[]>();
  for (const item of reg.values()) {
    if (!item.set_id) continue;
    let bucket = map.get(item.set_id);
    if (!bucket) {
      bucket = [];
      map.set(item.set_id, bucket);
    }
    bucket.push(item);
  }
  // Sort each bucket by id lex for deterministic pick.
  for (const bucket of map.values()) {
    bucket.sort((a, b) => codepointCompare(a.id, b.id));
  }
  cachedSetPool = map;
  return cachedSetPool;
}

/** Reset set pool cache (test). */
export function _resetSetPoolCache(): void {
  cachedSetPool = null;
}

// ───────── Result comparator for replay invariant ─────────
function affixSig(a: ItemAffix): string {
  return `${a.id}|${a.type}|${a.value_bp_or_raw}`;
}
function resultSig(r: LootRollResult): string {
  const af = [...r.affixes].sort((a, b) => codepointCompare(a.id, b.id)).map(affixSig).join(',');
  return `${r.rarity}|${r.slot}|${r.item_id ?? ''}|${r.set_id ?? ''}|${af}`;
}

// ───────── Internal roll: 1 drop given resolved context ─────────
interface InternalRollDeps {
  table: LootTable;
  affixRuntime: AffixRuntime;
}

function rollOneInternal(
  ctx: LootContext,
  drop_index: number,
  deps: InternalRollDeps,
): LootRollResult {
  const { table } = deps;

  // 1. rarity roll
  const rngRarity = createRNG(seedFor(ctx, 'rarity', drop_index));
  const rarity = pickRarityWeighted(table.rarity_weights, rngRarity);

  // 2. slot pick (deterministic, no rng)
  const slot = pickSlotByIndex(table.slot_pool, drop_index);

  // 3. set piece chance
  const rngSet = createRNG(seedFor(ctx, 'set_piece', drop_index));
  const setChance = table.set_piece_chance_bp;
  let set_id: string | null = null;
  let item_id: string | null = null;
  if (setChance > 0 && Math.floor(rngSet() * 10000) < setChance) {
    // Pick set deterministic from registry (any set with items in pool).
    const setMap = loadSetPool();
    const setIds = [...setMap.keys()].sort();
    if (setIds.length > 0) {
      const idxRng = createRNG(seedFor(ctx, 'set_choice', drop_index));
      const sid = setIds[Math.floor(idxRng() * setIds.length)] as string;
      set_id = sid;
      const pick = rollSetPieceInternal(ctx, drop_index, sid);
      item_id = pick.picked_item_id;
    }
  }

  // 4. affixes via itemization rng_affix (separate stream — no cross-pollution).
  const affixSeed = seedFor(ctx, 'affix_handoff', drop_index);
  const affixes = deps.affixRuntime.generate(slot, rarity, affixSeed);

  return {
    rarity,
    slot,
    item_id,
    affixes: affixes.map(a => ({ id: a.id, type: a.type, value_bp_or_raw: a.value_bp_or_raw })),
    set_id,
    seed_used: seedFor(ctx, 'rarity', drop_index),
  };
}

function rollSetPieceInternal(
  ctx: LootContext,
  drop_index: number,
  set_id: string,
): { picked_item_id: string | null; seed_used: string } {
  const seed = seedFor(ctx, `setpiece:${set_id}`, drop_index);
  const setMap = loadSetPool();
  const bucket = setMap.get(set_id);
  if (!bucket || bucket.length === 0) return { picked_item_id: null, seed_used: seed };
  const rng = createRNG(seed);
  const picked = bucket[Math.floor(rng() * bucket.length)];
  return { picked_item_id: picked?.id ?? null, seed_used: seed };
}

// ───────── Factory ─────────

export interface LootRuntimeOptions {
  /** Inject custom affix runtime (test). Default = createAffixRuntime(). */
  affixRuntime?: AffixRuntime;
}

export function createLootGenerationRuntime(
  opts: LootRuntimeOptions = {},
): LootGenerationRuntime {
  const cache = loadLootTables();
  const affixRuntime = opts.affixRuntime ?? createAffixRuntime();

  function getTableOrThrow(table_id: string): LootTable {
    const t = cache.tables.get(table_id);
    if (!t) throw new Error(`[LootRuntime] table not found: ${table_id}`);
    return t;
  }

  function rollDropBatch(ctx: LootContext, table_id: string): LootRollResult[] {
    LootContextSchema.parse(ctx);
    const table = getTableOrThrow(table_id);

    // No-drop bypass
    if (table.no_drop_chance_bp > 0) {
      const rngNo = createRNG(seedFor(ctx, 'no_drop'));
      if (Math.floor(rngNo() * 10000) < table.no_drop_chance_bp) return [];
    }

    // Drop count
    const rngCount = createRNG(seedFor(ctx, 'count'));
    const count = pickIntRange(table.drop_count_min, table.drop_count_max, rngCount);
    if (count <= 0) return [];

    const out: LootRollResult[] = [];
    for (let i = 0; i < count; i++) {
      out.push(rollOneInternal(ctx, ctx.drop_index + i, { table, affixRuntime }));
    }
    return out;
  }

  return {
    rollDrop: rollDropBatch,

    rollBossDrop(ctx, table_id) {
      const id = table_id ?? 'boss_default';
      return rollDropBatch(ctx, id);
    },

    rollDungeonReward(ctx, dungeon_kind) {
      const id = dungeon_kind === 'elite' ? 'dungeon_elite' : 'dungeon_normal';
      return rollDropBatch(ctx, id);
    },

    rollCompanionDrop(ctx, companion_id) {
      const table = getTableOrThrow('companion_quest_reward');
      const subCtx: LootContext = {
        ...ctx,
        encounter_id: `${ctx.encounter_id}:companion_${companion_id}`,
      };
      const result = rollOneInternal(subCtx, ctx.drop_index, { table, affixRuntime });
      return result;
    },

    rollSetPiece(ctx, set_id) {
      LootContextSchema.parse(ctx);
      return rollSetPieceInternal(ctx, ctx.drop_index, set_id);
    },

    verifyReplayInvariant(ctx, table_id, runs) {
      if (runs <= 0) {
        return { divergences: 0, total_runs: 0 };
      }
      const baseline = rollDropBatch(ctx, table_id);
      const baselineSig = baseline.map(resultSig).join('||');
      let divergences = 0;
      let first_divergence: LootReplayAuditResult['first_divergence'];
      for (let i = 1; i < runs; i++) {
        const replay = rollDropBatch(ctx, table_id);
        const replaySig = replay.map(resultSig).join('||');
        if (replaySig !== baselineSig) {
          divergences++;
          if (!first_divergence) {
            for (let k = 0; k < Math.max(baseline.length, replay.length); k++) {
              if (resultSig(baseline[k] ?? defaultDivergenceResult())
                  !== resultSig(replay[k] ?? defaultDivergenceResult())) {
                first_divergence = {
                  drop_index: k,
                  original: baseline[k] ?? defaultDivergenceResult(),
                  replay: replay[k] ?? defaultDivergenceResult(),
                };
                break;
              }
            }
          }
        }
      }
      const result: LootReplayAuditResult = { divergences, total_runs: runs };
      if (first_divergence) result.first_divergence = first_divergence;
      return result;
    },

    getTable(table_id) {
      return getTableOrThrow(table_id);
    },

    listTableIds() {
      return cache.ids;
    },
  };
}

function defaultDivergenceResult(): LootRollResult {
  return {
    rarity: 'common',
    slot: EquipmentSlotSchema.enum.mu,
    item_id: null,
    affixes: [],
    set_id: null,
    seed_used: '',
  };
}

// Re-export RaritySchema for downstream tests (convenience).
export { RaritySchema };
