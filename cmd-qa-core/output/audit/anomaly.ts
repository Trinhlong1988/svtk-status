/**
 * ANOMALY DETECTION — Phase 1 hardening FIX #10.
 *
 * Subscribe EventBus '*' wildcard, detect anomaly per event:
 *   - NaN / Infinity in damage / heal / threat delta
 *   - Negative damage (after Math.max(0, ...) defensive)
 *   - Overflow (number > Number.MAX_SAFE_INTEGER)
 *   - Replay mismatch (caller compares + reports)
 *   - Invalid mutation (caught in EventBus pre_resolve guard, anomaly logs)
 *
 * Production-safe: log to telemetry category 'anomaly'. KHÔNG combat crash unless critical.
 *
 * Module 4+ wire AnomalyDetector vào encounter manager.
 */
import type { CombatEvent } from '../logic/event_bus.js';
import { EventBus } from '../logic/event_bus.js';
import type { Telemetry } from './telemetry.js';
import { currentClock } from '../logic/deterministic_clock.js';

export type AnomalyKind =
  | 'nan_damage'
  | 'nan_heal'
  | 'negative_damage'
  | 'negative_heal'
  | 'overflow_damage'
  | 'overflow_heal'
  | 'invalid_event_shape'
  | 'replay_mismatch'
  | 'replay_divergence'
  | 'event_recursion_detected'
  | 'rng_desync'
  | 'impossible_damage'
  | 'impossible_heal'
  | 'negative_cooldown'
  | 'overflow_shield'
  | 'stale_mutation_seq'
  | 'duplicated_event_id'
  | 'emit_depth_exceeded';

export type AnomalySeverity = 'low' | 'medium' | 'high' | 'critical';

const SEVERITY_BY_KIND: Record<AnomalyKind, AnomalySeverity> = {
  nan_damage: 'critical',
  nan_heal: 'critical',
  overflow_damage: 'critical',
  overflow_heal: 'critical',
  overflow_shield: 'critical',
  emit_depth_exceeded: 'critical',
  rng_desync: 'critical',
  replay_divergence: 'critical',
  impossible_damage: 'high',
  impossible_heal: 'high',
  invalid_event_shape: 'high',
  event_recursion_detected: 'high',
  replay_mismatch: 'high',
  duplicated_event_id: 'medium',
  stale_mutation_seq: 'medium',
  negative_damage: 'medium',
  negative_heal: 'medium',
  negative_cooldown: 'low',
};

export interface AnomalyRecord {
  kind: AnomalyKind;
  severity: AnomalySeverity;
  encounterId?: string;
  turn?: number;
  event?: CombatEvent;
  detail?: Record<string, unknown>;
}

const SAFE_INT_LIMIT = Number.MAX_SAFE_INTEGER;

/** Input for `report()` — severity auto-derived from kind unless explicit. */
export type AnomalyInput = Omit<AnomalyRecord, 'severity'> & { severity?: AnomalySeverity };

export class AnomalyDetector {
  private records: AnomalyRecord[] = [];
  private aggregateByKind = new Map<AnomalyKind, number>();
  private seenEventIds = new Set<string>();

  constructor(private telemetry?: Telemetry) {}

  /** Subscribe to bus — wildcard listener phase 'post_log' (read-only). */
  attach(bus: EventBus, ctx: { encounterId: string }): () => void {
    return bus.on('*', (event) => this.inspect(event, ctx), { phase: 'post_log' });
  }

  inspect(event: CombatEvent, ctx: { encounterId: string }): void {
    const turn = (event as { turn?: number }).turn;
    if ('damage' in event && typeof event.damage === 'number') {
      if (Number.isNaN(event.damage)) this.report({ kind: 'nan_damage', encounterId: ctx.encounterId, turn, event });
      else if (event.damage < 0) this.report({ kind: 'negative_damage', encounterId: ctx.encounterId, turn, event });
      else if (event.damage > SAFE_INT_LIMIT) this.report({ kind: 'overflow_damage', encounterId: ctx.encounterId, turn, event });
    }
    if ('heal' in event && typeof event.heal === 'number') {
      if (Number.isNaN(event.heal)) this.report({ kind: 'nan_heal', encounterId: ctx.encounterId, turn, event });
      else if (event.heal < 0) this.report({ kind: 'negative_heal', encounterId: ctx.encounterId, turn, event });
      else if (event.heal > SAFE_INT_LIMIT) this.report({ kind: 'overflow_heal', encounterId: ctx.encounterId, turn, event });
    }
    // Duplicated event id detection (vd cùng cast emitted twice trong cùng turn)
    const eid = `${ctx.encounterId}|${event.type}|t${turn ?? 'x'}|${JSON.stringify(event)}`;
    if (this.seenEventIds.has(eid)) {
      this.report({ kind: 'duplicated_event_id', encounterId: ctx.encounterId, turn, event });
    } else {
      this.seenEventIds.add(eid);
    }
  }

  /** Manually report anomaly (vd from replay diff caller). Severity auto-derived if not specified. */
  report(record: AnomalyInput): void {
    const severity = record.severity ?? SEVERITY_BY_KIND[record.kind];
    const full: AnomalyRecord = { ...record, severity };
    this.records.push(full);
    this.aggregateByKind.set(record.kind, (this.aggregateByKind.get(record.kind) ?? 0) + 1);
    if (this.telemetry) {
      this.telemetry.writeRecord({
        timestamp: currentClock().nowIso(),
        category: 'anomaly',
        ...(record.encounterId !== undefined && { encounterId: record.encounterId }),
        ...(record.turn !== undefined && { turn: record.turn }),
        data: { kind: record.kind, severity, ...(record.detail ?? {}) },
      });
    }
  }

  /** All anomalies recorded (test / dashboard). */
  all(): readonly AnomalyRecord[] {
    return this.records;
  }

  /** Per-kind aggregation count. */
  aggregate(): ReadonlyMap<AnomalyKind, number> {
    return this.aggregateByKind;
  }

  /** Filter by severity tier. */
  bySeverity(severity: AnomalySeverity): AnomalyRecord[] {
    return this.records.filter((r) => r.severity === severity);
  }

  clear(): void {
    this.records = [];
    this.aggregateByKind.clear();
    this.seenEventIds.clear();
  }
}
