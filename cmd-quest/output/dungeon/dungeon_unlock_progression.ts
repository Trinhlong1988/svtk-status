/**
 * DUNGEON UNLOCK PROGRESSION — Phase 10 §XI.
 *
 * Dungeon chain + boss unlock + tactical gate + companion req + faction req.
 * Composes Phase 8/9 primitives — NO new mutation, only check logic.
 */
import { z } from 'zod';
import type { CompanionAffinityTier, QuestCharId, WorldStateFlagId } from './quest_types.js';
import type { WorldStateHook } from './world_state_hook.js';
import type { CompanionProgressionHook } from './companion_progression_hook.js';
import type { FactionProgressionRuntime, FactionId, FactionTier } from './faction_progression_runtime.js';

export const DungeonIdSchema = z.string().regex(/^dungeon_[a-z0-9_]+$/);
export type DungeonId = z.infer<typeof DungeonIdSchema>;

export const DungeonGateSchema = z.object({
  /** Prerequisite dungeon (chain progression). */
  prereq_dungeon_id: DungeonIdSchema.optional(),
  /** Required boss flag (boss already defeated). */
  required_boss_flag: z.string().regex(/^flag_/).optional(),
  /** Required companion affinity tier. */
  required_companion_id: z.string().regex(/^companion_/).optional(),
  required_companion_tier: z.enum(['stranger', 'familiar', 'trusted', 'bonded', 'soulbound']).optional(),
  /** Required faction tier. */
  required_faction_id: z.string().regex(/^faction_/).optional(),
  required_faction_tier: z.enum(['hostile', 'unfriendly', 'neutral', 'friendly', 'honored', 'exalted']).optional(),
  /** Required tactical level (char level). */
  required_char_level: z.number().int().nonnegative().optional(),
});
export type DungeonGate = z.infer<typeof DungeonGateSchema>;

export const DungeonDefinitionSchema = z.object({
  id: DungeonIdSchema,
  name_vi: z.string(),
  region_id: z.string().regex(/^region_/),
  /** Unlock flag — set khi dungeon mở. */
  unlock_flag_id: z.string().regex(/^flag_dungeon_/),
  /** Gates required to unlock. */
  gates: z.array(DungeonGateSchema).default([]),
});
export type DungeonDefinition = z.infer<typeof DungeonDefinitionSchema>;

const TIER_INDEX: Record<CompanionAffinityTier, number> = {
  stranger: 0, familiar: 1, trusted: 2, bonded: 3, soulbound: 4,
};
const FACTION_INDEX: Record<FactionTier, number> = {
  hostile: 0, unfriendly: 1, neutral: 2, friendly: 3, honored: 4, exalted: 5,
};

export interface DungeonGateCheckResult {
  dungeon_id: DungeonId;
  char_id: QuestCharId;
  unlocked: boolean;
  failed_gates: readonly string[];
}

export class DungeonUnlockProgression {
  private defs = new Map<DungeonId, DungeonDefinition>();

  constructor(
    private readonly worldState: WorldStateHook,
    private readonly companion: CompanionProgressionHook,
    private readonly faction: FactionProgressionRuntime,
  ) {}

  register(def: DungeonDefinition): void {
    if (this.defs.has(def.id)) throw new Error(`Dungeon ${def.id} already registered`);
    this.defs.set(def.id, def);
  }

  checkGates(
    dungeon_id: DungeonId,
    char_id: QuestCharId,
    char_level: number,
  ): DungeonGateCheckResult {
    const def = this.defs.get(dungeon_id);
    if (!def) {
      return { dungeon_id, char_id, unlocked: false, failed_gates: ['dungeon_not_registered'] };
    }
    const failed: string[] = [];
    for (const g of def.gates) {
      if (g.prereq_dungeon_id) {
        const prereq = this.defs.get(g.prereq_dungeon_id);
        if (!prereq) {
          failed.push(`prereq_dungeon_unknown:${g.prereq_dungeon_id}`);
          continue;
        }
        if (this.worldState.getFlag(prereq.unlock_flag_id as WorldStateFlagId, char_id) < 1) {
          failed.push(`prereq_dungeon:${g.prereq_dungeon_id}`);
        }
      }
      if (g.required_boss_flag) {
        if (this.worldState.getFlag(g.required_boss_flag as WorldStateFlagId, char_id) < 1) {
          failed.push(`boss_flag:${g.required_boss_flag}`);
        }
      }
      if (g.required_companion_id && g.required_companion_tier) {
        const aff = this.companion.getAffinity(char_id, g.required_companion_id as QuestCharId);
        if (TIER_INDEX[aff.tier] < TIER_INDEX[g.required_companion_tier]) {
          failed.push(`companion_tier:${g.required_companion_id}<${g.required_companion_tier}`);
        }
      }
      if (g.required_faction_id && g.required_faction_tier) {
        const fTier = this.faction.getTier(g.required_faction_id as FactionId, char_id);
        if (FACTION_INDEX[fTier] < FACTION_INDEX[g.required_faction_tier]) {
          failed.push(`faction_tier:${g.required_faction_id}<${g.required_faction_tier}`);
        }
      }
      if (g.required_char_level !== undefined && char_level < g.required_char_level) {
        failed.push(`char_level<${g.required_char_level}`);
      }
    }
    return {
      dungeon_id,
      char_id,
      unlocked: failed.length === 0,
      failed_gates: failed,
    };
  }

  listChainedDungeons(): readonly DungeonId[] {
    return [...this.defs.keys()].sort();
  }

  getDefinition(dungeon_id: DungeonId): DungeonDefinition | undefined {
    return this.defs.get(dungeon_id);
  }

  _resetForTest(): void {
    this.defs.clear();
  }
}
