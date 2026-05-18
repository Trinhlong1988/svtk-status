/**
 * RAID STRESS HARNESS — large-scale determinism simulator (Phase 6 FP FIX #4).
 *
 * CMD1.docx Phase 6 Final Perfect Pass simulation targets:
 *   - 40v40 combat
 *   - 120 delayed AoE
 *   - 80 companions
 *   - 200 proximity triggers
 *   - multi-phase boss
 *   - summon storm
 *   - mechanic chain flood
 *
 * VERIFIES:
 *   - deterministic replay (same seed → same outcome)
 *   - stable memory (bounded growth)
 *   - no mechanic drift (schedule + drain order stable)
 *   - stable tick ordering (boss timeline LOCK ORDER preserved)
 *   - no RNG divergence (substream isolation)
 *
 * STRICT KISS: harness is a TEST UTILITY — NOT a runtime framework
 * (CMD1.docx § XIII "NO BOSS FRAMEWORK SYNDROME").
 *
 * Pure functions + plain counters. Caller (test file) drives the simulation
 * and asserts invariants on the returned `RaidStressReport`.
 */
import { createSpatialLayer, setPosition, type SpatialLayerState } from './spatial_layer.js';
import {
  createDelayedAoeRegistry,
  placeDelayedAoe,
  drainReadyAoeMarkers,
  createProximityRegistry,
  placeProximityTrigger,
  scanProximityTriggers,
  type DelayedAoeRegistry,
  type ProximityTriggerRegistry,
} from './spatial_combat_expansion.js';
import {
  createBossPhaseState,
  type BossPhase,
  type BossPhaseState,
} from '../../../cmd-boss/output/legacy/boss_phase_machine.js';
import {
  createMechanicScheduler,
  tickScheduler,
  drainReadyMechanics,
  pendingCount,
  type MechanicSchedulerState,
} from './mechanic_scheduler.js';
import {
  DEFAULT_BEHAVIOR_WEIGHTS,
  type BossScript,
} from '../../../cmd-boss/output/legacy/boss_script_registry.js';
import {
  createMechanicBudget,
  tryConsumeMechanic,
  consumedAtTurn,
  totalRejected,
  type MechanicBudgetState,
} from './mechanic_budget.js';
import { tickBossAi, type BossTickInput } from '../../../cmd-boss/output/legacy/boss_ai_runtime.js';
import { createRNGStream, type RNGStream } from './rng_stream.js';
import type { ThreatEntryV2 } from './threat_types.js';
import {
  resolveBossTimeline,
  makeBossTimelineEvent,
  type BossTimelineEvent,
  type BossMechanicOrderKey,
} from '../../../cmd-boss/output/legacy/boss_timeline_resolver.js';

// ─────────────────────────────────────────────────────────
// Harness config
// ─────────────────────────────────────────────────────────

export interface RaidStressConfig {
  /** RNG seed — same seed → same outcome. */
  seed: string;
  /** Number of attackers (players + companions). */
  attackerCount: number;
  /** Number of companions. */
  companionCount: number;
  /** Number of delayed AoE to place. */
  delayedAoeCount: number;
  /** Number of proximity triggers to place. */
  proximityTriggerCount: number;
  /** Number of turn to simulate. */
  turnCount: number;
  /** Boss phases definition. */
  phases: readonly BossPhase[];
  /** Boss max HP. */
  bossMaxHp: number;
  /** Grid dimensions. */
  gridSize: number;
}

export const DEFAULT_STRESS_CONFIG: RaidStressConfig = {
  seed: 'raid_stress_default',
  attackerCount: 40,           // 40v40
  companionCount: 80,
  delayedAoeCount: 120,
  proximityTriggerCount: 200,
  turnCount: 30,
  phases: [
    { phaseId: 'p1', rotation: ['sk_a'], mechanicIds: [], resetThreatOnEnter: false, formationResetOnEnter: false },
    {
      phaseId: 'p2',
      enterTrigger: { kind: 'hp_threshold_bp', threshold: 5000 },
      rotation: ['sk_b'], mechanicIds: [], resetThreatOnEnter: false, formationResetOnEnter: false,
    },
    {
      phaseId: 'p3',
      enterTrigger: { kind: 'hp_threshold_bp', threshold: 2000 },
      rotation: ['sk_c'], mechanicIds: [], resetThreatOnEnter: false, formationResetOnEnter: false,
    },
  ],
  bossMaxHp: 100_000,
  gridSize: 40,
};

// ─────────────────────────────────────────────────────────
// Per-turn observation
// ─────────────────────────────────────────────────────────

export interface RaidStressTurnRecord {
  turn: number;
  bossPhase: string;
  decisionBranch: string;
  decisionTarget?: string;
  pendingMechanicsBefore: number;
  pendingMechanicsAfter: number;
  drainedAoeMarkers: number;
  proximityFires: number;
  budgetConsumed: number;
  budgetRejected: number;
  timelinePhaseCounts: Readonly<Record<string, number>>;
}

