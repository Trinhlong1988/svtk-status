/**
 * THREAT OBSERVABILITY — telemetry expand + rate limiter + playback hint
 * (FIX PHASE 4 #8, #9, #10).
 *
 * 3 sub-modules gộp 1 file:
 *
 * A. TELEMETRY EXPAND:
 *    - flicker count (target switch frequency)
 *    - spike anomaly (>30000 BP spike in 1 turn)
 *    - retarget high frequency (>4/turn)
 *    - taunt immunity streak (>3 consecutive)
 *    - companion aggro instability
 *
 * B. RATE LIMITER:
 *    - per-tick max threat (anti spam DOT/HOT overflow)
 *    - per-action max threat (anti single-action burst)
 *    - summon burst cap (anti summon spam aggro)
 *    - HOT/DOT aggregation (combine N ticks into 1 telemetry event)
 *
 * C. PLAYBACK HINT (UI):
 *    - aggro marker (current target FX)
 *    - taunt indicator (animation cue)
 *    - boss focus FX (camera highlight)
 *    - target change notification (sound/visual)
 */
import { ThreatConstants } from './threat_constants.js';

// ─────────────────────────────────────────────────────────
// A. Telemetry expand
// ─────────────────────────────────────────────────────────

export type ExtendedThreatEventKind =
  | 'target_flicker_high'
  | 'threat_spike_anomaly'
  | 'retarget_high_frequency'
  | 'taunt_immunity_streak'
  | 'companion_aggro_unstable';

export interface ThreatObservabilityCounters {
  /** Target switch count this turn. */
  targetSwitchCount: number;
  /** Last target id. */
  lastTargetId?: string;
  /** Per-turn threat delta for spike detection. */
  perTurnDelta: number;
  /** Consecutive taunt immune count. */
  consecutiveImmuneCount: number;
  /** Total retargets this combat. */
  totalRetargets: number;
}

export function createObservabilityCounters(): ThreatObservabilityCounters {
  return {
    targetSwitchCount: 0,
    perTurnDelta: 0,
    consecutiveImmuneCount: 0,
    totalRetargets: 0,
  };
}

export interface AnomalyHint {
  kind: ExtendedThreatEventKind;
  meta: Record<string, number | string>;
}

/** Detect target flicker (switch count > threshold). */
export function detectFlicker(c: ThreatObservabilityCounters): AnomalyHint | null {
  if (c.targetSwitchCount >= ThreatConstants.TELEMETRY_FLICKER_THRESHOLD) {
    return {
      kind: 'target_flicker_high',
      meta: { count: c.targetSwitchCount },
    };
  }
  return null;
}

/** Detect spike anomaly (delta > 30000 BP). */
export function detectSpikeAnomaly(c: ThreatObservabilityCounters): AnomalyHint | null {
  if (Math.abs(c.perTurnDelta) >= ThreatConstants.TELEMETRY_SPIKE_ANOMALY_BP) {
    return {
      kind: 'threat_spike_anomaly',
      meta: { delta: c.perTurnDelta },
    };
  }
  return null;
}

/** Detect retarget high-freq. */
export function detectRetargetHighFreq(c: ThreatObservabilityCounters): AnomalyHint | null {
  if (c.totalRetargets >= ThreatConstants.TELEMETRY_RETARGET_HIGH_FREQ_PER_TURN) {
    return {
      kind: 'retarget_high_frequency',
      meta: { count: c.totalRetargets },
    };
  }
  return null;
}

/** Record target switch (caller invokes after resolveAndCommitTarget). */
export function recordTargetSwitch(c: ThreatObservabilityCounters, newId: string): void {
  if (c.lastTargetId && c.lastTargetId !== newId) {
    c.targetSwitchCount++;
    c.totalRetargets++;
  }
  c.lastTargetId = newId;
}

/** Reset turn counters (call at turn end). */
export function resetTurnCounters(c: ThreatObservabilityCounters): void {
  c.targetSwitchCount = 0;
  c.perTurnDelta = 0;
}

// ─────────────────────────────────────────────────────────
// B. Rate limiter
// ─────────────────────────────────────────────────────────

export interface ThreatRateLimitState {
  /** Threat applied this tick (resets every turn). */
  thisTickThreat: number;
  /** Summon burst counter. */
  summonBurstCount: number;
  /** Pending DOT/HOT aggregate. */
  pendingDotAggregate: number;
  pendingHotAggregate: number;
  /** Last turn aggregated flushed. */
  lastFlushTurn: number;
}

export function createRateLimitState(): ThreatRateLimitState {
  return {
    thisTickThreat: 0,
    summonBurstCount: 0,
    pendingDotAggregate: 0,
    pendingHotAggregate: 0,
    lastFlushTurn: 0,
  };
}

