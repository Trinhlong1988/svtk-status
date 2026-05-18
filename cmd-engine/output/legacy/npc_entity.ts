/**
 * NPC ENTITY FACTORY — build CombatEntity from NpcTemplate (Phase 5).
 *
 * Bridges NPC system with shared combat infrastructure:
 *   - CombatChar (Module 1)
 *   - CombatEntity sub-typing (FIX PHASE 3)
 *   - skillRegistry (Phase 3)
 *
 * NPC MUST use SAME skill pipeline as player — calls resolveSkillCast()
 * via skillRegistry. NO boss-only pipeline.
 *
 * Pure factory — no state. Caller owns NpcInstance + CombatEntity.
 */
import type { CombatChar, Tier as CharTier } from './types.js';
import type { CombatEntity, EntityType, TeamId } from './combat_entity.js';
import type { NpcTemplate, NpcInstance } from './npc_types.js';
import type { SkillTemplate, SkillCastRequest } from './skill_types.js';
import { skillRegistry } from './skill_registry.js';
import { resolveSkillCast } from './skill_resolver.js';
import { resistancesForTier, isBossTier } from './npc_tier.js';
import { createCooldownState, type SkillResolveContext, type CooldownState } from './skill_types.js';
import { EventBus } from './event_bus.js';

export interface NpcEntityFactoryInput {
  template: NpcTemplate;
  instanceId: string;
  teamId: TeamId;
  formationSlot: number;
  ownerEntityId?: string;
  /** Optional override for combat char (vd buffs at spawn). */
  charOverrides?: Partial<CombatChar>;
}

/**
 * Build NpcInstance (NPC-specific metadata).
 */
export function buildNpcInstance(template: NpcTemplate, instanceId: string): NpcInstance {
  return {
    instanceId,
    npcId: template.npc_id,
    template,
    resistances: resistancesForTier(template.tier),
  };
}

/**
 * Build CombatEntity from template. Uses NpcTemplate.stats for runtime CombatChar.
 *
 * Entity type derivation:
 *   - tier ∈ {NORMAL, ELITE}     → 'NPC'
 *   - tier ∈ {MINIBOSS, BOSS}    → 'BOSS'
 *   - tier WORLD_BOSS            → 'BOSS' (mechanic_budget differentiates in handlers)
 */
export function buildNpcEntity(input: NpcEntityFactoryInput): { entity: CombatEntity; instance: NpcInstance } {
  const t = input.template;
  const instance = buildNpcInstance(t, input.instanceId);
  const char: CombatChar = {
    id: input.instanceId,
    npcId: t.npc_id,
    name_vi: t.name_vi,
    element: t.element,
    role: t.role,
    tier: mapTierToCharTier(t.tier),
    level: t.level,
    rb: t.rb ?? 'RB0',
    hp: t.stats.hp,
    maxHp: t.stats.maxHp,
    mana: t.stats.mana,
    maxMana: t.stats.maxMana,
    sat_luc: t.stats.sat_luc,
    phap_luc: t.stats.phap_luc,
    defense: t.stats.defense,
    agility: t.stats.agility,
    wisdom: t.stats.wisdom,
    crit_rate: t.stats.crit_rate,
    anti_crit: t.stats.anti_crit,
    accuracy: t.stats.accuracy,
    dodge: t.stats.dodge,
    shield: 0,
    alive: true,
    cooldowns: {},
    cc: {},
    debuffs: [],
    buffs: [],
    ...input.charOverrides,
  };

  const entityType: EntityType = deriveEntityType(t);

  const entity: CombatEntity = {
    entityType,
    teamId: input.teamId,
    formationSlot: input.formationSlot,
    ownerEntityId: input.ownerEntityId,
    companionTag: entityType === 'NPC' || entityType === 'BOSS' ? 'main' : 'companion',
    char,
  };

  return { entity, instance };
}

function deriveEntityType(t: NpcTemplate): EntityType {
  if (isBossTier(t.tier)) return 'BOSS';
  return 'NPC';
}

function mapTierToCharTier(npcTier: NpcTemplate['tier']): CharTier | undefined {
  switch (npcTier) {
    case 'NORMAL':       return 'Mob';
    case 'ELITE':        return 'Elite';
    case 'MINIBOSS':     return 'MiniBoss';
    case 'DUNGEON_BOSS': return 'Boss';
    case 'WORLD_BOSS':   return 'Myth';
  }
}

// ─────────────────────────────────────────────────────────
// NPC skill cast — uses player resolveSkillCast (Phase 3)
// ─────────────────────────────────────────────────────────

export interface NpcCastInput {
  npc: NpcInstance;
  caster: CombatEntity;
  skillId: string;
  primaryTargetId?: string;
  resolvedTargetIds?: string[];
  level?: number;
  ctx: SkillResolveContext;
}

/**
 * NPC casts skill — SAME pipeline as player.
 *
 * Validates skill is in NPC's skill_ids list (anti-injection).
 */
export function castNpcSkill(input: NpcCastInput): ReturnType<typeof resolveSkillCast> {
  if (!input.npc.template.skill_ids.includes(input.skillId)) {
    return { outcome: 'unknown_skill', reason: `NPC '${input.npc.npcId}' cannot cast '${input.skillId}'` };
  }
  const skill: SkillTemplate | undefined = skillRegistry.get(input.skillId);
  if (!skill) {
    return { outcome: 'unknown_skill', reason: `skill '${input.skillId}' not in registry` };
  }
  const request: SkillCastRequest = {
    skillId: input.skillId,
    casterId: input.caster.char.id,
    primaryTargetId: input.primaryTargetId,
    resolvedTargetIds: input.resolvedTargetIds,
    level: input.level ?? 1,
  };
  return resolveSkillCast(request, input.ctx);
}

/**
 * Initialize NPC cooldown state — install in ctx.cooldownStates Map.
 */
export function initNpcCooldownState(
  instanceId: string,
  cooldownMap: Map<string, CooldownState>,
  hasteBP: number = 10000,
): void {
  cooldownMap.set(instanceId, createCooldownState(hasteBP));
}

/** Build minimal SkillResolveContext for NPC cast. */
export function buildNpcResolveContext(opts: {
  encounterId: string;
  turn: number;
  chars: Map<string, CombatChar>;
  cooldownStates: Map<string, CooldownState>;
  bus: EventBus;
  rng: () => number;
}): SkillResolveContext {
  return {
    encounterId: opts.encounterId,
    turn: opts.turn,
    mode: 'pve',
    rng: opts.rng,
    encounter: {
      addThreat: () => { /* noop — caller wires ThreatEngine */ },
    },
    bus: opts.bus,
    chars: opts.chars,
    cooldownStates: opts.cooldownStates,
  };
}

