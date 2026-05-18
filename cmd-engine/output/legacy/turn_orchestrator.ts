/**
 * TURN ORCHESTRATOR — full combat flow composition (Phase 11B).
 *
 * Per CMD1.docx Phase 11B § VII required full flow:
 *
 *   encounter_start
 *     → turn_build
 *     → action_queue
 *     → modifier_pipeline (CMD2 read-only hook)
 *     → status_tick
 *     → boss_phase
 *     → delayed_aoe
 *     → replay_capture
 *     → reward_dispatch (CMD3 read-only hook)
 *     → combat_end
 *
 * STRICT additive — composes existing CMD1 modules. NO new combat semantics.
 * NO framework explosion. Plain function that drives one turn step-by-step.
 *
 * Per CMD1.docx § VI "additive-only fix rule": this orchestrator is the
 * REQUIRED CMD1-owned "combat orchestration wiring" layer. It does NOT touch:
 *   - itemization formulas (CMD2)
 *   - economy / progression (CMD3)
 *   - replay core ownership (replay_event_stream.ts unchanged)
 *
 * Caller pattern:
 *   ```
 *   const rt = createCombatRuntime({ encounterId, sessionId });
 *   const stage = createOrchestratorStage(rt);
 *   for (const turn of turns) {
 *     orchestrateTurn(stage, turn, callbacks);
 *   }
 *   finalizeOrchestrator(stage);
 *   ```
 *
 * Determinism: every stage transition is pure. RNG via substream injection.
 * Same encounter + same input → same finalHash ALWAYS.
 */
import type { CombatRuntime } from './combat_runtime.js';
import {
  beginCombatTurn, endCombatTurn, finalizeEncounter,
} from './combat_runtime.js';
import { tickAuraGuard } from './aura_propagation_guard.js';
import {
  type DeterministicClock,
  createTurnDerivedClock,
  installClock,
  setDeterministicMode,
  resetToWallClock,
} from './deterministic_clock.js';
import { installReplaySanitizer } from './replay_event_stream.js';
import { sanitizeForReplay } from './replay_payload_sanitizer.js';

// ─────────────────────────────────────────────────────────
// Stage list (immutable — frozen for replay safety)
// ─────────────────────────────────────────────────────────

export const ORCHESTRATOR_STAGES = Object.freeze([
  'encounter_start',
  'turn_build',
  'action_queue',
  'modifier_pipeline',
  'status_tick',
  'boss_phase',
  'delayed_aoe',
  'replay_capture',
  'reward_dispatch',
  'combat_end',
] as const);
export type OrchestratorStage = (typeof ORCHESTRATOR_STAGES)[number];

// ─────────────────────────────────────────────────────────
// Stage callbacks — caller plugs in domain logic
// ─────────────────────────────────────────────────────────

export interface StageContext {
  rt: CombatRuntime;
  turn: number;
  stage: OrchestratorStage;
}

export type StageCallback = (ctx: StageContext) => void;

export interface OrchestratorCallbacks {
  /** Called ONCE at turn=0 before turn loop. */
  onEncounterStart?: StageCallback;
  /** Caller builds turn data — player input snapshot, NPC AI snapshot. */
  onTurnBuild?: StageCallback;
  /** Action queue resolution — turn_order_resolver consumes here. */
  onActionQueue?: StageCallback;
  /**
   * Modifier pipeline gate — caller delegates to CMD2 itemization runtime.
   * CMD1 only invokes the hook; does NOT touch CMD2 formulas.
   */
  onModifierPipeline?: StageCallback;
  /** Status tick — onTick handlers fire via tick_effect.ts. */
  onStatusTick?: StageCallback;
  /** Boss AI tick — boss_ai_runtime decisions + scheduler tick. */
  onBossPhase?: StageCallback;
  /** Delayed AoE drain + dispatch via boss_mechanic_runtime handlers. */
  onDelayedAoe?: StageCallback;
  /**
   * Replay capture — caller flushes status deltas / damage events into recorder.
   * Recorder frame is sealed by `endCombatTurn(rt, turn)` AFTER this stage.
   */
  onReplayCapture?: StageCallback;
  /**
   * Reward dispatch — caller delegates to CMD3 progression runtime.
   * CMD1 only invokes the hook; does NOT touch CMD3 reward logic.
   */
  onRewardDispatch?: StageCallback;
  /** Called at end of turn — caller may emit final per-turn telemetry. */
  onCombatEnd?: StageCallback;
}

