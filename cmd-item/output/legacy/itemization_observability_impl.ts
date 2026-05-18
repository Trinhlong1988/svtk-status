/**
 * ITEMIZATION OBSERVABILITY HOOK — Implementation (CMD2.docx FIX #9 + #10).
 *
 * Ring buffer + non-blocking emit. Test-friendly stub (production wires telemetry stream).
 *
 * @see itemization_observability.ts (contract)
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type {
  ItemizationEvent,
  ItemizationObservabilityHook,
} from './itemization_observability.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, '../../../data');

const PerfBudgetConfigSchema = z.object({
  perf_budget: z.object({
    max_aggregation_us: z.number().int().positive(),
    max_modifier_count: z.number().int().positive(),
    max_telemetry_per_tick: z.number().int().positive(),
  }),
}).passthrough();

let cachedBudget: { max_aggregation_us: number; max_modifier_count: number; max_telemetry_per_tick: number } | null = null;

function loadBudget(): { max_aggregation_us: number; max_modifier_count: number; max_telemetry_per_tick: number } {
  if (cachedBudget) return cachedBudget;
  const raw = JSON.parse(readFileSync(join(DATA_ROOT, 'itemization_constants.json'), 'utf8'));
  const parsed = PerfBudgetConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`[Observability] perf_budget config FAIL:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
  cachedBudget = parsed.data.perf_budget;
  return cachedBudget;
}

/**
 * Factory: tạo instance ItemizationObservabilityHook.
 *
 * @param sink Optional callback consume event (vd push to telemetry stream).
 *             Production: wire vào src/logic stream architecture.
 *             Test: collect events vào array.
 */
export function createObservabilityHook(
  sink?: (event: ItemizationEvent) => void,
): ItemizationObservabilityHook {
  const budget = loadBudget();
  let dropped_count = 0;
  let emit_this_tick = 0;
  let last_tick = -1;

  return {
    perfBudget: Object.freeze({
      max_aggregation_us: budget.max_aggregation_us,
      max_modifier_count: budget.max_modifier_count,
      max_telemetry_per_tick: budget.max_telemetry_per_tick,
    }),

    get droppedCount() {
      return dropped_count;
    },

    emit(event: ItemizationEvent) {
      // Throttle per tick
      if (event.tick !== last_tick) {
        last_tick = event.tick;
        emit_this_tick = 0;
      }
      if (emit_this_tick >= budget.max_telemetry_per_tick) {
        dropped_count++;
        return;
      }
      emit_this_tick++;
      if (sink) sink(event);
    },

    startAggregationTimer(): number {
      // performance.now() may yield float; INT µs only (R31). Use bigint hrtime then floor.
      const ns = process.hrtime.bigint();
      return Number(ns / 1000n); // microseconds INT
    },

    stopAggregationTimer(marker: number, char_id: string, modifier_count: number) {
      const now_us = Number(process.hrtime.bigint() / 1000n);
      const duration_us = Math.max(0, now_us - marker);
      // Severity escalate nếu over budget
      const severity = duration_us > budget.max_aggregation_us ? 'anomaly' : 'info';
      this.emit({
        type: 'aggregation_done',
        severity,
        tick: last_tick >= 0 ? last_tick : 0,
        char_id,
        duration_us,
        modifier_count,
      });
    },

    _resetForTest() {
      dropped_count = 0;
      emit_this_tick = 0;
      last_tick = -1;
    },
  };
}

/** Test-only cache reset. */
export function _resetObservabilityCache(): void {
  cachedBudget = null;
}
