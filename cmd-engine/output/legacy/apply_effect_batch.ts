/**
 * APPLY EFFECT BATCH — timeline-resolved wrapper (Phase 2 FH wiring).
 *
 * Bundles same-tick status events into the LOCK ORDER timeline (FIX #1) and
 * executes them in canonical order:
 *
 *   1. EXPIRE      → durations expired this turn (via `tickEffectsOnTarget`)
 *   2. CLEANSE     → fire cleanse actions
 *   3. REFRESH     → existing-effect refresh applies
 *   4. TRIGGER     → tick + on-trigger proc (handled by tick loop)
 *   5. APPLY_NEW   → brand-new applies
 *
 * Caller (encounter manager) bundles all status-related events for the current
 * turn, invokes `applyTimelineBatch()`, and obtains a `BatchReport`.
 *
 * STRICT ADDITIVE: existing `applyEffect()` callers continue to work unchanged.
 * This wrapper only orchestrates ORDER — actual mutation goes through
 * `applyEffect / selectCleansable / tickEffectsOnTarget`.
 */
import type { CombatChar } from './types.js';
import type { StatusEffect, ApplyResult, CleanseFilter } from './status_types.js';
import { applyEffect, type StatusApplyContext } from './apply_effect.js';
import { tickEffectsOnTarget, type TickContext } from './tick_effect.js';
import { selectCleansable, type CleanseImmunity, type CleanseRuntimeContext } from './cleanse.js';
import {
  resolveStatusTimeline,
  makeTimelineEvent,
  type TimelineEvent,
  type TimelinePhase,
} from './status_timeline_resolver.js';
import { makeStatusOrderKey, nextStatusEmitSeq } from './status_ordering.js';
import { tickAuraGuard } from './aura_propagation_guard.js';
import type { StatusTelemetryState } from './status_telemetry.js';

// ─────────────────────────────────────────────────────────
// Batch input shapes
// ─────────────────────────────────────────────────────────

export interface BatchApplyItem {
  kind: 'apply';
  incoming: StatusEffect;
  target: CombatChar;
}

export interface BatchCleanseItem {
  kind: 'cleanse';
  target: CombatChar;
  filter: CleanseFilter;
  immunity?: CleanseImmunity;
}

export interface BatchTickItem {
  kind: 'tick';
  target: CombatChar;
}

export type BatchItem = BatchApplyItem | BatchCleanseItem | BatchTickItem;

// ─────────────────────────────────────────────────────────
// Result shapes
// ─────────────────────────────────────────────────────────

export interface BatchTickResult {
  targetId: string;
  ticked: number;
  expired: number;
}

export interface BatchCleanseResult {
  targetId: string;
  removed: StatusEffect[];
}

export interface BatchReport {
  /** Per-phase counts. */
  phaseCounts: Readonly<Record<TimelinePhase, number>>;
  /** Apply results in resolved order. */
  applies: ApplyResult[];
  /** Cleanse results in resolved order. */
  cleanses: BatchCleanseResult[];
  /** Tick results in resolved order. */
  ticks: BatchTickResult[];
}

// ─────────────────────────────────────────────────────────
// Batch entry point
// ─────────────────────────────────────────────────────────

/**
 * Resolve a batch of same-tick status events in CMD1.docx LOCK ORDER.
 *
 * Phase mapping:
 *   - tick / expire    → EXPIRE + TRIGGER phases (handled by `tickEffectsOnTarget`)
 *   - cleanse          → CLEANSE phase
 *   - existing refresh → REFRESH (auto-detected: `incoming.type` already on target)
 *   - new apply        → APPLY_NEW
 *
 * NOTE: tick & expire are bundled — `tickEffectsOnTarget` does both in one pass.
 * Phase EXPIRE is conceptually owned by tick (handler.onRemove fires for expired).
 */
export function applyTimelineBatch(
  items: readonly BatchItem[],
  applyCtx: StatusApplyContext,
  tickCtx: TickContext,
): BatchReport {
  // ── Build timeline events with proper phase tagging ──
  const events: TimelineEvent[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const seq = applyCtx.emitSeq ? nextStatusEmitSeq(applyCtx.emitSeq) : i;
    if (item.kind === 'tick') {
      // tick handles both EXPIRE + TRIGGER; bucket as TRIGGER for canonical order
      // (expire is internal to tickEffectsOnTarget — phase EXPIRE empty here).
      events.push(makeTimelineEvent(
        'TRIGGER', 'tick', item.target.id, 'system',
        { turnApplied: applyCtx.turn, sourceId: 'system', effectId: `tick_${item.target.id}`, emitSeq: seq },
        { index: i },
      ));
    } else if (item.kind === 'cleanse') {
      events.push(makeTimelineEvent(
        'CLEANSE', 'cleanse', item.target.id, 'cleanser',
        { turnApplied: applyCtx.turn, sourceId: 'cleanser', effectId: `cleanse_${item.target.id}_${i}`, emitSeq: seq },
        { index: i },
      ));
    } else {
      // Detect refresh vs new apply — same-type existing on target → REFRESH
      const existing = applyCtx.activeStatuses?.get(item.target.id)?.find((e) => e.type === item.incoming.type);
      const phase: TimelinePhase = existing ? 'REFRESH' : 'APPLY_NEW';
      events.push(makeTimelineEvent(
        phase, item.incoming.type, item.target.id, item.incoming.sourceId,
        makeStatusOrderKey(item.incoming, seq),
        { index: i },
      ));
    }
  }

  // ── Resolve in LOCK ORDER ──
  const sorted = resolveStatusTimeline(events);

  const phaseCounts: Record<TimelinePhase, number> = {
    EXPIRE: 0, CLEANSE: 0, REFRESH: 0, TRIGGER: 0, APPLY_NEW: 0,
  };
  const applies: ApplyResult[] = [];
  const cleanses: BatchCleanseResult[] = [];
  const ticks: BatchTickResult[] = [];

  // ── Aura guard tick per turn (resets per-turn caps before processing) ──
  if (applyCtx.auraGuard) {
    tickAuraGuard(applyCtx.auraGuard, applyCtx.turn);
  }

  // ── Execute in resolved order ──
  for (const ev of sorted) {
    phaseCounts[ev.phase] += 1;
    const idx = ev.payload?.index as number | undefined;
    if (idx === undefined) continue;
    const item = items[idx];
    if (!item) continue;

    if (item.kind === 'tick') {
      const r = tickEffectsOnTarget(item.target, tickCtx);
      ticks.push({ targetId: item.target.id, ticked: r.ticked, expired: r.expired });
      // Count expired as EXPIRE phase events (post-hoc)
      phaseCounts.EXPIRE += r.expired;
    } else if (item.kind === 'cleanse') {
      const active = applyCtx.activeStatuses?.get(item.target.id) ?? [];
      const runtime: CleanseRuntimeContext = {
        telemetry: extractTelemetry(applyCtx),
        currentTurn: applyCtx.turn,
        targetId: item.target.id,
      };
      const removed = selectCleansable(active, item.filter, item.immunity ?? {}, runtime);
      // Caller still responsible for actual mutation (fires onRemove + bus emit).
      cleanses.push({ targetId: item.target.id, removed });
    } else {
      // apply / refresh — both go through applyEffect (handler decides stack/refresh logic)
      const r = applyEffect(item.incoming, item.target, applyCtx);
      applies.push(r);
    }
  }

  return { phaseCounts, applies, cleanses, ticks };
}

function extractTelemetry(ctx: StatusApplyContext): StatusTelemetryState | undefined {
  return ctx.telemetry;
}