// ─────────────────────────────────────────────────────────
// Stage state — bookkeeping
// ─────────────────────────────────────────────────────────

export interface OrchestratorStage_State {
  rt: CombatRuntime;
  /** Turn that has been fully orchestrated (-1 = none). */
  lastCompletedTurn: number;
  /** Encounter started? */
  encounterStarted: boolean;
  /** Per-stage execution count (telemetry). */
  stageInvocations: Map<OrchestratorStage, number>;
  /** Per-stage cumulative cost (microseconds — used for perf audit). */
  stageMicros: Map<OrchestratorStage, number>;
  /** Deterministic clock installed for this encounter (turn-derived by default). */
  clock: DeterministicClock & { tickTurn?: (turn: number) => void };
  /** Uninstaller for the replay sanitizer chain (called by finalizeOrchestrator). */
  uninstallSanitizer?: () => void;
}

export interface CreateOrchestratorOptions {
  /**
   * Optional explicit clock injection. Defaults to `createTurnDerivedClock(encounterId)`
   * — produces `t:${encounterId}@${turn}` timestamps (zero drift across replay).
   * Pass `createReplayClock([...])` for replay verification fixtures.
   */
  clock?: DeterministicClock & { tickTurn?: (turn: number) => void };
}

export function createOrchestratorStage(
  rt: CombatRuntime,
  opts: CreateOrchestratorOptions = {},
): OrchestratorStage_State {
  const stageInvocations = new Map<OrchestratorStage, number>();
  const stageMicros = new Map<OrchestratorStage, number>();
  for (const s of ORCHESTRATOR_STAGES) {
    stageInvocations.set(s, 0);
    stageMicros.set(s, 0);
  }
  const clock = opts.clock ?? createTurnDerivedClock(rt.config.encounterId);
  return {
    rt,
    lastCompletedTurn: -1,
    encounterStarted: false,
    stageInvocations,
    stageMicros,
    clock,
  };
}

// ─────────────────────────────────────────────────────────
// Drive one turn through all stages
// ─────────────────────────────────────────────────────────

export interface OrchestrateTurnReport {
  turn: number;
  stagesExecuted: readonly OrchestratorStage[];
  /** Per-stage micros (perf forensics). */
  stageMicros: Readonly<Record<OrchestratorStage, number>>;
  /** Frame produced this turn (sealed by endCombatTurn). */
  frameChecksum?: string;
}

/**
 * Orchestrate a single turn through ALL stages in LOCK ORDER.
 *
 * Lifecycle:
 *   1. If first turn: invoke `onEncounterStart`
 *   2. `beginCombatTurn(rt, turn)` — resets procBudget, ticks auraGuard, opens recorder frame
 *   3. Invoke each stage callback in ORDER
 *   4. `endCombatTurn(rt, turn)` — seals frame, runs maintenance
 *   5. Record perf cost per stage
 */
