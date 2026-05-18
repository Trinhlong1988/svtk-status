/**
 * NPC TYPES — runtime + template types Phase 5.
 *
 * NpcTemplate (data JSON) → NpcInstance (combat-time CombatEntity).
 *
 * Composite profile system per § NPC DATA-DRIVEN RULE:
 *   { tier, level, faction, stats, skills, ai_tags, formation_profile,
 *     spatial_profile, encounter_profile, aggro_profile, playback_profile,
 *     companion_rules, spawn_profile }
 *
 * Pure types, NO state, NO I/O. Replay-safe INT.
 */
import { z } from 'zod';
import { ElementSchema, RoleSchema, RbSchema } from './types.js';

// ─────────────────────────────────────────────────────────
// NPC tier (5 tier per spec)
// ─────────────────────────────────────────────────────────

export const NpcTierSchema = z.enum([
  'NORMAL',
  'ELITE',
  'MINIBOSS',
  'DUNGEON_BOSS',
  'WORLD_BOSS',
]);
export type NpcTier = z.infer<typeof NpcTierSchema>;

// ─────────────────────────────────────────────────────────
// Faction (§ XXII)
// ─────────────────────────────────────────────────────────

export const FactionRelationSchema = z.enum([
  'hostile',
  'neutral',
  'ally',
  'summon_owner',
  'companion_owner',
]);
export type FactionRelation = z.infer<typeof FactionRelationSchema>;

export const FactionTagSchema = z.string().min(1).max(64);

// ─────────────────────────────────────────────────────────
// Stats — INT base block
// ─────────────────────────────────────────────────────────

export const NpcStatsSchema = z.object({
  hp: z.number().int().positive(),
  maxHp: z.number().int().positive(),
  mana: z.number().int().nonnegative(),
  maxMana: z.number().int().nonnegative(),
  sat_luc: z.number().int().nonnegative(),
  phap_luc: z.number().int().nonnegative(),
  defense: z.number().int().nonnegative(),
  agility: z.number().int().nonnegative(),
  wisdom: z.number().int().nonnegative(),
  crit_rate: z.number().int().nonnegative().max(10000),
  anti_crit: z.number().int().nonnegative().max(10000),
  accuracy: z.number().int().nonnegative().max(20000),
  dodge: z.number().int().nonnegative().max(10000),
});
export type NpcStats = z.infer<typeof NpcStatsSchema>;

// ─────────────────────────────────────────────────────────
// Profile composites
// ─────────────────────────────────────────────────────────

export const NpcFormationProfileSchema = z.object({
  preferredSlot: z.number().int().nonnegative().optional(),
  preferredRow: z.enum(['front', 'mid', 'back']).optional(),
  /** Hold position — does not move to flexible slot. */
  fixedSlot: z.boolean().optional(),
});

export const NpcSpatialProfileSchema = z.object({
  /** Preferred engagement distance (cell). */
  preferredDistance: z.number().int().nonnegative().optional(),
  /** Movement speed cell/turn. */
  movementSpeed: z.number().int().nonnegative().optional(),
  /** Allowed to break formation to chase? */
  canBreakFormation: z.boolean().optional(),
});

export const NpcEncounterProfileSchema = z.object({
  /** Trigger encounter on aggro range entered. */
  aggroRange: z.number().int().nonnegative().optional(),
  /** Leash distance override (default LEASH_CHASE_DISTANCE). */
  leashOverride: z.number().int().nonnegative().optional(),
  /** Combat group id — siblings share encounter session. */
  combatGroupId: z.string().optional(),
});

export const NpcAggroProfileSchema = z.object({
  /** Initial threat multiplier (vd boss has +500% threat to tanks). */
  baseThreatMultBP: z.number().int().nonnegative().optional(),
  /** Healer-punish bias (boss target healer with extra weight). */
  healerPunishBias: z.boolean().optional(),
  /** Companion-punish bias. */
  companionPunishBias: z.boolean().optional(),
});

export const NpcPlaybackProfileSchema = z.object({
  /** Animation tier (intensity for boss windup). */
  animationTier: z.enum(['low', 'medium', 'high', 'epic']).optional(),
  /** Voice line bank id. */
  voiceBank: z.string().optional(),
  /** Cast time scale BP (boss may have slower telegraph). */
  castTimeScaleBP: z.number().int().positive().optional(),
});

export const NpcCompanionRulesSchema = z.object({
  /** Can be tamed/captured as companion. */
  tamable: z.boolean().optional(),
  /** Inherited skill ids when captured. */
  inheritSkillIds: z.array(z.string()).optional(),
});

export const NpcSpawnProfileSchema = z.object({
  /** Default region this NPC spawns in. */
  regionId: z.string().optional(),
  /** Spawn weight (higher = more frequent). */
  weight: z.number().int().nonnegative().optional(),
  /** Min/max level scale. */
  levelMin: z.number().int().positive().optional(),
  levelMax: z.number().int().positive().optional(),
});

// ─────────────────────────────────────────────────────────
// NpcTemplate (data — JSON-defined, registry-loaded)
// ─────────────────────────────────────────────────────────

export const NpcTemplateSchema = z.object({
  npc_id: z.string().min(1).max(128),
  name_vi: z.string().min(1).max(128),
  tier: NpcTierSchema,
  level: z.number().int().positive(),
  element: ElementSchema,
  role: RoleSchema,
  rb: RbSchema.optional(),
  faction: FactionTagSchema,
  faction_relations: z.array(z.object({
    target: FactionTagSchema,
    relation: FactionRelationSchema,
  })).optional(),

  stats: NpcStatsSchema,
  skill_ids: z.array(z.string()).min(0).max(20),
  ai_tags: z.array(z.string()).optional(),

  formation_profile: NpcFormationProfileSchema.optional(),
  spatial_profile: NpcSpatialProfileSchema.optional(),
  encounter_profile: NpcEncounterProfileSchema.optional(),
  aggro_profile: NpcAggroProfileSchema.optional(),
  playback_profile: NpcPlaybackProfileSchema.optional(),
  companion_rules: NpcCompanionRulesSchema.optional(),
  spawn_profile: NpcSpawnProfileSchema.optional(),
});
export type NpcTemplate = z.infer<typeof NpcTemplateSchema>;

// ─────────────────────────────────────────────────────────
// NpcInstance — runtime
// ─────────────────────────────────────────────────────────

export interface NpcInstance {
  /** Unique instance id (encounter-scoped). */
  instanceId: string;
  /** Template id reference. */
  npcId: string;
  /** Template (denormalized for fast lookup). */
  template: NpcTemplate;
  /** Effective tier modifiers (computed from template.tier × NpcConstants). */
  resistances: NpcResistanceBlock;
}

export interface NpcResistanceBlock {
  tauntResistBP: number;
  threatResistBP: number;
  statusResistBP: number;
  mechanicBudget: number;
  maxSkills: number;
}
