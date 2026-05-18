/**
 * ECONOMY FOUNDATION RUNTIME — Contract (Phase 11 Mục VII + VIII).
 *
 * Track gold/item source/sink + inflation guard.
 *
 * Layer: Layer 2 LOGIC observability + Layer 1 DATA loader.
 *
 * GOAL:
 *  - Prevent inflation collapse
 *  - Track all item generation paths (audit)
 *  - Stable economy over time
 *  - Telemetry for live ops adjustment
 *
 * Anti-pattern blocks:
 *  - NO direct currency mutation (read-only tracker)
 *  - NO economy ownership (caller systems own gold/inventory state)
 *  - NO market/auction logic (out of scope)
 *
 * ⚠ NO IMPLEMENTATION — chỉ contract interface.
 */
import { z } from 'zod';
import { RaritySchema } from '../../../../cmd-item/output/legacy/itemization_types.js';

// ───────── Source/Sink Kind ENUMs ─────────
export const GoldSourceKindSchema = z.enum([
  'quest', 'monster_drop', 'boss_drop', 'raid_drop', 'dungeon_clear',
  'event_reward', 'vendor_sell', 'daily_login', 'salvage_refund',
]);
export type GoldSourceKind = z.infer<typeof GoldSourceKindSchema>;

export const GoldSinkKindSchema = z.enum([
  'vendor_buy', 'repair', 'upgrade', 'crafting', 'gem_socket',
  'transmute', 'guild_tax', 'mailbox_fee', 'auction_fee',
]);
export type GoldSinkKind = z.infer<typeof GoldSinkKindSchema>;

export const ItemSourceKindSchema = z.enum([
  'drop_mob', 'drop_boss', 'drop_raid', 'drop_dungeon',
  'quest_reward', 'event_reward', 'craft_output', 'salvage_byproduct',
  'shop_purchase', 'lottery_reward', 'achievement_reward',
]);
export type ItemSourceKind = z.infer<typeof ItemSourceKindSchema>;

export const ItemSinkKindSchema = z.enum([
  'salvage_input', 'vendor_sell', 'transmute_input', 'upgrade_consume',
  'set_dismantle', 'gem_socket', 'crafting_input', 'dropped_on_death',
]);
export type ItemSinkKind = z.infer<typeof ItemSinkKindSchema>;

// ───────── Flow Records ─────────
export const GoldFlowSchema = z.object({
  player_id: z.string(),
  amount: z.number().int(),
  reason: z.union([GoldSourceKindSchema, GoldSinkKindSchema]),
  direction: z.enum(['source', 'sink']),
  tick: z.number().int().nonnegative(),
});
export type GoldFlow = z.infer<typeof GoldFlowSchema>;

export const ItemFlowSchema = z.object({
  player_id: z.string(),
  item_id: z.string(),
  rarity: RaritySchema,
  reason: z.union([ItemSourceKindSchema, ItemSinkKindSchema]),
  direction: z.enum(['source', 'sink']),
  tick: z.number().int().nonnegative(),
});
export type ItemFlow = z.infer<typeof ItemFlowSchema>;

// ───────── Snapshot ─────────
export interface EconomySnapshot {
  tick_start: number;
  tick_end: number;
  total_gold_in: number;
  total_gold_out: number;
  total_item_in: number;
  total_item_out: number;
  rarity_in: Record<string, number>;
  rarity_out: Record<string, number>;
  gold_source_breakdown: Record<string, number>;
  gold_sink_breakdown: Record<string, number>;
}

// ───────── Inflation Risk Report ─────────
export interface InflationRiskReport {
  /**
   * Growth ratio in basis points (BP) — R30 naming compliance.
   * 10000 BP = 1.0 = on target. 0 BP = no flow / deflation. > 10000 BP = inflation.
   *
   * BREAKING CHANGE — Batch 5.4 A3: renamed from `growth_ratio` (vi phạm R30
   * không có suffix `_bp`). Bumped ECONOMY_SERIALIZATION_VERSION 1 → 2.
   */
  growth_ratio_bp: number;
  /** Severity classification: ok / warning / anomaly / critical. */
  severity: 'ok' | 'warning' | 'anomaly' | 'critical';
  /** Sink/source ratio in BP. >= gold_sink_min_ratio_bp = healthy. */
  sink_source_ratio_bp: number;
  /** Top inflated rarity (vd "mythic" if mythic supply > cap). */
  inflated_rarity: string | null;
  /**
   * Status tag — distinguishes "ok with flow" vs "no_flow" (Batch 5.4 A4).
   * Caller dashboard nên render "no_flow" khác "on_target".
   */
  status: 'on_target' | 'no_flow' | 'deviation_warning' | 'deviation_anomaly' | 'sink_deficit_critical';
  /** Detail message for telemetry. */
  detail: string;
}

// ───────── EconomyFoundationRuntime Contract ─────────
/**
 * CONTRACT — Implementation `economy_foundation_runtime_impl.ts` PHẢI satisfy.
 *
 * Pure tracker — KHÔNG mutate any external state.
 * Caller systems (quest/loot/shop) push event vào tracker.
 * Tracker compute snapshot + inflation risk on demand.
 */
export interface EconomyFoundationRuntime {
  /** Record gold source flow. */
  recordGoldSource(player_id: string, amount: number, reason: GoldSourceKind, tick: number): void;

  /** Record gold sink flow. */
  recordGoldSink(player_id: string, amount: number, reason: GoldSinkKind, tick: number): void;

  /** Record item source flow. */
  recordItemSource(player_id: string, item_id: string, rarity: string, reason: ItemSourceKind, tick: number): void;

  /** Record item sink flow. */
  recordItemSink(player_id: string, item_id: string, rarity: string, reason: ItemSinkKind, tick: number): void;

  /** Build snapshot for tick range. */
  getSnapshot(tick_start: number, tick_end: number): EconomySnapshot;

  /** Compute inflation risk over tick range. */
  computeInflationRisk(tick_start: number, tick_end: number): InflationRiskReport;

  /** Validate per-tick gold source cap (anti farm bot). Return true if within cap. */
  validateGoldSourceCap(player_id: string, kind: GoldSourceKind, amount: number, tick: number): boolean;

  /** Validate per-day rarity inflation cap. */
  validateRarityInflationCap(player_id: string, rarity: string, tick: number): boolean;

  /** Reset (test-only). */
  _resetForTest(): void;

  /** Total flow records (for telemetry). */
  readonly recordCount: number;
}

// ───────── ★ NO IMPLEMENTATION ─────────
// Implementation file: economy_foundation_runtime_impl.ts (Batch 5.2).