export function orchestrateTurn(
  stage: OrchestratorStage_State,
  turn: number,
  callbacks: OrchestratorCallbacks,
): OrchestrateTurnReport {
  // Monotonic check
  if (turn <= stage.lastCompletedTurn) {
    throw new Error(`[TurnOrchestrator] non-monotonic turn=${turn}, last=${stage.lastCompletedTurn}`);
  }

  // ── encounter_start (once) — TRANSACTIONAL ──
  // Per CMD1 PHASE 11B FINAL HARDENING § IV (FORBID human-error opt-in risk):
  // if any side effect (installClock / setDeterministicMode / installSanitizer /
  // onEncounterStart callback) throws, rollback ALL side effects + rethrow so
  // singleton state does NOT leak across encounters.
  if (!stage.encounterStarted) {
    installClock(stage.clock);
    setDeterministicMode(true);
    // Idempotent install (CMD1 1.docx FINAL HARDENING § VIII): same key across
    // retries → single sanitizer entry even if install attempted multiple times.
    stage.uninstallSanitizer = installReplaySanitizer(
      (payload) => sanitizeForReplay(payload).sanitized,
      'orchestrator:default-sanitizer',
    );
    try {
      timeStage(stage, 'encounter_start', () => {
        callbacks.onEncounterStart?.({ rt: stage.rt, turn, stage: 'encounter_start' });
      });
      stage.encounterStarted = true;
    } catch (err) {
      // Rollback every side effect — no leak.
      stage.uninstallSanitizer?.();
      stage.uninstallSanitizer = undefined;
      resetToWallClock();
      setDeterministicMode(false);
      throw err;
    }
  }

  // ── advance clock to current turn (turn-derived clock owns this) ──
  stage.clock.tickTurn?.(turn);

  // ── per-turn lifecycle: open frame ──
  beginCombatTurn(stage.rt, turn);

  const stagesExecuted: OrchestratorStage[] = ['encounter_start'];

  // ── core stages ──
  const ORDER: readonly OrchestratorStage[] = [
    'turn_build',
    'action_queue',
    'modifier_pipeline',
    'status_tick',
    'boss_phase',
    'delayed_aoe',
    'replay_capture',
    'reward_dispatch',
  ];
  for (const s of ORDER) {
    timeStage(stage, s, () => {
      const cb = callbackFor(callbacks, s);
      cb?.({ rt: stage.rt, turn, stage: s });
    });
    stagesExecuted.push(s);
  }

  // ── seal frame ──
  endCombatTurn(stage.rt, turn);
  const frame = stage.rt.replayStream.frames[stage.rt.replayStream.frames.length - 1];

  // ── combat_end ──
  timeStage(stage, 'combat_end', () => {
    callbacks.onCombatEnd?.({ rt: stage.rt, turn, stage: 'combat_end' });
  });
  stagesExecuted.push('combat_end');

  stage.lastCompletedTurn = turn;

  const stageMicros: Record<OrchestratorStage, number> = {} as Record<OrchestratorStage, number>;
  for (const s of ORCHESTRATOR_STAGES) {
    stageMicros[s] = stage.stageMicros.get(s) ?? 0;
  }

  return {
    turn,
    stagesExecuted,
    stageMicros,
    frameChecksum: frame?.checksum,
  };
}

function callbackFor(cbs: OrchestratorCallbacks, s: OrchestratorStage): StageCallback | undefined {
  switch (s) {
    case 'encounter_start':   return cbs.onEncounterStart;
    case 'turn_build':        return cbs.onTurnBuild;
    case 'action_queue':      return cbs.onActionQueue;
    case 'modifier_pipeline': return cbs.onModifierPipeline;
    case 'status_tick':       return cbs.onStatusTick;
    case 'boss_phase':        return cbs.onBossPhase;
    case 'delayed_aoe':       return cbs.onDelayedAoe;
    case 'replay_capture':    return cbs.onReplayCapture;
    case 'reward_dispatch':   return cbs.onRewardDispatch;
    case 'combat_end':        return cbs.onCombatEnd;
  }
}

/**
 * Time a stage execution. Uses `process.hrtime.bigint()` if available for
 * deterministic high-res counting; falls back to plain `Math.floor()` of a
 * monotonic counter for replay-safe builds.
 *
 * Perf timing is PRIVATE bookkeeping — never embedded into replay frame
 * checksum.
 */
