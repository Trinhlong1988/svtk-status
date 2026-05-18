/**
 * THREAT EVENTS — hooks + telemetry + recursion guard (Phase 4 § X, XV, XVI).
 *
 * Hook integration: ThreatEngine consumes combat events (DamageResolved, HealResolved, ...)
 * via subscriber pattern. Caller (encounter manager) wires bus.on(...) → ThreatEngine.applyThreatAction().
 *
 * Telemetry: 8 event kinds with severity tier (per spec § XVI):
 *   - threat_gain         (low — observability)
 *   - threat_decay        (low)
 *   - taunt_apply         (low)
 *   - taunt_immune        (medium — suspicious)
 *   - taunt_resisted      (low)
 *   - target_switch       (low)
 *   - aggro_reset         (medium)
 *   - threat_recursion_anomaly (high — chain depth exceeded)
 *   - invalid_threat_payload   (high — malformed input)
 *
 * Recursion guard: MAX_THREAT_RECURSION_DEPTH (passive→retarget→passive loop).
 */
import type { Telemetry } from '../server/telemetry.js';
import type { TargetResolveMode, TauntStateEntry } from './threat_types.js';
import { ThreatConstants } from './threat_constants.js';
import { currentClock, type DeterministicClock } from './deterministic_clock.js';

export type ThreatEventSeverity = 'low' | 'medium' | 'high' | 'critical';

export type ThreatEventKind =
  | 'threat_gain'
  | 'threat_decay'
  | 'taunt_apply'
  | 'taunt_immune'
  | 'taunt_resisted'
  | 'target_switch'
  | 'aggro_reset'
  | 'threat_recursion_anomaly'
  | 'invalid_threat_payload';

export interface ThreatEvent {
  encounterId: string;
  turn: number;
  kind: ThreatEventKind;
  severity: ThreatEventSeverity;
  attackerId?: string;
  targetId?: string;
  meta?: Record<string, unknown>;
}

export function recordThreatEvent(tel: Telemetry, ev: ThreatEvent, clock?: DeterministicClock): void {
  tel.writeRecord({
    timestamp: (clock ?? currentClock()).nowIso(),
    category: ev.severity === 'high' || ev.severity === 'critical' ? 'anomaly' : 'skill_usage',
    encounterId: ev.encounterId,
    turn: ev.turn,
    playerId: ev.attackerId,
    data: {
      kind: ev.kind,
      severity: ev.severity,
      targetId: ev.targetId,
      ...ev.meta,
    },
  });
}

// ─────────────────────────────────────────────────────────
// Recursion guard
// ─────────────────────────────────────────────────────────

export class ThreatRecursionAbortError extends Error {
  constructor(
    public readonly depth: number,
    public readonly chainPath: ReadonlyArray<string>,
  ) {
    super(
      `[ThreatRecursionAbort] depth=${depth} >= MAX (${ThreatConstants.MAX_THREAT_RECURSION_DEPTH}) ` +
      `chain=${chainPath.join(' → ')}`,
    );
    this.name = 'ThreatRecursionAbortError';
  }
}

export class ThreatRecursionTracker {
  private depth = 0;
  private chain: string[] = [];

  enter(label: string): void {
    this.depth++;
    if (this.depth > ThreatConstants.MAX_THREAT_RECURSION_DEPTH) {
      const final = [...this.chain, label];
      throw new ThreatRecursionAbortError(this.depth, final);
    }
    this.chain.push(label);
  }

  exit(): void {
    this.chain.pop();
    this.depth = Math.max(0, this.depth - 1);
  }

  snapshot(): { depth: number; chain: ReadonlyArray<string> } {
    return { depth: this.depth, chain: [...this.chain] };
  }

  reset(): void {
    this.depth = 0;
    this.chain = [];
  }
}

// ─────────────────────────────────────────────────────────
// Hook helpers — caller wires bus events → engine
// ─────────────────────────────────────────────────────────

export interface DamageResolvedHookInput {
  attackerId: string;
  targetId: string;
  amount: number;
  isCrit: boolean;
}

export interface HealResolvedHookInput {
  healerId: string;
  targetId: string;
  amount: number;
}

export interface TauntAppliedHookInput {
  sourceId: string;
  targetId: string;
  duration: number;
}

export interface EntityDeathHookInput {
  victimId: string;
}

/** Build telemetry event from target switch (fires when current → new). */
export function buildTargetSwitchEvent(
  encounterId: string,
  turn: number,
  oldTargetId: string | undefined,
  newTargetId: string,
  mode: TargetResolveMode,
): ThreatEvent {
  return {
    encounterId,
    turn,
    kind: 'target_switch',
    severity: 'low',
    targetId: newTargetId,
    meta: { oldTargetId, mode },
  };
}

/** Build telemetry event from taunt apply outcome. */
export function buildTauntEvent(
  encounterId: string,
  turn: number,
  outcome: 'applied' | 'refreshed' | 'resisted' | 'immune' | 'dr_blocked' | 'invalid_duration',
  state?: TauntStateEntry,
): ThreatEvent {
  const sevMap: Record<typeof outcome, ThreatEventSeverity> = {
    applied: 'low',
    refreshed: 'low',
    resisted: 'low',
    immune: 'medium',
    dr_blocked: 'low',
    invalid_duration: 'high',
  };
  const kindMap: Record<typeof outcome, ThreatEventKind> = {
    applied: 'taunt_apply',
    refreshed: 'taunt_apply',
    resisted: 'taunt_resisted',
    immune: 'taunt_immune',
    dr_blocked: 'taunt_resisted',
    invalid_duration: 'invalid_threat_payload',
  };
  return {
    encounterId,
    turn,
    kind: kindMap[outcome],
    severity: sevMap[outcome],
    attackerId: state?.forcedSourceId,
    targetId: state?.targetId,
    meta: { outcome, drLevel: state?.drLevel },
  };
}
