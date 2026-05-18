/**
 * TURN ACTION — data shape player/AI action input (FIX PHASE 3 § VII).
 *
 * Player selects: skill + target slot + optional companion action.
 * Action becomes immutable after lock.
 *
 * NO direct entity targeting — slot-based per § VIII.
 */
import { z } from 'zod';
import { TargetModeSchema } from './skill_types.js';
import type { TeamId } from './combat_entity.js';

export const TeamIdSchema = z.enum(['team_a', 'team_b']);

/** Action kind — atomic player intent. */
export const TurnActionKindSchema = z.enum([
  'cast_skill',          // primary action: cast skill on slot
  'basic_attack',        // no-mana basic attack on slot
  'defend',              // skip turn, +DEF buff this turn
  'use_item',            // consumable
  'flee',                // attempt escape
  'swap_companion',      // swap reserve companion in
  'pass',                // explicit pass / AFK auto-pass
]);
export type TurnActionKind = z.infer<typeof TurnActionKindSchema>;

/** Slot reference (server resolves to entity at lock time). */
export const SlotRefSchema = z.object({
  team: TeamIdSchema,
  slot: z.number().int().nonnegative(),
});
export type SlotRef = z.infer<typeof SlotRefSchema>;

export const TurnActionSchema = z.object({
  /** Acting entity id (caster). Validated by server. */
  actorEntityId: z.string().min(1),
  /** Action kind. */
  kind: TurnActionKindSchema,
  /** Skill id (when kind = cast_skill). */
  skillId: z.string().optional(),
  /** Skill level (1..10). */
  skillLevel: z.number().int().min(1).max(10).optional(),
  /** Primary target slot. */
  primaryTarget: SlotRefSchema.optional(),
  /** AoE target slot list (server validates pre-resolved). */
  aoeTargets: z.array(SlotRefSchema).optional(),
  /** Target mode hint (server cross-check vs skill template). */
  targetMode: TargetModeSchema.optional(),
  /** Item id (when kind = use_item). */
  itemId: z.string().optional(),
  /** Companion auto-action override (when kind = cast_skill, link companion behavior). */
  companionAction: z.object({
    skillId: z.string(),
    skillLevel: z.number().int().min(1).max(10),
    primaryTarget: SlotRefSchema.optional(),
  }).optional(),
  /** Turn number action submitted at (replay correlation). */
  submittedTurn: z.number().int().nonnegative(),
});
export type TurnAction = z.infer<typeof TurnActionSchema>;

/**
 * Turn-action validation outcome.
 */
export type TurnActionOutcome =
  | 'accepted'
  | 'invalid_actor'
  | 'invalid_kind_combo'
  | 'malformed_payload'
  | 'unauthorized'
  | 'turn_mismatch';

export interface ValidateTurnActionResult {
  outcome: TurnActionOutcome;
  reason?: string;
}

/**
 * Validate basic shape + cross-field consistency. Server call BEFORE lock.
 */
export function validateTurnAction(action: TurnAction, currentTurn: number, expectedActor?: string): ValidateTurnActionResult {
  const parsed = TurnActionSchema.safeParse(action);
  if (!parsed.success) {
    return { outcome: 'malformed_payload', reason: JSON.stringify(parsed.error.issues) };
  }
  if (action.submittedTurn !== currentTurn) {
    return { outcome: 'turn_mismatch', reason: `expected turn ${currentTurn}, got ${action.submittedTurn}` };
  }
  if (expectedActor && action.actorEntityId !== expectedActor) {
    return { outcome: 'unauthorized', reason: `actor ${action.actorEntityId} != expected ${expectedActor}` };
  }
  // Cross-field consistency
  if (action.kind === 'cast_skill') {
    if (!action.skillId || !action.skillLevel) {
      return { outcome: 'invalid_kind_combo', reason: 'cast_skill requires skillId + skillLevel' };
    }
  }
  if (action.kind === 'use_item' && !action.itemId) {
    return { outcome: 'invalid_kind_combo', reason: 'use_item requires itemId' };
  }
  if (action.kind === 'swap_companion' && !action.primaryTarget) {
    // primaryTarget points to reserve slot to swap in
    return { outcome: 'invalid_kind_combo', reason: 'swap_companion requires primaryTarget (reserve slot)' };
  }
  return { outcome: 'accepted' };
}

/** Re-export for re-use. */
export { TeamIdSchema as TeamIdType };
export type { TeamId };