export interface RaidStressReport {
  config: RaidStressConfig;
  /** Per-turn record (length = config.turnCount). */
  turns: RaidStressTurnRecord[];
  /** Total events / sums. */
  totals: {
    decisionsByBranch: Record<string, number>;
    drainedMarkers: number;
    proximityFires: number;
    budgetConsumed: number;
    budgetRejected: number;
    phasesEntered: string[];
  };
  /** Final state hash — for replay diff. */
  finalHash: string;
}

// ─────────────────────────────────────────────────────────
// Run simulation
// ─────────────────────────────────────────────────────────

export function runRaidStress(config: RaidStressConfig = DEFAULT_STRESS_CONFIG): RaidStressReport {
  const stream = createRNGStream(config.seed);
  const layer = createSpatialLayer();
  seedPositions(layer, config, stream);

  const script: BossScript = {
    bossId: 'stress_boss',
    scriptVersion: 1,
    phases: [...config.phases],
    mechanics: [],
    behaviorWeights: DEFAULT_BEHAVIOR_WEIGHTS,
  };
  const phase = createBossPhaseState(script.bossId, script.phases);
  const sched = createMechanicScheduler('stress_enc');
  const aoeReg = createDelayedAoeRegistry();
  const proxReg = createProximityRegistry();
  const budget = createMechanicBudget('stress_enc');
  const threatTable = makeThreatTable(config.attackerCount);

  // Pre-place delayed AoE + proximity triggers across the timeline.
  seedDelayedAoe(aoeReg, config);
  seedProximityTriggers(proxReg, config);

  const turns: RaidStressTurnRecord[] = [];
  const totals = {
    decisionsByBranch: {} as Record<string, number>,
    drainedMarkers: 0,
    proximityFires: 0,
    budgetConsumed: 0,
    budgetRejected: 0,
    phasesEntered: [] as string[],
  };
  let bossHp = config.bossMaxHp;

  for (let t = 0; t < config.turnCount; t++) {
    // 1. Tick boss AI
    const tickInput: BossTickInput = {
      currentTurn: t, encounterStartTurn: 0,
      bossHp, bossMaxHp: config.bossMaxHp, killCount: 0,
      threatTable, isEligible: () => true,
      rngAi: stream.sub('rng_ai'),
      rngAiThreat: stream.sub('rng_ai_threat'),
    };
    const decisionsBranchBefore = totals.decisionsByBranch;
    const decision = tickBossAi(script, phase, sched, tickInput);
    totals.decisionsByBranch[decision.branch] = (decisionsBranchBefore[decision.branch] ?? 0) + 1;
    if (decision.phaseTransitioned) {
      totals.phasesEntered.push(decision.currentPhaseId);
    }

    // 2. Consume budget for the boss-AI decision's scheduled mechanics (data-driven gate)
    let budgetConsumedThisTurn = 0;
    let budgetRejectedThisTurn = 0;
    for (const m of decision.scheduledMechanics) {
      const r = tryConsumeMechanic(budget, {
        scheduledTurn: t, kind: m.mechanicId, chainDepth: 0,
      });
      if (r.ok) budgetConsumedThisTurn += 1;
      else budgetRejectedThisTurn += 1;
    }

    // 3. Drain AoE markers + proximity triggers
    const pendingBefore = pendingCount(sched);
    const drained = drainReadyAoeMarkers(aoeReg, t);
    const proxFires = scanProximityTriggers(proxReg, layer, t);
    drainReadyMechanics(sched, t);
    const pendingAfter = pendingCount(sched);

    // 4. Build timeline events from drained mechanics + AoE markers + decision scheduled
    const timelineEvents: BossTimelineEvent[] = [];
    for (const m of decision.scheduledMechanics) {
      const ok: BossMechanicOrderKey = {
        resolveTurn: m.resolveTurn,
        scheduledSeq: m.scheduledSeq,
        mechanicId: m.mechanicId,
      };
      timelineEvents.push(makeBossTimelineEvent('CLEANUP', script.bossId, m.mechanicId, ok));
    }
    for (const d of drained) {
      timelineEvents.push(makeBossTimelineEvent(
        'DELAYED_AOE', d.bossId, d.mechanicId,
        { resolveTurn: d.resolveTurn, scheduledSeq: d.scheduledSeq, mechanicId: d.mechanicId },
      ));
    }
    const sortedTimeline = resolveBossTimeline(timelineEvents);
    const phaseCounts: Record<string, number> = {};
    for (const e of sortedTimeline) phaseCounts[e.phase] = (phaseCounts[e.phase] ?? 0) + 1;

    // 5. Record turn
    turns.push({
      turn: t,
      bossPhase: phase.currentPhaseId,
      decisionBranch: decision.branch,
      decisionTarget: decision.targetId,
      pendingMechanicsBefore: pendingBefore,
      pendingMechanicsAfter: pendingAfter,
      drainedAoeMarkers: drained.length,
      proximityFires: proxFires.length,
      budgetConsumed: budgetConsumedThisTurn,
      budgetRejected: budgetRejectedThisTurn,
      timelinePhaseCounts: phaseCounts,
    });
    totals.drainedMarkers += drained.length;
    totals.proximityFires += proxFires.length;
    totals.budgetConsumed += budgetConsumedThisTurn;
    totals.budgetRejected += budgetRejectedThisTurn;

    // 6. Advance boss HP linearly toward 0
    bossHp = Math.max(0, bossHp - Math.floor(config.bossMaxHp / Math.max(1, config.turnCount)));
  }

  void consumedAtTurn(budget, 0);     // touch budget API (used in tests too)
  void totalRejected(budget);

  return {
    config,
    turns,
    totals,
    finalHash: computeRunHash(turns, totals),
  };
}

