/**
 * COMBAT RUNTIME — CMD1 deliverables composition layer.
 *
 * Final integration composition that wires together all CMD1 Phase 5/6/2-FH/6-FP
 * deliverables into a single per-encounter runtime context. Designed for
 * encounter_manager / server orchestration to instantiate ONCE per encounter
 * and pass through every combat tick.
 *
 * STRICT ADDITIVE — does NOT modify `encounter_manager.ts`, `apply_effect.ts`,
 * `tick_effect.ts`, or any combat ownership / pipeline file.
 *
 * Composes:
 *   - Phase 5: spatial layer + spawn registry + companion runtime + faction
 *   - Phase 6 base: boss AI + scheduler + delayed AoE + proximity + recorder
 *   - Phase 2 FH: proc budget + turn limiter + aura guard + telemetry + emit seq
 *   - Phase 6 FP: boss timeline resolver + mechanic budget + schema stamp
 *   - Compaction: auto-compact threshold hook
 *
 * Caller pattern:
 *   ```
 *   const rt = createCombatRuntime({ encounterId, sessionId });
 *   for (const turn of turns) {
 *     beginCombatTurn(rt, turn);
 *     // ... boss AI tick, status apply, etc. ...
 *     endCombatTurn(rt, turn);
 *   }
 *   finalizeEncounter(rt);
 *   ```
 */
import {
  createSpatialLayer, type SpatialLayerState,
} from './spatial_layer.js';
import {
  createDelayedAoeRegistry, type DelayedAoeRegistry,
  createProximityRegistry, type ProximityTriggerRegistry,
} from './spatial_combat_expansion.js';
import {
  createMechanicScheduler, type MechanicSchedulerState,
} from './mechanic_scheduler.js';
import {
  createMechanicBudget, pruneMechanicBudget, type MechanicBudgetState,
} from './mechanic_budget.js';
import {
  createProcBudget, resetProcBudget, type ProcBudgetState,
  createTurnEventLimiter, pruneTurnEventLimiter, type TurnEventLimiterState,
} from './status_proc_budget.js';
import {
  createAuraGuard, tickAuraGuard, type AuraGuardState,
} from './aura_propagation_guard.js';
import {
  createStatusTelemetry, type StatusTelemetryState,
} from './status_telemetry.js';
import {
  createStatusEmitSeq, type StatusEmitSeqState,
} from './status_ordering.js';
import {
  createReplayStream, type ReplayEventStream,
} from './replay_event_stream.js';
import {
  createRecorder, beginTurn as recBeginTurn, endTurn as recEndTurn,
  type EncounterRecorder,
} from './encounter_recording.js';
import {
  compactReplayStream, shouldCompact, streamMemoryStats,
  type CompactionPolicy, type CompactionReport, DEFAULT_COMPACTION_POLICY,
} from './replay_compaction.js';
import { currentSchemaStamp, type SchemaStamp } from './spatial_mechanic_schema_version.js';

// ─────────────────────────────────────────────────────────
// Runtime config + state
// ─────────────────────────────────────────────────────────

export interface CombatRuntimeConfig {
  encounterId: string;
  sessionId: string;
  /** Compaction policy (default lossless). */
  compactionPolicy?: CompactionPolicy;
  /** Memory threshold to trigger auto-compaction (bytes). */
  compactionThresholdBytes?: number;
  /** How often (in turns) to auto-prune turn-limiter / mechanic-budget Map entries. */
  pruneEveryNTurns?: number;
  /** How many recent turns to keep in pruned counters. */
  pruneKeepTurns?: number;
}

/**
 * Per-encounter combat runtime. Caller owns ONE instance for the life of the encounter.
 *
 * Fields are deliberately public — caller passes them directly to existing
 * `applyEffect / tickEffectsOnTarget / boss_ai_runtime / ...` APIs.
 *
 * NO new combat semantics — this is just a typed bag of state with a lifecycle.
 */
export interface CombatRuntime {
  readonly config: CombatRuntimeConfig;
  // ── Phase 5 ──
  spatialLayer: SpatialLayerState;
  // ── Phase 6 base ──
  scheduler: MechanicSchedulerState;
  aoeRegistry: DelayedAoeRegistry;
  proximityRegistry: ProximityTriggerRegistry;
  recorder: EncounterRecorder;
  replayStream: ReplayEventStream;
  // ── Phase 6 FP ──
  mechanicBudget: MechanicBudgetState;
  schemaStamp: SchemaStamp;
  // ── Phase 2 FH ──
  procBudget: ProcBudgetState;
  turnLimiter: TurnEventLimiterState;
  auraGuard: AuraGuardState;
  telemetry: StatusTelemetryState;
  emitSeq: StatusEmitSeqState;
  // ── Bookkeeping ──
  currentTurn: number;
  /** Cumulative auto-compaction reports (telemetry). */
  compactionHistory: CompactionReport[];
  /** Resolved config (with defaults applied). */
  resolvedCompactionPolicy: CompactionPolicy;
  resolvedCompactionThreshold: number;
  resolvedPruneEvery: number;
  resolvedPruneKeep: number;
}

export const DEFAULT_COMBAT_RUNTIME_OPTS = {
  compactionThresholdBytes: 512 * 1024,    // 512 KiB
  pruneEveryNTurns: 30,
  pruneKeepTurns: 10,
} as const;

// ─────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────

