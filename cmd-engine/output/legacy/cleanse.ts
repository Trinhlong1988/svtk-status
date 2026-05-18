/**
 * CLEANSE — generic framework (Phase 2 spec).
 *
 * Filter active StatusEffect[] on target by category / type / count. Returns
 * removed effects (caller fires onRemove handler + emit cleanse_triggered event).
 *
 * Pure function — no state mutation here. Caller mutate target's debuffs/buffs.
 *
 * Phase 2 FH wire:
 *   - FIX #8: optional telemetry sink for `cleanse_during_trigger` anomalies
 *     (caller signals via `cleanseContext.duringTrigger`).
 */
import type { StatusEffect, CleanseFilter, StatusCategory } from './status_types.js';
import type { EffectType } from './types.js';
import type { StatusTelemetryState } from './status_telemetry.js';
import { emitTimingConflict } from './status_telemetry.js';

/** Per-target immunity tags (from boss design, item passive, etc.). */
export interface CleanseImmunity {
  /** Categories cleanse cannot touch (vd boss has 'HARD_CC' immunity from cleanse). */
  immuneCategories?: StatusCategory[];
  /** Specific effect types cleanse cannot touch. */
  immuneTypes?: EffectType[];
}

/**
 * Optional cleanse runtime context — used for telemetry hooks (FIX #8).
 *
 * Caller passes `duringTrigger=true` when invoking cleanse from the TRIGGER phase
 * (vd tick-driven cleanse). Phase 2 FH timeline LOCK ORDER puts CLEANSE BEFORE
 * TRIGGER for a reason — invoking cleanse from a trigger handler is a timing
 * conflict that telemetry should surface.
 */
export interface CleanseRuntimeContext {
  telemetry?: StatusTelemetryState;
  currentTurn: number;
  /** True if caller invoked cleanse from inside a TRIGGER-phase handler. */
  duringTrigger?: boolean;
  /** Target id (for telemetry payload). */
  targetId?: string;
}

/**
 * Filter active effects by cleanse spec. Returns effects to be removed.
 *
 * Determinism: stable iteration order — array index ascending.
 *
 * @param active — current effects on target
 * @param filter — cleanse criteria
 * @param immunity — target immunity (optional)
 * @param runtime — Phase 2 FH telemetry hook (optional, FIX #8)
 * @returns effects to remove (caller responsible for actual mutation + event emit)
 */
export function selectCleansable(
  active: readonly StatusEffect[],
  filter: CleanseFilter,
  immunity: CleanseImmunity = {},
  runtime?: CleanseRuntimeContext,
): StatusEffect[] {
  // FIX #8 — emit `cleanse_during_trigger` anomaly if caller invoked us mid-trigger.
  if (runtime?.duringTrigger && runtime.telemetry) {
    emitTimingConflict(
      runtime.telemetry, runtime.currentTurn,
      'cleanse_during_trigger',
      runtime.targetId ?? 'unknown',
      'cleanse',
    );
  }
  const maxCount = filter.maxCount ?? 0;     // 0 = no limit
  const bypassImmunity = filter.bypassImmunity ?? false;

  // Step 1 — collect candidate (preserving original array index for stable tiebreak)
  const candidates: { eff: StatusEffect; idx: number }[] = [];
  for (let i = 0; i < active.length; i++) {
    const eff = active[i];
    if (!eff) continue;
    if (filter.categories && filter.categories.length > 0) {
      if (!filter.categories.includes(eff.category)) continue;
    }
    if (filter.types && filter.types.length > 0) {
      if (!filter.types.includes(eff.type)) continue;
    }
    if (!bypassImmunity) {
      if (immunity.immuneCategories?.includes(eff.category)) continue;
      if (immunity.immuneTypes?.includes(eff.type)) continue;
    }
    candidates.push({ eff, idx: i });
  }

  // Step 2 — FIX #4: optional priority sort. Default behavior (no priorityOrder) =
  // identity sort = original array index order = backward compatible deterministic.
  if (filter.priorityOrder && filter.priorityOrder.length > 0) {
    const priority = filter.priorityOrder;
    const rankOf = (cat: StatusEffect['category']): number => {
      const r = priority.indexOf(cat);
      return r === -1 ? Number.MAX_SAFE_INTEGER : r;
    };
    candidates.sort((a, b) => {
      const ra = rankOf(a.eff.category);
      const rb = rankOf(b.eff.category);
      if (ra !== rb) return ra - rb;
      return a.idx - b.idx;     // stable tiebreak by original index
    });
  }

  // Step 3 — apply maxCount
  const removed: StatusEffect[] = [];
  for (const c of candidates) {
    if (maxCount > 0 && removed.length >= maxCount) break;
    removed.push(c.eff);
  }
  return removed;
}
