/**
 * TURN ORDER RESOLVER — semi-stable owner-companion pairing (FIX PHASE 3 § XVII).
 *
 * Per § II/III: Player1 → Pet1 → Player2 → Pet2 (NOT all players then all pets).
 *
 * Order rules:
 *   - Primary sort: agility DESC (high agi acts first)
 *   - Tiebreak: deterministic by entity id (lex sort)
 *   - Owner-companion paired: companion act IMMEDIATELY after owner
 *   - Stun/freeze: skip turn (still occupy ordinal slot for stable replay)
 *   - Boss modifier: optional speed boost (BP)
 *
 * Pure function — caller passes BattleField, gets ordered entityId[] for the turn.
 */
import type { BattleField, CombatEntity } from './combat_entity.js';
import { aliveEntitiesInTeam } from './battle_formation.js';

export interface TurnOrderEntry {
  entityId: string;
  agility: number;
  isCompanion: boolean;
  ownerEntityId?: string;
  /** Skip reason — entity in turn order but action skipped. */
  skipReason?: 'stunned' | 'frozen' | 'dead';
}

/**
 * Resolve turn order. Result includes BOTH teams interleaved by agility,
 * with owner-companion paired (companion act right after owner).
 */
export function resolveTurnOrder(
  field: BattleField,
  bossSpeedBP: number = 10000,    // 10000 = no change
): TurnOrderEntry[] {
  // Step 1 — collect all main characters from both teams (owner-first)
  const mainChars: CombatEntity[] = [];
  for (const team of ['team_a', 'team_b'] as const) {
    const aliveIds = aliveEntitiesInTeam(field, team);
    for (const id of aliveIds) {
      const e = field.entitiesById.get(id);
      if (!e) continue;
      // Skip companion at this stage — they're added paired with owner
      if (field.ownerOf.has(id)) continue;
      mainChars.push(e);
    }
  }

  // Step 2 — sort main chars by effective agility DESC, tiebreak by id ASC
  const withAgi = mainChars.map((e) => ({
    entity: e,
    effAgi: applyBossSpeed(e, bossSpeedBP),
  }));
  withAgi.sort((a, b) => {
    if (a.effAgi !== b.effAgi) return b.effAgi - a.effAgi;     // higher first
    return a.entity.char.id < b.entity.char.id ? -1 : a.entity.char.id > b.entity.char.id ? 1 : 0;
  });

  // Step 3 — emit interleaved order: owner → its companion → next owner → ...
  const out: TurnOrderEntry[] = [];
  for (const { entity } of withAgi) {
    out.push(buildEntry(entity, false, undefined));
    const compId = field.companionOf.get(entity.char.id);
    if (compId) {
      const comp = field.entitiesById.get(compId);
      if (comp?.char.alive) {
        out.push(buildEntry(comp, true, entity.char.id));
      }
    }
  }
  return out;
}

function applyBossSpeed(e: CombatEntity, bossSpeedBP: number): number {
  if (e.entityType !== 'BOSS') return e.char.agility;
  if (bossSpeedBP === 10000) return e.char.agility;
  return Math.floor((e.char.agility * bossSpeedBP) / 10000);
}

function buildEntry(e: CombatEntity, isCompanion: boolean, ownerEntityId: string | undefined): TurnOrderEntry {
  let skipReason: TurnOrderEntry['skipReason'];
  if (!e.char.alive) skipReason = 'dead';
  else if (e.char.cc.stunned && e.char.cc.stunned > 0) skipReason = 'stunned';
  else if (e.char.cc.frozen && e.char.cc.frozen > 0) skipReason = 'frozen';
  return {
    entityId: e.char.id,
    agility: e.char.agility,
    isCompanion,
    ownerEntityId,
    skipReason,
  };
}
