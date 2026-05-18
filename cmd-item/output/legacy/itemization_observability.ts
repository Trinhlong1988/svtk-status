/**
 * ITEMIZATION OBSERVABILITY HOOK — Contract #6 (CMD2.docx FIX #9 + #10).
 *
 * Telemetry + performance budget hooks cho itemization runtime.
 *
 * Track:
 *  - modifier count per aggregation
 *  - recursion depth reached (from ModifierRecursionGuard)
 *  - aggregation time (target < 10µs per CMD2.docx FIX #10)
 *  - overflow rejection count
 *  - softcap hits per stat
 *  - invalid item payload (Zod fail)
 *  - impossible stat generation (StatBudgetRuntime fail)
 *
 * Integrate với existing telemetry philosophy:
 *  - Server-side log (KHÔNG client tampering)
 *  - Stream rolling flush (KHÔNG buffer RAM toàn bộ)
 *  - Hot disk 24h → Warm Postgres 7-30d → Cold S3 gzip 90d+
 *
 * Layer: Layer 2 LOGIC + Layer 4 NETWORK observability boundary.
 *
 * R PHASE4 — KHÔNG block hot path. Telemetry là SIDE EFFECT only.
 *
 * ⚠ NO IMPLEMENTATION — chỉ contract.
 */
import { z } from 'zod';

// ───────── Event Types ─────────
export const ItemizationEventTypeSchema = z.enum([
  'aggregation_start',
  'aggregation_done',
  'recursion_aborted',
  'softcap_hit',
  'overflow_rejected',
  'invalid_payload',
  'budget_violation',
  'companion_isolation_block',
  'impossible_stat_generation',
]);
export type ItemizationEventType = z.infer<typeof ItemizationEventTypeSchema>;

// ───────── Severity Tier (CMD2.docx FINAL FIX #10) ─────────
/**
 * 4 severity tier:
 *  - info: thông tin bình thường (aggregation_done)
 *  - warning: tình trạng đáng chú ý (softcap_hit nhiều lần)
 *  - anomaly: bất thường cần investigate (recursion_aborted, perf > budget)
 *  - critical: critical incident — PERSIST snapshot tự động cho replay debug
 */
export const TelemetrySeveritySchema = z.enum(['info', 'warning', 'anomaly', 'critical']);
export type TelemetrySeverity = z.infer<typeof TelemetrySeveritySchema>;

// ───────── Event Payload (pure data, JSON-serializable) ─────────
export const ItemizationEventSchema = z.object({
  /** Event type. */
  type: ItemizationEventTypeSchema,
  /** Severity tier — drives persistence behavior. */
  severity: TelemetrySeveritySchema,
  /** Server tick / timestamp. */
  tick: z.number().int().nonnegative(),
  /** Char id involved (optional). */
  char_id: z.string().optional(),
  /** Aggregation duration in microseconds (cho aggregation_done). */
  duration_us: z.number().int().nonnegative().optional(),
  /** Modifier count processed (cho aggregation_done). */
  modifier_count: z.number().int().nonnegative().optional(),
  /** Recursion depth reached (cho recursion_aborted). */
  recursion_depth: z.number().int().nonnegative().optional(),
  /** Stat key affected (cho softcap_hit / overflow / budget). */
  stat_key: z.string().optional(),
  /** Detail message human-readable. */
  detail: z.string().optional(),
  /** Optional snapshot ref (cho critical event persist). */
  snapshot_ref: z.string().optional(),
});
export type ItemizationEvent = z.infer<typeof ItemizationEventSchema>;

/**
 * Default severity per event type — CMD2.docx FINAL FIX #10.
 * Override-able qua emit() caller.
 */
export const DEFAULT_SEVERITY_BY_TYPE: Readonly<Record<ItemizationEventType, TelemetrySeverity>> = Object.freeze({
  aggregation_start: 'info',
  aggregation_done: 'info',
  recursion_aborted: 'anomaly',
  softcap_hit: 'warning',
  overflow_rejected: 'critical',
  invalid_payload: 'critical',
  budget_violation: 'anomaly',
  companion_isolation_block: 'critical',
  impossible_stat_generation: 'critical',
});

// ───────── Performance Budget Targets (CMD2.docx FIX #10) ─────────
/**
 * Hard targets cho aggregation perf — fail fast nếu vượt.
 *
 * Source: CONST trong data/itemization_constants.json (TBD).
 */
export const PERF_BUDGET_AGGREGATION_US = 10 as const;        // < 10µs per equipment aggregation
export const PERF_BUDGET_MAX_MODIFIER_COUNT = 64 as const;    // sanity cap (9 slot × 5 affix + passives + companion)
export const PERF_BUDGET_MAX_TELEMETRY_PER_TICK = 100 as const; // throttle telemetry burst

// ───────── ItemizationObservabilityHook Contract ─────────
/**
 * CONTRACT — Implementation `itemization_observability_impl.ts` PHẢI satisfy.
 *
 * Determinism:
 *  - Telemetry emit KHÔNG affect aggregation logic
 *  - Sampling deterministic (KHÔNG random sample — hash-based or all-or-none)
 *  - Buffer flush KHÔNG block hot path (async stream theo R Mục 8A)
 */
export interface ItemizationObservabilityHook {
  /**
   * Emit 1 event vào telemetry stream.
   *
   * NON-BLOCKING — push to ring buffer, flush async.
   * KHÔNG throw nếu buffer full — drop event + increment dropped_count.
   */
  emit(event: ItemizationEvent): void;

  /**
   * Start performance timer (returns marker for later stop).
   * Pure function — không global state.
   *
   * @returns timer marker (caller pass into stopAggregationTimer)
   */
  startAggregationTimer(): number;

  /**
   * Stop timer + emit aggregation_done event với duration_us.
   *
   * @param marker         from startAggregationTimer
   * @param char_id        cho event payload
   * @param modifier_count
   */
  stopAggregationTimer(marker: number, char_id: string, modifier_count: number): void;

  /**
   * Get current performance budget config.
   * Implementation override-able cho test.
   */
  readonly perfBudget: {
    readonly max_aggregation_us: number;
    readonly max_modifier_count: number;
    readonly max_telemetry_per_tick: number;
  };

  /**
   * Drop counter — số event dropped do buffer full.
   * Cho test + monitor.
   */
  readonly droppedCount: number;

  /**
   * Reset counters (test-only).
   */
  _resetForTest(): void;
}

// ───────── Schema re-exports ─────────
export {
  ItemizationEventSchema as _ItemizationEventSchema,
};
