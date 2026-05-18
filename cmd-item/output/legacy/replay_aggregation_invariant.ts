/**
 * REPLAY AGGREGATION INVARIANT — Contract #7 (CMD2.docx FIX #5).
 *
 * Test helper interface — verify equipment aggregation BIT-IDENTICAL trên 1000 simulations.
 *
 * Layer: Test layer (tests/itemization/) — interface ở đây cho property test consume.
 *
 * Verifies:
 *  - identical modifier order
 *  - identical stat output
 *  - identical clamp ordering
 *  - identical affix resolution
 *  - identical companion aggregation
 *
 * Run: 1000 repeated deterministic simulations.
 * Expected: ZERO divergence.
 *
 * R deterministic + R31 INT + R replay-safe + CMD2.docx FIX #5.
 *
 * ⚠ NO IMPLEMENTATION — chỉ contract.
 */
import { z } from 'zod';
import {
  type AggregatedStatBlock,
  type StatModifier,
  type ItemStatBlock,
} from './itemization_types.js';
import {
  type EquippedItemMap,
  type CharId,
} from './equipment_stat_provider.js';

// ───────── Invariant Test Config ─────────
/**
 * Source: CONST_REPLAY_INVARIANT_RUNS trong test config.
 */
export const CONST_REPLAY_INVARIANT_RUNS = 1000 as const;

// ───────── Divergence Report ─────────
/**
 * Nếu fail invariant → report chi tiết divergence.
 */
export const DivergenceReportSchema = z.object({
  /** Run index có divergence (1-1000). */
  run_index: z.number().int().nonnegative(),
  /** Run reference (run 0 baseline). */
  reference_index: z.literal(0),
  /** Field divergent (vd "stats.crit_rate_bp", "active_sets[0]"). */
  divergent_field: z.string(),
  /** Reference value (string serialized). */
  reference_value: z.string(),
  /** Divergent value (string serialized). */
  divergent_value: z.string(),
  /** Modifier order at divergent run (debug). */
  modifier_order_hash: z.string().optional(),
});
export type DivergenceReport = z.infer<typeof DivergenceReportSchema>;

// ───────── Invariant Test Result ─────────
export const InvariantResultSchema = z.object({
  /** Pass nếu zero divergence. */
  passed: z.boolean(),
  /** Total runs executed. */
  runs: z.number().int().positive(),
  /** Divergences found (rỗng nếu pass). */
  divergences: z.array(DivergenceReportSchema),
  /** Avg aggregation duration µs. */
  avg_duration_us: z.number().int().nonnegative(),
  /** Max aggregation duration µs (perf budget check). */
  max_duration_us: z.number().int().nonnegative(),
});
export type InvariantResult = z.infer<typeof InvariantResultSchema>;

// ───────── ReplayAggregationInvariant Contract ─────────
/**
 * CONTRACT — Test helper `replay_aggregation_invariant_impl.ts` (trong tests/) PHẢI satisfy.
 *
 * Pure test helper — KHÔNG production code. Property-based test integration.
 */
export interface ReplayAggregationInvariant {
  /**
   * Run N simulations với cùng input → verify identical output.
   *
   * @param char_id          CharId
   * @param equipped         EquippedItemMap (input fixed)
   * @param char_base_stats  Stat base (input fixed)
   * @param runs             Số run (default CONST_REPLAY_INVARIANT_RUNS = 1000)
   * @returns                InvariantResult — passed nếu zero divergence
   */
  runInvariantTest(
    char_id: CharId,
    equipped: EquippedItemMap,
    char_base_stats: ItemStatBlock,
    runs?: number,
  ): InvariantResult;

  /**
   * Compare 2 AggregatedStatBlock bit-by-bit.
   *
   * @returns null nếu identical, DivergenceReport nếu khác
   */
  compareAggregated(
    reference: AggregatedStatBlock,
    candidate: AggregatedStatBlock,
    candidate_run_index: number,
  ): DivergenceReport | null;

  /**
   * Hash modifier order — deterministic fingerprint cho debug.
   *
   * Hash inputs: sorted modifier source_item_id + order_priority + amount_bp_or_raw
   * Algorithm: stable string hash (vd FNV-1a, SHA-256 first 8 bytes).
   */
  hashModifierOrder(modifiers: readonly StatModifier[]): string;

  /**
   * Run shuffled invariant — modifier list shuffled mỗi run, output PHẢI identical.
   *
   * Verify pipeline ordering (CMD2.docx FIX #2) hoạt động đúng tie-break.
   */
  runShuffledInvariant(
    char_id: CharId,
    equipped: EquippedItemMap,
    char_base_stats: ItemStatBlock,
    runs?: number,
  ): InvariantResult;
}

// ───────── Schema re-exports ─────────
export {
  DivergenceReportSchema as _DivergenceReportSchema,
  InvariantResultSchema as _InvariantResultSchema,
};