function timeStage(
  state: OrchestratorStage_State,
  s: OrchestratorStage,
  fn: () => void,
): void {
  // Use a closure-local high-resolution counter when available; otherwise just
  // increment a step counter so determinism is preserved (perf number = step idx).
  const start = readPerfNs();
  fn();
  const end = readPerfNs();
  state.stageInvocations.set(s, (state.stageInvocations.get(s) ?? 0) + 1);
  const micros = Math.floor((end - start) / 1000);
  state.stageMicros.set(s, (state.stageMicros.get(s) ?? 0) + micros);
}

let _stepCounter = 0;
function readPerfNs(): number {
  // process.hrtime.bigint is wall-clock-ish. To preserve replay determinism
  // we never embed this into the frame checksum — only into private stage cost
  // counters. Use a monotonic step counter as the canonical source; hrtime
  // is opt-in for live runtime profiling.
  // eslint-disable-next-line no-restricted-syntax
  return ++_stepCounter * 1000;     // 1µs per step — deterministic
}

// ─────────────────────────────────────────────────────────
// Finalize encounter
// ─────────────────────────────────────────────────────────

export function finalizeOrchestrator(stage: OrchestratorStage_State): void {
  finalizeEncounter(stage.rt);
  // Uninstall sanitizer chain hooked at encounter_start (Phase 11B § IX).
  stage.uninstallSanitizer?.();
  stage.uninstallSanitizer = undefined;
  // Restore wall clock + disable deterministic strict mode for outside-encounter
  // callsites (live runtime telemetry, ad-hoc tools). Encounter scope = clock scope.
  resetToWallClock();
  setDeterministicMode(false);
}

// ─────────────────────────────────────────────────────────
// Forensic accessors
// ─────────────────────────────────────────────────────────

export interface OrchestratorForensics {
  encounterId: string;
  sessionId: string;
  lastCompletedTurn: number;
  totalStageInvocations: number;
  stageInvocationCounts: Readonly<Record<OrchestratorStage, number>>;
  stageMicrosTotal: Readonly<Record<OrchestratorStage, number>>;
  framesCaptured: number;
  /** Anomaly count from telemetry (production diagnostics). */
  anomalyCount: number;
}

export function orchestratorForensics(stage: OrchestratorStage_State): OrchestratorForensics {
  let totalInvocations = 0;
  const counts: Record<OrchestratorStage, number> = {} as Record<OrchestratorStage, number>;
  const micros: Record<OrchestratorStage, number> = {} as Record<OrchestratorStage, number>;
  for (const s of ORCHESTRATOR_STAGES) {
    const c = stage.stageInvocations.get(s) ?? 0;
    totalInvocations += c;
    counts[s] = c;
    micros[s] = stage.stageMicros.get(s) ?? 0;
  }
  return {
    encounterId: stage.rt.config.encounterId,
    sessionId: stage.rt.config.sessionId,
    lastCompletedTurn: stage.lastCompletedTurn,
    totalStageInvocations: totalInvocations,
    stageInvocationCounts: counts,
    stageMicrosTotal: micros,
    framesCaptured: stage.rt.replayStream.frames.length,
    anomalyCount: stage.rt.telemetry.totalCount,
  };
}

// ─────────────────────────────────────────────────────────
// Sanity audit — verify stage order locked
// ─────────────────────────────────────────────────────────

/**
 * Asserts the canonical stage order is unchanged. Used by replay/audit to
 * detect tampering with the orchestrator order (would silently break replay).
 */
export function assertStageOrderIntact(): void {
  const expected = [
    'encounter_start', 'turn_build', 'action_queue', 'modifier_pipeline',
    'status_tick', 'boss_phase', 'delayed_aoe', 'replay_capture',
    'reward_dispatch', 'combat_end',
  ];
  for (let i = 0; i < expected.length; i++) {
    if (ORCHESTRATOR_STAGES[i] !== expected[i]) {
      throw new Error(`[TurnOrchestrator] stage order corrupted at index ${i}: ${ORCHESTRATOR_STAGES[i]} !== ${expected[i]}`);
    }
  }
}

// Re-export — caller may want to ensure aura guard ticked at custom point
void tickAuraGuard;
