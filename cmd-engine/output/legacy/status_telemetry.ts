/**
 * STATUS TELEMETRY — anomaly tracking (Phase 2 FH FIX #8).
 *
 * CMD1.docx:
 *   TRACK:
 *     - proc explosion
 *     - recursion overflow
 *     - invalid stack
 *     - replay divergence
 *     - timing conflict
 *   NO silent status failure.
 *
 * This module owns the canonical anomaly taxonomy + counter store + emit API.
 * Caller (apply pipeline / tick loop / proc budget / aura guard / timeline resolver)
 * invokes `recordAnomaly()` at every rejection point.
 *
 * Pure data — no I/O. Caller plugs in own sink (log file, prom counter, telemetry
 * service) by reading `snapshotTelemetry()` periodically.
 *
 * Replay-safe: anomaly records are TELEMETRY only — never feed back into combat
 * decisions. Recording carries them in `replay_event_stream.ts` as `custom` events.
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────
// Anomaly taxonomy — CMD1.docx 5 categories + sub-kinds
// ─────────────────────────────────────────────────────────

export const StatusAnomalyKindSchema = z.enum([
  // proc explosion
  'proc_budget_exhausted',
  'turn_event_cap',
  'same_type_cap',
  // recursion overflow
  'recursion_depth',
  'aura_depth_exceeded',
  'aura_visited_source',
  'aura_tick_budget',
  'aura_pair_already_applied',
  // invalid stack
  'stack_invalid_behavior',
  'stack_cap_breach',
  'overwrite_protected_field',
  // replay divergence
  'schema_version_mismatch',
  'schema_signature_drift',
  'timeline_phase_mismatch',
  'order_key_collision',
  // timing conflict
  'expire_during_refresh',
  'cleanse_during_trigger',
  'apply_during_expire',
  'tick_double_fire',
  // Phase 11 integration anomalies (CMD1.docx § XIV — production diagnostics)
  'replay_drift_detected',
  'boss_timeline_mismatch',
  'modifier_ordering_mismatch',
  'summon_recursion',
  'delayed_aoe_mismatch',
  'companion_ordering_mismatch',
  'integration_session_mismatch',
]);
export type StatusAnomalyKind = z.infer<typeof StatusAnomalyKindSchema>;

export const ANOMALY_CATEGORY: Readonly<Record<StatusAnomalyKind, string>> = Object.freeze({
  proc_budget_exhausted:   'proc_explosion',
  turn_event_cap:          'proc_explosion',
  same_type_cap:           'proc_explosion',
  recursion_depth:         'recursion_overflow',
  aura_depth_exceeded:     'recursion_overflow',
  aura_visited_source:     'recursion_overflow',
  aura_tick_budget:        'recursion_overflow',
  aura_pair_already_applied:'recursion_overflow',
  stack_invalid_behavior:  'invalid_stack',
  stack_cap_breach:        'invalid_stack',
  overwrite_protected_field:'invalid_stack',
  schema_version_mismatch: 'replay_divergence',
  schema_signature_drift:  'replay_divergence',
  timeline_phase_mismatch: 'replay_divergence',
  order_key_collision:     'replay_divergence',
  expire_during_refresh:   'timing_conflict',
  cleanse_during_trigger:  'timing_conflict',
  apply_during_expire:     'timing_conflict',
  tick_double_fire:        'timing_conflict',
  // Phase 11 integration anomalies
  replay_drift_detected:      'replay_divergence',
  boss_timeline_mismatch:     'replay_divergence',
  modifier_ordering_mismatch: 'replay_divergence',
  summon_recursion:           'recursion_overflow',
  delayed_aoe_mismatch:       'replay_divergence',
  companion_ordering_mismatch:'replay_divergence',
  integration_session_mismatch:'replay_divergence',
});

// ─────────────────────────────────────────────────────────
// Anomaly record
// ─────────────────────────────────────────────────────────

export interface AnomalyRecord {
  kind: StatusAnomalyKind;
  category: string;
  /** Encounter id (for shard correlation). */
  encounterId: string;
  /** Turn at which anomaly observed. */
  turn: number;
  /** Target / source / effect for forensics. */
  targetId?: string;
  sourceId?: string;
  effectType?: string;
  /** Free-form payload. */
  payload?: Readonly<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────
// Telemetry sink state
// ─────────────────────────────────────────────────────────

export interface StatusTelemetryState {
  encounterId: string;
  /** kind → count. */
  counts: Map<StatusAnomalyKind, number>;
  /** category → count. */
  byCategory: Map<string, number>;
  /** Recent records (bounded — caller drains). */
  recent: AnomalyRecord[];
  /** Cap on recent buffer (default 256). */
  recentCap: number;
  /** Total records observed (unbounded counter — does not decay). */
  totalCount: number;
}

