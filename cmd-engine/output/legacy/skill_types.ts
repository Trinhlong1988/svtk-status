/**
 * SKILL TYPES — runtime types Phase 3 Skill Engine.
 *
 * Distinguish:
 *   - SkillTemplate (data shape — JSON-defined, registry-loaded)
 *   - SkillCastRequest (player/AI intent at cast time)
 *   - StatusApplyRequest (skill emit, status engine consume — see skillBridge.ts)
 *
 * Pure types, NO state, NO I/O.
 * Replay-safe: all fields JSON-serializable INT (R31).
 */
import { z } from 'zod';
import {
  ElementSchema,
  EffectTypeSchema,
  DamageTypeSchema,
  SkillTypeSchema,
  ManaCategorySchema,
  type CombatChar,
  type CombatContext,
  type Element,
} from './types.js';
import {
  StatusCategorySchema,
  DRGroupSchema,
  StackBehaviorSchema,
  type StatusCategory,
} from './status_types.js';
import type { EventBus } from './event_bus.js';

// ─────────────────────────────────────────────────────────
// Target mode (9 — per Phase 3 spec § VI)
// ─────────────────────────────────────────────────────────

export const TargetModeSchema = z.enum([
  'self',
  'ally',
  'enemy',
  'ally_team',
  'enemy_team',
  'aoe_circle',
  'aoe_line',
  'summon_target',
  'dead_ally',
  // FIX PHASE 3 § IX — companion-aware targeting modes
  'companion',                 // caster's companion (PET/SUMMON)
  'owner',                     // caster's owner (when caster IS companion)
  'owner_and_companion',       // pair (owner + companion as 2 target)
  'reserve_companion',         // reserve slot companion (for swap)
]);
export type TargetMode = z.infer<typeof TargetModeSchema>;

// ─────────────────────────────────────────────────────────
// Skill category (mirror SkillType but allow more granular)
// ─────────────────────────────────────────────────────────

export const SkillCategorySchema = z.enum([
  'damage',
  'heal',
  'cc',
  'buff',
  'debuff',
  'shield',
  'utility',
  'summon',
  'revive',
  // FIX PHASE 3 § XIV — companion-aware skill categories
  'taunt',                  // threat magnet (Module 4 ThreatService consumes)
  'owner_link',             // owner+companion shared effect
  'companion_only',         // companion can cast, main cannot
  'swap_trigger',           // triggers companion swap on cast
  'dual_cast',              // owner + companion both cast
  'companion_passive',      // passive trigger from companion presence
]);
export type SkillCategory = z.infer<typeof SkillCategorySchema>;

// ─────────────────────────────────────────────────────────
// Combo tag — tag-based combo trigger (NO hardcode skillId)
// ─────────────────────────────────────────────────────────

export const ComboTagSchema = z.string().min(1).max(64);
export type ComboTag = z.infer<typeof ComboTagSchema>;

// ─────────────────────────────────────────────────────────
// AI tag — boss/NPC AI hint
// ─────────────────────────────────────────────────────────

export const AITagSchema = z.string().min(1).max(64);
export type AITag = z.infer<typeof AITagSchema>;

// ─────────────────────────────────────────────────────────
// Status request — skill embed status apply intent (NOT direct apply)
// ─────────────────────────────────────────────────────────

export const SkillStatusRequestSchema = z.object({
  effectType: EffectTypeSchema,
  category: StatusCategorySchema,
  drGroup: DRGroupSchema,
  stackBehavior: StackBehaviorSchema,
  /** Per-level magnitude BP × 10000 (or INT for damage/heal-type) */
  amount_by_level: z.array(z.number().int()).min(1),
  /** Per-level duration (turn) */
  duration_by_level: z.array(z.number().int().nonnegative()).min(1),
  /** Tick interval (turn). Optional — default 1. */
  tickInterval: z.number().int().positive().optional(),
  /** Initial stacks. Optional — default 1. */
  initialStacks: z.number().int().positive().optional(),
});
export type SkillStatusRequest = z.infer<typeof SkillStatusRequestSchema>;

// ─────────────────────────────────────────────────────────
// Skill template (data shape — JSON registry)
// ─────────────────────────────────────────────────────────

