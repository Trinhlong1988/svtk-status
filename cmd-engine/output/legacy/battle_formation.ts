/**
 * BATTLE FORMATION — slot-based targeting (FIX PHASE 3 § VIII).
 *
 * Targeting MUST use FORMATION SLOT, NOT raw entity id.
 * Server resolves slot → entity. Critical for:
 *   - replay stability (slot is positional, survives entity churn)
 *   - tactical readability (player thinks "front line slot 0" not entity uuid)
 *   - formation gameplay (tank front, healer back)
 *
 * 5v5 layout (10 slot per team):
 *
 *   Team A (slot 0-9):
 *     Front line: slot 0, 1, 2 (3 main char tank/dps)
 *     Mid line:   slot 3, 4, 5 (companion of front)
 *     Back line:  slot 6, 7 (mage/healer)
 *     Back companion: slot 8, 9
 *
 *   Team B mirror.
 */
import type { BattleField, CombatEntity, TeamId } from './combat_entity.js';
import { entityAtSlot } from './combat_entity.js';
import { SkillConstants } from './skill_constants.js';

export interface FormationTargetSpec {
  /** Slot to target (0..MAX_FORMATION_SLOTS_PER_TEAM-1). */
  slot: number;
  /** Team to target. */
  team: TeamId;
}

export interface FormationResolveResult {
  entityId?: string;
  error?: 'slot_out_of_range' | 'slot_empty' | 'slot_dead';
}

/**
 * Resolve formation slot → entity id, server-authoritative.
 * Returns error if slot empty / dead / out of range.
 */
export function resolveFormationTarget(
  field: BattleField,
  spec: FormationTargetSpec,
  allowDead: boolean = false,
): FormationResolveResult {
  if (spec.slot < 0 || spec.slot >= SkillConstants.MAX_FORMATION_SLOTS_PER_TEAM) {
    return { error: 'slot_out_of_range' };
  }
  const entityId = entityAtSlot(field, spec.team, spec.slot);
  if (!entityId) return { error: 'slot_empty' };
  if (!allowDead) {
    const e = field.entitiesById.get(entityId);
    if (!e?.char.alive) return { error: 'slot_dead' };
  }
  return { entityId };
}

/** Get all alive entity ids in team, sorted by slot ascending. */
export function aliveEntitiesInTeam(field: BattleField, team: TeamId): string[] {
  const out: { slot: number; id: string }[] = [];
  const slots = field.bySlot.get(team);
  if (!slots) return [];
  for (const [slot, id] of slots) {
    const e = field.entitiesById.get(id);
    if (e?.char.alive) out.push({ slot, id });
  }
  out.sort((a, b) => a.slot - b.slot);
  return out.map((x) => x.id);
}

/** Companion of a main character (or undefined). */
export function companionOf(field: BattleField, mainEntityId: string): CombatEntity | undefined {
  const compId = field.companionOf.get(mainEntityId);
  if (!compId) return undefined;
  return field.entitiesById.get(compId);
}

/** Owner of a companion (or undefined). */
export function ownerOf(field: BattleField, companionEntityId: string): CombatEntity | undefined {
  const ownerId = field.ownerOf.get(companionEntityId);
  if (!ownerId) return undefined;
  return field.entitiesById.get(ownerId);
}

/**
 * Owner-companion pair iteration order — CRITICAL TS DNA.
 * Player1 → Pet1 → Player2 → Pet2 (NOT all players then all pets).
 *
 * Returns ordered entity id list interleaved owner+companion.
 */
export function pairedTurnOrder(field: BattleField, team: TeamId): string[] {
  const out: string[] = [];
  const slots = field.bySlot.get(team);
  if (!slots) return [];
  // First half slots = main, second half = companion (convention).
  // Iterate main slot ascending, append owner then companion.
  const half = Math.floor(SkillConstants.MAX_FORMATION_SLOTS_PER_TEAM / 2);
  for (let s = 0; s < half; s++) {
    const id = slots.get(s);
    if (!id) continue;
    const e = field.entitiesById.get(id);
    if (!e?.char.alive) continue;
    out.push(id);
    const compId = field.companionOf.get(id);
    if (compId) {
      const comp = field.entitiesById.get(compId);
      if (comp?.char.alive) out.push(compId);
    }
  }
  return out;
}