export function createStatusTelemetry(encounterId: string, recentCap: number = 256): StatusTelemetryState {
  return {
    encounterId,
    counts: new Map(),
    byCategory: new Map(),
    recent: [],
    recentCap,
    totalCount: 0,
  };
}

/**
 * Record an anomaly. Pure mutation — no I/O, no throw.
 *
 * Caller passes a partial record; encounterId + category auto-fill.
 */
export function recordAnomaly(
  state: StatusTelemetryState,
  rec: Omit<AnomalyRecord, 'encounterId' | 'category'>,
): AnomalyRecord {
  const full: AnomalyRecord = {
    ...rec,
    encounterId: state.encounterId,
    category: ANOMALY_CATEGORY[rec.kind],
  };
  state.counts.set(rec.kind, (state.counts.get(rec.kind) ?? 0) + 1);
  state.byCategory.set(full.category, (state.byCategory.get(full.category) ?? 0) + 1);
  state.recent.push(full);
  if (state.recent.length > state.recentCap) {
    state.recent.splice(0, state.recent.length - state.recentCap);
  }
  state.totalCount += 1;
  return full;
}

// ─────────────────────────────────────────────────────────
// Query
// ─────────────────────────────────────────────────────────

export interface TelemetrySnapshot {
  encounterId: string;
  totalCount: number;
  byKind: Readonly<Record<string, number>>;
  byCategory: Readonly<Record<string, number>>;
  recent: readonly AnomalyRecord[];
}

export function snapshotTelemetry(state: StatusTelemetryState): TelemetrySnapshot {
  const byKind: Record<string, number> = {};
  for (const [k, v] of state.counts) byKind[k] = v;
  const byCategory: Record<string, number> = {};
  for (const [k, v] of state.byCategory) byCategory[k] = v;
  return {
    encounterId: state.encounterId,
    totalCount: state.totalCount,
    byKind,
    byCategory,
    recent: state.recent.slice(),
  };
}

/** Drain recent buffer — caller takes ownership, state empties. */
export function drainRecent(state: StatusTelemetryState): AnomalyRecord[] {
  const out = state.recent;
  state.recent = [];
  return out;
}

/** Total anomalies in a category. */
export function countByCategory(state: StatusTelemetryState, category: string): number {
  return state.byCategory.get(category) ?? 0;
}

/** Per-kind count. */
export function countByKind(state: StatusTelemetryState, kind: StatusAnomalyKind): number {
  return state.counts.get(kind) ?? 0;
}

/** Reset for new encounter (counters cleared, recentCap preserved). */
export function resetTelemetry(state: StatusTelemetryState): void {
  state.counts.clear();
  state.byCategory.clear();
  state.recent = [];
  state.totalCount = 0;
}

// ─────────────────────────────────────────────────────────
// Convenience emitters — wraps recordAnomaly with common shapes
// ─────────────────────────────────────────────────────────

export function emitProcRejected(
  state: StatusTelemetryState,
  turn: number,
  reason: 'proc_budget_exhausted' | 'turn_event_cap' | 'same_type_cap' | 'recursion_depth',
  effectType?: string,
  sourceId?: string,
): AnomalyRecord {
  return recordAnomaly(state, { kind: reason, turn, effectType, sourceId });
}

export function emitAuraRejected(
  state: StatusTelemetryState,
  turn: number,
  reason: 'aura_depth_exceeded' | 'aura_visited_source' | 'aura_tick_budget' | 'aura_pair_already_applied',
  auraType: string,
  sourceId: string,
): AnomalyRecord {
  return recordAnomaly(state, {
    kind: reason,
    turn,
    effectType: auraType,
    sourceId,
  });
}

export function emitTimingConflict(
  state: StatusTelemetryState,
  turn: number,
  kind: 'expire_during_refresh' | 'cleanse_during_trigger' | 'apply_during_expire' | 'tick_double_fire',
  targetId: string,
  effectType: string,
): AnomalyRecord {
  return recordAnomaly(state, { kind, turn, targetId, effectType });
}

export function emitReplayDivergence(
  state: StatusTelemetryState,
  turn: number,
  kind: 'schema_version_mismatch' | 'schema_signature_drift' | 'timeline_phase_mismatch' | 'order_key_collision',
  payload?: Readonly<Record<string, unknown>>,
): AnomalyRecord {
  return recordAnomaly(state, { kind, turn, payload });
}