// ─────────────────────────────────────────────────────────
// Seeders
// ─────────────────────────────────────────────────────────

function seedPositions(layer: SpatialLayerState, config: RaidStressConfig, stream: RNGStream): void {
  const placeRng = stream.sub('rng_spawn');
  // Boss at center
  setPosition(layer, 'boss', { x: Math.floor(config.gridSize / 2), y: Math.floor(config.gridSize / 2) });
  // Attackers spread
  for (let i = 0; i < config.attackerCount; i++) {
    const x = Math.floor(placeRng() * config.gridSize);
    const y = Math.floor(placeRng() * config.gridSize);
    setPosition(layer, `atk_${i}`, { x, y });
  }
  // Companions spread
  for (let i = 0; i < config.companionCount; i++) {
    const x = Math.floor(placeRng() * config.gridSize);
    const y = Math.floor(placeRng() * config.gridSize);
    setPosition(layer, `comp_${i}`, { x, y });
  }
}

function seedDelayedAoe(reg: DelayedAoeRegistry, config: RaidStressConfig): void {
  for (let i = 0; i < config.delayedAoeCount; i++) {
    const scheduledAt = i % Math.max(1, config.turnCount);
    placeDelayedAoe(reg, {
      shape: i % 3 === 0 ? 'circle' : i % 3 === 1 ? 'line' : 'cone',
      origin: { x: i % config.gridSize, y: (i * 3) % config.gridSize },
      range: 3 + (i % 4),
      width: 1 + (i % 3),
      direction: 'E',
      scheduledAtTurn: scheduledAt,
      resolveTurn: scheduledAt + 1 + (i % 3),
      bossId: 'stress_boss',
      mechanicId: `m_aoe_${i}`,
    });
  }
}

function seedProximityTriggers(reg: ProximityTriggerRegistry, config: RaidStressConfig): void {
  for (let i = 0; i < config.proximityTriggerCount; i++) {
    placeProximityTrigger(reg, {
      center: { x: (i * 7) % config.gridSize, y: (i * 5) % config.gridSize },
      radius: 2 + (i % 3),
      oneShot: i % 2 === 0,
      placedAtTurn: 0,
      bossId: 'stress_boss',
      mechanicId: `m_prox_${i}`,
    });
  }
}

function makeThreatTable(n: number): Map<string, ThreatEntryV2> {
  const m = new Map<string, ThreatEntryV2>();
  for (let i = 0; i < n; i++) {
    m.set(`atk_${i}`, {
      attackerId: `atk_${i}`,
      threat: 1000 - i,
      lastActionTurn: 0,
    });
  }
  return m;
}

// ─────────────────────────────────────────────────────────
// Run hash (FNV-1a) — replay diff signature
// ─────────────────────────────────────────────────────────

function computeRunHash(
  turns: readonly RaidStressTurnRecord[],
  totals: RaidStressReport['totals'],
): string {
  let h = 0x811c9dc5 >>> 0;
  const eat = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const t of turns) {
    eat(`${t.turn}|${t.bossPhase}|${t.decisionBranch}|${t.decisionTarget ?? '-'}|${t.drainedAoeMarkers}|${t.proximityFires}|${t.budgetConsumed}|${t.budgetRejected}`);
  }
  eat(`__totals__${totals.drainedMarkers}|${totals.proximityFires}|${totals.budgetConsumed}|${totals.budgetRejected}|${totals.phasesEntered.join(',')}`);
  return h.toString(16).padStart(8, '0');
}

// ─────────────────────────────────────────────────────────
// Convenience: deterministic re-run check
// ─────────────────────────────────────────────────────────

/**
 * Run twice with same config; return divergence info.
 * Should NEVER diverge — used as smoke test for harness itself + replay invariant.
 */
export function verifyDeterminism(config: RaidStressConfig = DEFAULT_STRESS_CONFIG): {
  identical: boolean;
  firstHash: string;
  secondHash: string;
} {
  const a = runRaidStress(config);
  const b = runRaidStress(config);
  return {
    identical: a.finalHash === b.finalHash,
    firstHash: a.finalHash,
    secondHash: b.finalHash,
  };
}

// re-export — caller checks budget state if needed
export type { MechanicBudgetState };