export function createCombatRuntime(config: CombatRuntimeConfig): CombatRuntime {
  const stream = createReplayStream(config.encounterId, config.sessionId);
  const recorder = createRecorder(stream);
  return {
    config,
    spatialLayer: createSpatialLayer(),
    scheduler: createMechanicScheduler(config.encounterId),
    aoeRegistry: createDelayedAoeRegistry(),
    proximityRegistry: createProximityRegistry(),
    recorder,
    replayStream: stream,
    mechanicBudget: createMechanicBudget(config.encounterId),
    schemaStamp: currentSchemaStamp(),
    procBudget: createProcBudget(`${config.encounterId}_action_0`),
    turnLimiter: createTurnEventLimiter(config.encounterId),
    auraGuard: createAuraGuard(config.encounterId),
    telemetry: createStatusTelemetry(config.encounterId),
    emitSeq: createStatusEmitSeq(),
    currentTurn: 0,
    compactionHistory: [],
    resolvedCompactionPolicy: config.compactionPolicy ?? DEFAULT_COMPACTION_POLICY,
    resolvedCompactionThreshold: config.compactionThresholdBytes
      ?? DEFAULT_COMBAT_RUNTIME_OPTS.compactionThresholdBytes,
    resolvedPruneEvery: config.pruneEveryNTurns
      ?? DEFAULT_COMBAT_RUNTIME_OPTS.pruneEveryNTurns,
    resolvedPruneKeep: config.pruneKeepTurns
      ?? DEFAULT_COMBAT_RUNTIME_OPTS.pruneKeepTurns,
  };
}

/** Begin a combat turn — caller invokes at top of each turn. */
export function beginCombatTurn(rt: CombatRuntime, turn: number): void {
  rt.currentTurn = turn;
  // Reset per-action proc budget at turn boundary (each turn starts fresh action)
  resetProcBudget(rt.procBudget, `${rt.config.encounterId}_action_${turn}`);
  // Aura guard turn tick — clears per-turn caps + per-chain dedup
  tickAuraGuard(rt.auraGuard, turn);
  // Recorder frame start
  recBeginTurn(rt.recorder, turn);
}

/**
 * End a combat turn — caller invokes at bottom of each turn.
 * Finalizes the replay frame, runs periodic maintenance:
 *   - prune turn-limiter + mechanic-budget Maps (memory hygiene)
 *   - auto-compact replay stream if over threshold
 */
export function endCombatTurn(rt: CombatRuntime, turn: number): void {
  // Recorder frame seal
  recEndTurn(rt.recorder);

  // Maintenance every N turn
  if (turn > 0 && turn % rt.resolvedPruneEvery === 0) {
    const keepBeyond = turn - rt.resolvedPruneKeep;
    pruneTurnEventLimiter(rt.turnLimiter, keepBeyond);
    pruneMechanicBudget(rt.mechanicBudget, keepBeyond);
  }

  // Memory pressure check — auto-compact
  const stats = streamMemoryStats(rt.replayStream);
  if (shouldCompact(stats, rt.resolvedCompactionThreshold)) {
    const report = compactReplayStream(rt.replayStream, rt.resolvedCompactionPolicy);
    rt.compactionHistory.push(report);
  }
}

/**
 * Finalize encounter — call after the last turn. Single terminal compaction
 * (so saved replay is compact even if threshold not crossed mid-encounter).
 */
export function finalizeEncounter(rt: CombatRuntime): CompactionReport {
  const report = compactReplayStream(rt.replayStream, rt.resolvedCompactionPolicy);
  rt.compactionHistory.push(report);
  return report;
}

// ─────────────────────────────────────────────────────────
// Convenience accessors — for downstream callers needing typed bags
// ─────────────────────────────────────────────────────────

/**
 * Build the optional-guard subset of a `StatusApplyContext`.
 *
 * Caller pattern:
 *   ```
 *   const applyCtx = { ...baseCtx, ...applyGuardsFromRuntime(rt) };
 *   applyEffect(incoming, target, applyCtx);
 *   ```
 */
export function applyGuardsFromRuntime(rt: CombatRuntime) {
  return {
    procBudget: rt.procBudget,
    turnLimiter: rt.turnLimiter,
    auraGuard: rt.auraGuard,
    telemetry: rt.telemetry,
    emitSeq: rt.emitSeq,
  };
}

/**
 * Build the optional-guard subset of a `TickContext`.
 */
export function tickGuardsFromRuntime(rt: CombatRuntime) {
  return {
    telemetry: rt.telemetry,
  };
}

// ─────────────────────────────────────────────────────────
// Stats / introspection
// ─────────────────────────────────────────────────────────

export interface CombatRuntimeStats {
  encounterId: string;
  sessionId: string;
  currentTurn: number;
  replayFrames: number;
  replayEvents: number;
  pendingMechanics: number;
  pendingAoe: number;
  pendingProximity: number;
  anomalyTotal: number;
  compactionCount: number;
}

export function runtimeStats(rt: CombatRuntime): CombatRuntimeStats {
  return {
    encounterId: rt.config.encounterId,
    sessionId: rt.config.sessionId,
    currentTurn: rt.currentTurn,
    replayFrames: rt.replayStream.frames.length,
    replayEvents: rt.replayStream.events.length,
    pendingMechanics: rt.scheduler.pending.size,
    pendingAoe: rt.aoeRegistry.markers.size,
    pendingProximity: rt.proximityRegistry.triggers.size,
    anomalyTotal: rt.telemetry.totalCount,
    compactionCount: rt.compactionHistory.length,
  };
}
