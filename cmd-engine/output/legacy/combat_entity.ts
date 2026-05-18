/**
 * COMBAT ENTITY — sub-typing per FIX PHASE 3 § X.
 *
 * SVTK combat DNA: 1 PLAYER = 1 Main + 1 Companion entity.
 * 5v5 → 10 entity max per team.
 *
 * Sub-types: PLAYER, COMPANION, PET, SUMMON, NPC, BOSS.
 * All implement CombatChar interface (existing) PLUS owner_link + formation_slot tags.
 *
 * Pure types — extend CombatChar via composition (NOT replace).
 */
import { z } from 'zod';
import type { CombatChar } from './types.js';

export const EntityTypeSchema = z.enum([
  'PLAYER',
  'COMPANION',
  'PET',
  'SUMMON',
  'NPC',
  'BOSS',
]);
export type EntityType = z.infer<typeof EntityTypeSchema>;

/** Team identifier (replay-safe). */
export type TeamId = 'team_a' | 'team_b';

/**
 * CombatEntity — extends CombatChar with battle-time tags.
 *
 * Owner link: COMPANION/PET/SUMMON has `ownerEntityId` pointing to PLAYER/NPC/BOSS owner.
 * Formation slot: 0..9 in 5v5 (slot 0 = team A pos 0, slot 5 = team B pos 0, etc.).
 */
export interface CombatEntity {
  entityType: EntityType;
  teamId: TeamId;
  formationSlot: number;          // 0-based, MAX_FORMATION_SLOTS_PER_TEAM-1
  ownerEntityId?: string;         // for COMPANION / PET / SUMMON
  /** Tag: 'companion' | 'main' — used by ai/skill targeting filter. */
  companionTag?: 'main' | 'companion';
  /** Underlying combat char (stats / hp / cc / cooldowns). */
  char: CombatChar;
}

/** Helper — quick check. */
export function isCompanion(e: CombatEntity): boolean {
  return e.entityType === 'COMPANION' || e.entityType === 'PET' || e.entityType === 'SUMMON';
}

export function isMainCharacter(e: CombatEntity): boolean {
  return e.entityType === 'PLAYER' || e.entityType === 'NPC' || e.entityType === 'BOSS';
}

/**
 * BattleField — owner of all entities + formation grid.
 * Caller (encounter manager) constructs at battle start.
 */
export interface BattleField {
  entitiesById: Map<string, CombatEntity>;
  /** Slot lookup: teamId × formationSlot → entityId. Stable across turn. */
  bySlot: Map<TeamId, Map<number, string>>;
  /** Owner→companion lookup (for owner_and_companion targeting). */
  companionOf: Map<string, string>;        // ownerEntityId → companionEntityId
  ownerOf: Map<string, string>;            // companionEntityId → ownerEntityId
}

export function createBattleField(): BattleField {
  return {
    entitiesById: new Map(),
    bySlot: new Map([['team_a', new Map()], ['team_b', new Map()]]),
    companionOf: new Map(),
    ownerOf: new Map(),
  };
}

/**
 * Register entity — caller mutates BattleField. Throws on slot conflict.
 */
export function registerEntity(field: BattleField, entity: CombatEntity): void {
  if (field.entitiesById.has(entity.char.id)) {
    throw new Error(`[BattleField] duplicate entity id '${entity.char.id}'`);
  }
  const teamSlots = field.bySlot.get(entity.teamId);
  if (!teamSlots) {
    throw new Error(`[BattleField] unknown teamId '${entity.teamId}'`);
  }
  if (teamSlots.has(entity.formationSlot)) {
    throw new Error(`[BattleField] slot ${entity.formationSlot} on ${entity.teamId} already taken`);
  }
  field.entitiesById.set(entity.char.id, entity);
  teamSlots.set(entity.formationSlot, entity.char.id);
  if (entity.ownerEntityId) {
    field.companionOf.set(entity.ownerEntityId, entity.char.id);
    field.ownerOf.set(entity.char.id, entity.ownerEntityId);
  }
}

/** Resolve slot → entityId. Server-authoritative target resolution. */
export function entityAtSlot(field: BattleField, team: TeamId, slot: number): string | undefined {
  return field.bySlot.get(team)?.get(slot);
}

/** Same team check (replaces ad-hoc isAlly when CombatEntity available). */
export function entitiesSameTeam(a: CombatEntity, b: CombatEntity): boolean {
  return a.teamId === b.teamId;
}