export interface RateLimitOutcome {
  allowed: boolean;
  clampedAmount: number;
  reason?: 'per_tick_cap' | 'per_action_cap' | 'summon_burst_cap';
}

/** Check + clamp threat amount under rate limit rules. */
export function rateLimitCheck(
  state: ThreatRateLimitState,
  amount: number,
  isSummonSource: boolean = false,
): RateLimitOutcome {
  // Per-action cap
  let clamped = amount;
  let reason: RateLimitOutcome['reason'];
  if (clamped > ThreatConstants.RATE_LIMIT_MAX_THREAT_PER_ACTION) {
    clamped = ThreatConstants.RATE_LIMIT_MAX_THREAT_PER_ACTION;
    reason = 'per_action_cap';
  }
  // Per-tick cap
  const remaining = ThreatConstants.RATE_LIMIT_MAX_THREAT_PER_TICK - state.thisTickThreat;
  if (remaining <= 0) {
    return { allowed: false, clampedAmount: 0, reason: 'per_tick_cap' };
  }
  if (clamped > remaining) {
    clamped = remaining;
    reason = reason ?? 'per_tick_cap';
  }
  // Summon burst
  if (isSummonSource) {
    if (state.summonBurstCount >= ThreatConstants.RATE_LIMIT_SUMMON_BURST_CAP) {
      return { allowed: false, clampedAmount: 0, reason: 'summon_burst_cap' };
    }
    state.summonBurstCount++;
  }
  state.thisTickThreat += clamped;
  return { allowed: clamped > 0, clampedAmount: clamped, reason };
}

/** Reset per-tick counters at turn end. */
export function resetRateLimitTick(state: ThreatRateLimitState): void {
  state.thisTickThreat = 0;
  state.summonBurstCount = 0;
}

/** Aggregate DOT/HOT — caller queues per tick; flush every N turn. */
export function queueDotAggregate(state: ThreatRateLimitState, amount: number): void {
  state.pendingDotAggregate += amount;
}

export function queueHotAggregate(state: ThreatRateLimitState, amount: number): void {
  state.pendingHotAggregate += amount;
}

/** Flush aggregate if N turns passed since last flush. Returns flushed amounts. */
export function flushAggregateIfDue(
  state: ThreatRateLimitState,
  currentTurn: number,
): { dotFlushed: number; hotFlushed: number; flushed: boolean } {
  if (currentTurn - state.lastFlushTurn < ThreatConstants.RATE_LIMIT_DOT_AGGREGATE_TURNS) {
    return { dotFlushed: 0, hotFlushed: 0, flushed: false };
  }
  const dot = state.pendingDotAggregate;
  const hot = state.pendingHotAggregate;
  state.pendingDotAggregate = 0;
  state.pendingHotAggregate = 0;
  state.lastFlushTurn = currentTurn;
  return { dotFlushed: dot, hotFlushed: hot, flushed: true };
}

// ─────────────────────────────────────────────────────────
// C. Playback hint (UI)
// ─────────────────────────────────────────────────────────

export type PlaybackHintKind =
  | 'aggro_marker'              // current target highlight
  | 'taunt_indicator'           // taunt FX overhead
  | 'boss_focus_fx'             // camera focus on new target
  | 'target_change_notify'      // SFX/visual cue
  | 'aggro_high_alert'          // tank-aggro lost (heal-pull)
  | 'companion_aggro_warning';  // companion drew boss attention

export interface PlaybackHint {
  kind: PlaybackHintKind;
  entityId: string;
  /** Optional source (vd taunt caster). */
  sourceId?: string;
  /** Hint priority (UI render order). */
  priority: number;
  /** TTL ms (auto-dismiss). */
  ttlMs: number;
}

/** Build aggro marker hint (current target). */
export function buildAggroMarker(targetId: string): PlaybackHint {
  return { kind: 'aggro_marker', entityId: targetId, priority: 10, ttlMs: 0 /* persistent */ };
}

/** Build target change notification. */
export function buildTargetChangeNotify(newTargetId: string, oldTargetId?: string): PlaybackHint {
  return {
    kind: 'target_change_notify',
    entityId: newTargetId,
    sourceId: oldTargetId,
    priority: 5,
    ttlMs: 1500,
  };
}

/** Build taunt indicator. */
export function buildTauntIndicator(targetBossId: string, casterId: string, durationMs: number): PlaybackHint {
  return {
    kind: 'taunt_indicator',
    entityId: targetBossId,
    sourceId: casterId,
    priority: 8,
    ttlMs: durationMs,
  };
}

/** Build heal-pull alert (DPS/Healer drew aggro from Tank). */
export function buildAggroHighAlert(entityId: string): PlaybackHint {
  return { kind: 'aggro_high_alert', entityId, priority: 9, ttlMs: 3000 };
}
