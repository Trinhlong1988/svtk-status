/**
 * LOOT GENERATION RUNTIME — Contract (Phase 11 Mục V).
 *
 * REPLACE Phase 7 stub `loot_generation_hooks.ts` bằng FULL runtime contract.
 *
 * Layer: Layer 2 LOGIC + Layer 1 DATA loader.
 *
 * Determinism guarantee:
 *  - Cùng (seed_root, table_id, drop_index) → cùng output
 *  - Isolated `rng_loot` stream (R Mục VI RNG ownership lock)
 *  - Replay-safe: same encounter replay = same loot result
 *
 * Anti loot-chaos:
 *  - Rarity weights data-driven (no hardcode if rarity===)
 *  - Drop count bounded per table
 *  - Set piece chance explicit
 *  - No infinite proc loops
 *
 * ⚠ NO IMPLEMENTATION — chỉ contract interface.
 */
import { z } from 'zod';
import {
  EquipmentSlotSchema,
  RaritySchema,
} from '../../../../cmd-item/output/legacy/itemization_types.js';

// ───────── Loot Context ─────────
export const LootContextSchema = z.object({
  /** Encounter id (boss/mob/dungeon/event). */
  encounter_id: z.string().min(1),
  /** Drop index in this encounter (0-based, monotonic). */
  drop_index: z.number().int().nonnegative(),
  /** Player id receiving loot. */
  player_id: z.string().min(1),
  /** Server tick. */
  tick: z.number().int().nonnegative(),
  /** Seed root cho rng_loot derivation (vd "boss_lac_long_quan_p_01_run_42"). */
  seed_root: z.string().min(1),
});
export type LootContext = z.infer<typeof LootContextSchema>;

// ───────── Loot Roll Result ─────────
export const LootRollResultSchema = z.object({
  rarity: RaritySchema,
  slot: EquipmentSlotSchema,
  /** Item id nếu pick exact item từ pool, null nếu chỉ rarity+slot (caller resolve). */
  item_id: z.string().nullable(),
  /** Affix list (sorted by id lex deterministic). */
  affixes: z.array(z.object({
    id: z.string(),
    type: z.string(),
    value_bp_or_raw: z.number().int(),
  })),
  /** Set id nếu là set piece, null nếu standalone. */
  set_id: z.string().nullable(),
  /** Seed used (for replay diagnostic). */
  seed_used: z.string(),
});
export type LootRollResult = z.infer<typeof LootRollResultSchema>;

// ───────── Loot Table Definition ─────────
export const LootTableSchema = z.object({
  rarity_weights: z.record(RaritySchema, z.number().int().nonnegative()),
  slot_pool: z.array(EquipmentSlotSchema),
  drop_count_min: z.number().int().nonnegative(),
  drop_count_max: z.number().int().nonnegative(),
  no_drop_chance_bp: z.number().int().min(0).max(10000).default(0),
  set_piece_chance_bp: z.number().int().min(0).max(10000).default(0),
  companion_only: z.boolean().optional(),
});
export type LootTable = z.infer<typeof LootTableSchema>;

// ───────── Replay Audit Result ─────────
export interface LootReplayAuditResult {
  /** Number of mismatches between original + replay roll. */
  divergences: number;
  /** Total runs compared. */
  total_runs: number;
  /** Detail của divergence đầu tiên (debug). */
  first_divergence?: {
    drop_index: number;
    original: LootRollResult;
    replay: LootRollResult;
  };
}

// ───────── LootGenerationRuntime Contract ─────────
/**
 * CONTRACT — Implementation `loot_generation_runtime_impl.ts` (Batch 5.2) PHẢI satisfy.
 *
 * RNG ownership: chỉ dùng `rng_loot` stream (forbidden cho combat/quest/npc per Mục VI).
 * Affix roll DELEGATE sang itemization affix runtime (separate `rng_affix` stream).
 */
export interface LootGenerationRuntime {
  /**
   * Roll drop từ table_id pre-defined trong `data/loot_tables.json`.
   * Handle no_drop_chance, drop_count, rarity weighting, set piece logic.
   *
   * @returns 0..N LootRollResult (count theo table.drop_count_*)
   */
  rollDrop(context: LootContext, table_id: string): LootRollResult[];

  /**
   * Roll boss drop (alias rollDrop với table_id="boss_default" / "boss_raid").
   * Caller pass `boss_id` qua context.encounter_id.
   */
  rollBossDrop(context: LootContext, table_id?: string): LootRollResult[];

  /**
   * Roll dungeon clear reward.
   */
  rollDungeonReward(context: LootContext, dungeon_kind: 'normal' | 'elite'): LootRollResult[];

  /**
   * Roll companion-specific drop. Force companion_only table.
   */
  rollCompanionDrop(context: LootContext, companion_id: string): LootRollResult;

  /**
   * Roll set piece — pick item id từ candidate pool deterministic.
   */
  rollSetPiece(context: LootContext, set_id: string): { picked_item_id: string | null; seed_used: string };

  /**
   * Verify replay invariant: same context, run N times → expect ZERO divergence.
   * Phase 11 Mục VI lock: same replay = same loot ALWAYS.
   */
  verifyReplayInvariant(
    context: LootContext,
    table_id: string,
    runs: number,
  ): LootReplayAuditResult;

  /**
   * Get table definition (for inspect / telemetry).
   */
  getTable(table_id: string): LootTable;

  /**
   * List all loaded table ids (for audit).
   */
  listTableIds(): readonly string[];
}

// ───────── ★ NO IMPLEMENTATION ─────────
// Implementation file: loot_generation_runtime_impl.ts (Batch 5.2 sau Mr.Long ack contract).
//
// Cross-module dependency:
//  - itemization affix runtime (rollAffixForDrop) cho affix gen
//  - itemization item registry (getItem) cho set piece pick
//  - itemization rarity runtime cho weight validation
//  - economy_foundation_runtime (record item source qua hook)
