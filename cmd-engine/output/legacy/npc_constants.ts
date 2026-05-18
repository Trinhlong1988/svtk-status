/**
 * NPC CONSTANTS — Zod-validated load Phase 5.
 *
 * Source: data/npc_constants.json. INT scale (BP suffix for ratios).
 */
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const intNonNeg = z.number().int().nonnegative();
const intPositive = z.number().int().positive();

export const NpcConstantsSchema = z.object({
  TIER_NORMAL_TAUNT_RESIST_BP: intNonNeg.max(10000),
  TIER_ELITE_TAUNT_RESIST_BP: intNonNeg.max(10000),
  TIER_MINIBOSS_TAUNT_RESIST_BP: intNonNeg.max(10000),
  TIER_DUNGEON_BOSS_TAUNT_RESIST_BP: intNonNeg.max(10000),
  TIER_WORLD_BOSS_TAUNT_RESIST_BP: intNonNeg.max(10000),

  TIER_NORMAL_THREAT_RESIST_BP: intNonNeg.max(10000),
  TIER_ELITE_THREAT_RESIST_BP: intNonNeg.max(10000),
  TIER_MINIBOSS_THREAT_RESIST_BP: intNonNeg.max(10000),
  TIER_DUNGEON_BOSS_THREAT_RESIST_BP: intNonNeg.max(10000),
  TIER_WORLD_BOSS_THREAT_RESIST_BP: intNonNeg.max(10000),

  TIER_NORMAL_STATUS_RESIST_BP: intNonNeg.max(10000),
  TIER_ELITE_STATUS_RESIST_BP: intNonNeg.max(10000),
  TIER_MINIBOSS_STATUS_RESIST_BP: intNonNeg.max(10000),
  TIER_DUNGEON_BOSS_STATUS_RESIST_BP: intNonNeg.max(10000),
  TIER_WORLD_BOSS_STATUS_RESIST_BP: intNonNeg.max(10000),

  TIER_NORMAL_MECHANIC_BUDGET: intPositive,
  TIER_ELITE_MECHANIC_BUDGET: intPositive,
  TIER_MINIBOSS_MECHANIC_BUDGET: intPositive,
  TIER_DUNGEON_BOSS_MECHANIC_BUDGET: intPositive,
  TIER_WORLD_BOSS_MECHANIC_BUDGET: intPositive,

  NPC_MAX_LEVEL: intPositive,
  NPC_MAX_SKILLS_NORMAL: intPositive,
  NPC_MAX_SKILLS_ELITE: intPositive,
  NPC_MAX_SKILLS_MINIBOSS: intPositive,
  NPC_MAX_SKILLS_DUNGEON_BOSS: intPositive,
  NPC_MAX_SKILLS_WORLD_BOSS: intPositive,

  SPAWN_TICK_INTERVAL_MS: intPositive,
  SPAWN_REGION_MAX_NPC_DEFAULT: intPositive,
  SPAWN_RESPAWN_MIN_TURNS: intPositive,
  SPAWN_RESPAWN_MAX_TURNS: intPositive,
  SPAWN_WAVE_DEFAULT_SIZE: intPositive,
  SPAWN_WAVE_INTERVAL_TURNS: intPositive,
  SPAWN_BURST_CAP_PER_TICK: intPositive,

  LEASH_CHASE_DISTANCE: intPositive,
  LEASH_DISENGAGE_TURNS: intPositive,
  LEASH_RETURN_SPEED_PER_TURN: intPositive,

  COMBAT_SESSION_MAX_DURATION_TURNS: intPositive,
  COMBAT_SESSION_HEARTBEAT_TURNS: intPositive,

  COMPANION_RESERVE_MAX_SLOTS: intPositive,
  COMPANION_RECALL_COOLDOWN_TURNS: intPositive,
  COMPANION_PERSISTENCE_OUT_OF_COMBAT_TURNS: intPositive,

  SPATIAL_GRID_SIZE: intPositive,
  SPATIAL_LINE_WIDTH_DEFAULT: intPositive,
  SPATIAL_AOE_RADIUS_DEFAULT: intPositive,
  SPATIAL_PROXIMITY_NEAR_THRESHOLD: intPositive,
  SPATIAL_PROXIMITY_FAR_THRESHOLD: intPositive,

  ORPHAN_SWEEP_INTERVAL_TURNS: intPositive,
  MAX_WORLD_ENTITIES: intPositive,
});

export type NpcConstants = z.infer<typeof NpcConstantsSchema>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, '../../data');

let cached: NpcConstants | null = null;

export function loadNpcConstants(): NpcConstants {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(join(DATA_ROOT, 'npc_constants.json'), 'utf8'));
  const parsed = NpcConstantsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`[NpcConstants] schema FAIL:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
  cached = parsed.data;
  return cached;
}

export const NpcConstants: NpcConstants = loadNpcConstants();
