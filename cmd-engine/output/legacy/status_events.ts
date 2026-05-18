/**
 * STATUS EVENTS — extend CombatEvent với 3 new variant cho Phase 2.
 *
 * Note: existing event_bus.ts CombatEvent union covers basic
 * effect_applied / effect_expired / dot_tick / hot_tick / cc_applied / cc_expired.
 *
 * Phase 2 thêm 3 event chuyên biệt qua wrapper emit (vì refactor union shape =
 * bump EVENT_SCHEMA_VERSION). Dùng telemetry.writeRecord trực tiếp cho 3 event này
 * (DR / cleanse / overwrite) thay vì extend bus union — tránh schema bump cho v1.
 */
import type { Telemetry } from '../server/telemetry.js';
import type { StatusEffect, DRGroup } from './status_types.js';
import { currentClock, type DeterministicClock } from './deterministic_clock.js';

/**
 * FIX #7 — Status telemetry severity tier.
 *
 * - low:      observability, no action (DR_immune, stack_cap, overwrite_replace)
 * - medium:   suspicious but bounded (status_apply_fail, invalid_cleanse_attempt)
 * - high:     security-relevant (invalid_status_shape, recursion_abort)
 * - critical: integrity violation (protected_mutation, validation_throw)
 */
export type StatusEventSeverity = 'low' | 'medium' | 'high' | 'critical';

/** 7 new event kinds per FIX PHASE 2 § VIII. */
export type StatusEventKind =
  | 'status_apply_fail'
  | 'invalid_cleanse_attempt'
  | 'dr_immune_trigger'
  | 'stack_cap_hit'
  | 'overwrite_replace'
  | 'invalid_status_shape'
  | 'recursion_abort'
  | 'dr_triggered'
  | 'cleanse_triggered'
  | 'effect_overwritten';

export interface StatusEventBase {
  encounterId: string;
  turn: number;
  kind: StatusEventKind;
  severity: StatusEventSeverity;
  targetId?: string;
  sourceId?: string;
  effectType?: string;
  /** Free-form payload — caller responsibility to keep INT/serializable. */
  meta?: Record<string, unknown>;
}

/** Generic write — single entry point cho all 7 new event kinds. */
export function recordStatusEvent(tel: Telemetry, ev: StatusEventBase, clock?: DeterministicClock): void {
  tel.writeRecord({
    timestamp: (clock ?? currentClock()).nowIso(),
    category: ev.severity === 'critical' || ev.severity === 'high' ? 'anomaly' : 'skill_usage',
    encounterId: ev.encounterId,
    turn: ev.turn,
    playerId: ev.sourceId,
    data: {
      kind: ev.kind,
      severity: ev.severity,
      targetId: ev.targetId,
      effectType: ev.effectType,
      ...ev.meta,
    },
  });
}

export interface DRTriggeredRecord {
  encounterId: string;
  turn: number;
  targetId: string;
  group: DRGroup;
  level: number;
  resultBP: number;
}

export interface CleanseTriggeredRecord {
  encounterId: string;
  turn: number;
  sourceId: string;
  targetId: string;
  removedCount: number;
  removedTypes: string[];
}

export interface EffectOverwrittenRecord {
  encounterId: string;
  turn: number;
  targetId: string;
  removedType: string;
  newType: string;
}

/** Write DR triggered to telemetry. */
export function recordDRTriggered(tel: Telemetry, rec: DRTriggeredRecord, clock?: DeterministicClock): void {
  tel.writeRecord({
    timestamp: (clock ?? currentClock()).nowIso(),
    category: 'anomaly',   // map to anomaly bucket — DR is observability event
    encounterId: rec.encounterId,
    turn: rec.turn,
    data: { kind: 'dr_triggered', ...rec },
  });
}

export function recordCleanseTriggered(tel: Telemetry, rec: CleanseTriggeredRecord, clock?: DeterministicClock): void {
  tel.writeRecord({
    timestamp: (clock ?? currentClock()).nowIso(),
    category: 'skill_usage',
    encounterId: rec.encounterId,
    turn: rec.turn,
    playerId: rec.sourceId,
    data: { kind: 'cleanse_triggered', ...rec },
  });
}

export function recordEffectOverwritten(tel: Telemetry, rec: EffectOverwrittenRecord, clock?: DeterministicClock): void {
  tel.writeRecord({
    timestamp: (clock ?? currentClock()).nowIso(),
    category: 'skill_usage',
    encounterId: rec.encounterId,
    turn: rec.turn,
    data: { kind: 'effect_overwritten', ...rec },
  });
}

/** Build StatusEffect from skill template — helper for callers. */
export function buildStatusEffect(params: {
  effectId: string;
  type: StatusEffect['type'];
  category: StatusEffect['category'];
  sourceId: string;
  targetId: string;
  turnApplied: number;
  duration: number;
  amount: number;
  tickInterval?: number;
  drGroup: StatusEffect['drGroup'];
  stackBehavior: StatusEffect['stackBehavior'];
  initialStacks?: number;
}): StatusEffect {
  return {
    effectId: params.effectId,
    type: params.type,
    category: params.category,
    sourceId: params.sourceId,
    targetId: params.targetId,
    turnApplied: params.turnApplied,
    remainingTurns: params.duration,
    stacks: params.initialStacks ?? 1,
    amount: params.amount,
    tickInterval: params.tickInterval ?? 1,
    lastTickTurn: params.turnApplied,
    drGroup: params.drGroup,
    stackBehavior: params.stackBehavior,
  };
}