export const SkillTemplateSchema = z.object({
  id: z.string().min(1).max(128),
  category: SkillCategorySchema,
  type: SkillTypeSchema,
  damage_type: DamageTypeSchema.optional(),
  element: ElementSchema,
  mana_category: ManaCategorySchema.optional(),

  /** Targeting */
  target_mode: TargetModeSchema,
  /** Max target hit when AoE/team. */
  max_targets: z.number().int().positive().optional(),
  /** Range (cell / unit). 0 = melee/self. */
  range: z.number().int().nonnegative().optional(),

  /** Mana */
  mana_cost_by_level: z.array(z.number().int().nonnegative()).min(1),

  /** Cooldown */
  cooldown_by_level: z.array(z.number().int().nonnegative()).min(1),
  /** Optional cooldown group (vd "ult", "dash") — caster cannot cast 2 skill same group concurrently. */
  cooldown_group: z.string().optional(),

  /** Cast time milliseconds (0 = instant). */
  cast_time_ms: z.number().int().nonnegative().optional(),

  /** Damage/heal formula reference + scaling */
  base_damage_by_level: z.array(z.number().int().nonnegative()).optional(),
  base_heal_by_level: z.array(z.number().int().nonnegative()).optional(),
  scaling_bp_by_level: z.array(z.number().int().nonnegative()).optional(),
  heal_scaling_bp_by_level: z.array(z.number().int().nonnegative()).optional(),
  accuracy_mod_bp_by_level: z.array(z.number().int()).optional(),
  penetration_bp_by_level: z.array(z.number().int().nonnegative()).optional(),

  /** Status effect requests (skill request, status engine apply) */
  status_requests: z.array(SkillStatusRequestSchema).optional(),

  /** Combo tags — input tag (skill triggers when X tag present) + output tag (cast emits). */
  combo_input_tags: z.array(ComboTagSchema).optional(),
  combo_output_tags: z.array(ComboTagSchema).optional(),

  /** Caster requirement — weapon, role, level. */
  requires_role: z.array(z.string()).optional(),
  requires_weapon: z.array(z.string()).optional(),
  requires_min_level: z.number().int().positive().optional(),

  /** AI tags — boss/NPC AI selector hint. */
  ai_tags: z.array(AITagSchema).optional(),
});
export type SkillTemplate = z.infer<typeof SkillTemplateSchema>;

// ─────────────────────────────────────────────────────────
// Skill cast request — player/AI intent
// ─────────────────────────────────────────────────────────

export interface SkillCastRequest {
  skillId: string;
  casterId: string;
  /** Primary target (vd single-target, summon source). */
  primaryTargetId?: string;
  /** Pre-resolved target list for AoE — caller-provided (server-authoritative). */
  resolvedTargetIds?: string[];
  /** Skill level (1..10). */
  level: number;
  /** Combo trigger context — present in chain combo. */
  comboContext?: ComboTriggerContext;
}

export interface ComboTriggerContext {
  /** Input tag triggered combo. */
  triggerTag: ComboTag;
  /** Source skill that emitted tag. */
  sourceSkillId: string;
  /** Combo depth from root cast. */
  depth: number;
}

// ─────────────────────────────────────────────────────────
// Skill resolve outcome
// ─────────────────────────────────────────────────────────

export type SkillResolveOutcome =
  | 'resolved'
  | 'validation_failed'
  | 'on_cooldown'
  | 'no_mana'
  | 'invalid_target'
  | 'cc_blocked'
  | 'unknown_skill'
  | 'combo_aborted';

export interface SkillResolveResult {
  outcome: SkillResolveOutcome;
  reason?: string;
  damage_per_target?: Map<string, number>;
  heal_per_target?: Map<string, number>;
  status_requests?: ResolvedStatusRequest[];
  combo_triggered_tags?: ComboTag[];
}

/**
 * Status request after Skill→Status bridge resolution. Status engine consume.
 */
export interface ResolvedStatusRequest {
  targetId: string;
  effectType: import('./types.js').EffectType;
  category: StatusCategory;
  drGroup: import('./status_types.js').DRGroup;
  stackBehavior: import('./status_types.js').StackBehavior;
  amount: number;
  duration: number;
  tickInterval: number;
  initialStacks: number;
  sourceId: string;
  sourceSkillId: string;
}

// ─────────────────────────────────────────────────────────
// Skill resolve context
// ─────────────────────────────────────────────────────────

export interface SkillResolveContext extends CombatContext {
  bus: EventBus;
  /** Char lookup by id — caller-owned. */
  chars: Map<string, CombatChar>;
  /** Cooldown map per caster. */
  cooldownStates: Map<string, CooldownState>;
  /** Pre-existing element (for combo trigger detection). */
  arenaElement?: Element;
  /** Combo recursion tracker (if undefined, combo limited to depth 0 — no chain). */
  comboDepth?: number;
}

// ─────────────────────────────────────────────────────────
// Cooldown state — owned per caster
// ─────────────────────────────────────────────────────────

export interface CooldownState {
  /** Remaining cooldown per skillId. */
  perSkill: Map<string, number>;
  /** Remaining cooldown per group (cooldown_group). */
  perGroup: Map<string, number>;
  /** Global cooldown remaining (after any cast). */
  global: number;
  /** Haste BP (10000 = no change, 12000 = +20% faster, 8000 = +25% slower). */
  hasteBP: number;
}

export function createCooldownState(hasteBP: number = 10000): CooldownState {
  return {
    perSkill: new Map(),
    perGroup: new Map(),
    global: 0,
    hasteBP,
  };
}
