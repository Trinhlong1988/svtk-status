/**
 * NPC TIER framework — data-driven dispatch (Phase 5).
 *
 * 5 tier (NORMAL/ELITE/MINIBOSS/DUNGEON_BOSS/WORLD_BOSS).
 * Each tier maps to resistance/budget/skills cap from NpcConstants.
 *
 * NO if(tier === ...) hot-path — Record dispatch.
 */
import type { NpcTier, NpcResistanceBlock } from './npc_types.js';
import { NpcConstants } from './npc_constants.js';

/** Per-tier resistance block — pure lookup. */
export function resistancesForTier(tier: NpcTier): NpcResistanceBlock {
  return TIER_RESISTANCE[tier];
}

/** Static lookup table. Generated from NpcConstants at module load. */
const TIER_RESISTANCE: Record<NpcTier, NpcResistanceBlock> = {
  NORMAL: {
    tauntResistBP: NpcConstants.TIER_NORMAL_TAUNT_RESIST_BP,
    threatResistBP: NpcConstants.TIER_NORMAL_THREAT_RESIST_BP,
    statusResistBP: NpcConstants.TIER_NORMAL_STATUS_RESIST_BP,
    mechanicBudget: NpcConstants.TIER_NORMAL_MECHANIC_BUDGET,
    maxSkills: NpcConstants.NPC_MAX_SKILLS_NORMAL,
  },
  ELITE: {
    tauntResistBP: NpcConstants.TIER_ELITE_TAUNT_RESIST_BP,
    threatResistBP: NpcConstants.TIER_ELITE_THREAT_RESIST_BP,
    statusResistBP: NpcConstants.TIER_ELITE_STATUS_RESIST_BP,
    mechanicBudget: NpcConstants.TIER_ELITE_MECHANIC_BUDGET,
    maxSkills: NpcConstants.NPC_MAX_SKILLS_ELITE,
  },
  MINIBOSS: {
    tauntResistBP: NpcConstants.TIER_MINIBOSS_TAUNT_RESIST_BP,
    threatResistBP: NpcConstants.TIER_MINIBOSS_THREAT_RESIST_BP,
    statusResistBP: NpcConstants.TIER_MINIBOSS_STATUS_RESIST_BP,
    mechanicBudget: NpcConstants.TIER_MINIBOSS_MECHANIC_BUDGET,
    maxSkills: NpcConstants.NPC_MAX_SKILLS_MINIBOSS,
  },
  DUNGEON_BOSS: {
    tauntResistBP: NpcConstants.TIER_DUNGEON_BOSS_TAUNT_RESIST_BP,
    threatResistBP: NpcConstants.TIER_DUNGEON_BOSS_THREAT_RESIST_BP,
    statusResistBP: NpcConstants.TIER_DUNGEON_BOSS_STATUS_RESIST_BP,
    mechanicBudget: NpcConstants.TIER_DUNGEON_BOSS_MECHANIC_BUDGET,
    maxSkills: NpcConstants.NPC_MAX_SKILLS_DUNGEON_BOSS,
  },
  WORLD_BOSS: {
    tauntResistBP: NpcConstants.TIER_WORLD_BOSS_TAUNT_RESIST_BP,
    threatResistBP: NpcConstants.TIER_WORLD_BOSS_THREAT_RESIST_BP,
    statusResistBP: NpcConstants.TIER_WORLD_BOSS_STATUS_RESIST_BP,
    mechanicBudget: NpcConstants.TIER_WORLD_BOSS_MECHANIC_BUDGET,
    maxSkills: NpcConstants.NPC_MAX_SKILLS_WORLD_BOSS,
  },
};

/** Boss/Elite check helpers. */
export function isBossTier(tier: NpcTier): boolean {
  return tier === 'MINIBOSS' || tier === 'DUNGEON_BOSS' || tier === 'WORLD_BOSS';
}

export function isEliteTier(tier: NpcTier): boolean {
  return tier === 'ELITE';
}

/** Tier rank — higher = stronger. */
export function tierRank(tier: NpcTier): number {
  return TIER_RANK[tier];
}

const TIER_RANK: Record<NpcTier, number> = {
  NORMAL: 0,
  ELITE: 1,
  MINIBOSS: 2,
  DUNGEON_BOSS: 3,
  WORLD_BOSS: 4,
};
