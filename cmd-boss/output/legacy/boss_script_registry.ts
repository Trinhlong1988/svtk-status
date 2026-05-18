/**
 * BOSS SCRIPT REGISTRY — pluggable boss content (Phase 6).
 *
 * STRICT: NO `if(bossId === ...)` chains anywhere in the codebase.
 * All boss behavior lives in BossScript records loaded into this registry.
 *
 * BossScript shape:
 *   - bossId  (FK to NpcTemplate.npc_id)
 *   - phases  (BossPhase[] for boss_phase_machine)
 *   - rotation  (skill sequence cycled by mechanic_scheduler)
 *   - mechanics (named mechanics scheduled per turn / phase / hp threshold)
 *   - behaviorWeights (70/20/10 policy — highest_threat / scripted_mechanic / random)
 *
 * Caller loads scripts at server boot from `data/boss_scripts/*.json` (out of scope here).
 * Replay: scripts are content — version-locked per encounter via `scriptVersion`.
 */
import { z } from 'zod';
import { BossPhaseSchema, type BossPhase } from './boss_phase_machine.js';

// ─────────────────────────────────────────────────────────
// Mechanic definition (data — used by mechanic_scheduler)
// ─────────────────────────────────────────────────────────

export const MechanicTriggerKindSchema = z.enum([
  'turn_interval',     // every N turn
  'turn_one_shot',     // on specific turn after phase enter
  'hp_threshold_bp',   // fires on first crossing hp_bp
  'phase_enter',       // fires once on phase enter
  'rng_chance_bp',     // probabilistic each tick (rng_ai substream)
]);
export type MechanicTriggerKind = z.infer<typeof MechanicTriggerKindSchema>;

export const MechanicDefSchema = z.object({
  mechanicId: z.string().min(1).max(64),
  /** Display name for telemetry. */
  name: z.string().min(1).max(128).optional(),
  /** Effect kind — implementation lives in mechanic_runtime registry. */
  kind: z.enum([
    'spatial_aoe',       // delayed AoE telegraph (spatial_combat_expansion)
    'spatial_line',
    'spatial_cone',
    'forced_movement',   // knockback / pull
    'wipe_check',        // mechanic that wipes if condition unmet
    'aggro_reset',       // wipe threat table
    'summon',            // spawn add (via WorldSpawnRegistry)
    'cinematic_lock',    // pause combat for cinematic
    'enrage_buff',       // boss damage buff
    'custom',            // caller-provided via plug-in
  ]),
  trigger: z.object({
    kind: MechanicTriggerKindSchema,
    /** Threshold value (interpretation per kind). */
    value: z.number().int().nonnegative(),
  }),
  /** Telegraph turns before resolve (0 = instant). */
  telegraphTurns: z.number().int().nonnegative().default(0),
  /** Effect payload — opaque, consumed by mechanic_runtime plug-in. */
  payload: z.record(z.unknown()).optional(),
});
export type MechanicDef = z.infer<typeof MechanicDefSchema>;

// ─────────────────────────────────────────────────────────
// Behavior weights (70/20/10 policy)
// ─────────────────────────────────────────────────────────

export const BehaviorWeightsSchema = z.object({
  /** BP — typically 7000 (70%). */
  highestThreatBP: z.number().int().nonnegative().max(10000),
  /** BP — typically 2000 (20%). */
  scriptedMechanicBP: z.number().int().nonnegative().max(10000),
  /** BP — typically 1000 (10%). */
  randomEligibleBP: z.number().int().nonnegative().max(10000),
}).refine(
  (w) => w.highestThreatBP + w.scriptedMechanicBP + w.randomEligibleBP === 10000,
  { message: 'behavior weights must sum to 10000 BP' },
);
export type BehaviorWeights = z.infer<typeof BehaviorWeightsSchema>;

export const DEFAULT_BEHAVIOR_WEIGHTS: BehaviorWeights = {
  highestThreatBP: 7000,
  scriptedMechanicBP: 2000,
  randomEligibleBP: 1000,
};

// ─────────────────────────────────────────────────────────
// BossScript (data — JSON-loadable)
// ─────────────────────────────────────────────────────────

export const BossScriptSchema = z.object({
  bossId: z.string().min(1).max(128),
  scriptVersion: z.number().int().positive(),
  /** Display name for telemetry. */
  name: z.string().min(1).max(128).optional(),
  phases: z.array(BossPhaseSchema).min(1).max(10),
  /** Mechanic catalog — phase references by mechanicId. */
  mechanics: z.array(MechanicDefSchema).default([]),
  /** Behavior weights for AI dispatcher (70/20/10). */
  behaviorWeights: BehaviorWeightsSchema.default(DEFAULT_BEHAVIOR_WEIGHTS),
  /** Hard enrage at this turn count (forces last phase + enrage_buff). */
  hardEnrageTurns: z.number().int().positive().optional(),
});
export type BossScript = z.infer<typeof BossScriptSchema>;

// ─────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────

export class BossScriptRegistry {
  private byBoss = new Map<string, BossScript>();
  private byMechanic = new Map<string, MechanicDef>();

  register(script: BossScript): void {
    const parsed = BossScriptSchema.safeParse(script);
    if (!parsed.success) {
      throw new Error(`[BossScriptRegistry] schema FAIL '${script.bossId}': ${parsed.error.message}`);
    }
    const s = parsed.data;
    if (this.byBoss.has(s.bossId)) {
      throw new Error(`[BossScriptRegistry] dup bossId '${s.bossId}'`);
    }
    this.byBoss.set(s.bossId, s);
    for (const m of s.mechanics) {
      const fqId = `${s.bossId}::${m.mechanicId}`;
      this.byMechanic.set(fqId, m);
    }
  }

  get(bossId: string): BossScript | undefined { return this.byBoss.get(bossId); }
  has(bossId: string): boolean { return this.byBoss.has(bossId); }
  size(): number { return this.byBoss.size; }

  /** Fetch mechanic by fully-qualified id (bossId::mechanicId). */
  getMechanic(bossId: string, mechanicId: string): MechanicDef | undefined {
    return this.byMechanic.get(`${bossId}::${mechanicId}`);
  }

  /** All bossIds — sorted (deterministic). */
  list(): readonly string[] {
    return [...this.byBoss.keys()].sort();
  }

  _reset(): void {
    this.byBoss.clear();
    this.byMechanic.clear();
  }
}

/** Module-level singleton (caller may inject own instance for isolation). */
export const bossScriptRegistry = new BossScriptRegistry();

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

/**
 * Resolve the BossPhase currently active for a boss state.
 * Used by mechanic_scheduler + boss_ai_runtime.
 */
export function activePhaseOf(script: BossScript, phaseId: string): BossPhase | undefined {
  return script.phases.find((p) => p.phaseId === phaseId);
}
