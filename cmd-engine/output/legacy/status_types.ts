/**
 * STATUS EFFECT — runtime types (Module 2 Phase 2).
 *
 * Distinguish from `SkillEffect` (data shape trong skill JSON):
 *   - SkillEffect = template data (type, amount[], duration_by_level[], stack_limit, tick_interval)
 *   - StatusEffect = runtime instance applied to target (id, source, applied turn, current stack)
 *
 * Pure types, NO state, NO I/O.
 * Replay-safe: all fields JSON-serializable INT (R31).
 */
import { z } from 'zod';
import { EffectTypeSchema, type EffectType } from './types.js';

// ─────────────────────────────────────────────────────────
// Status category — broad classification per Phase 2 spec
// ─────────────────────────────────────────────────────────

export const StatusCategorySchema = z.enum([
  'DOT',             // burn / poison / bleed
  'HOT',             // regen / aura
  'HARD_CC',         // freeze / stun / petrify
  'SOFT_CC',         // slow / silence / blind
  'DEFENSIVE',       // shield / guard / reflect
  'THREAT_CONTROL',  // taunt / aggro amp
  'SUPPORT',         // cleanse / anti_heal / buff / debuff
]);
export type StatusCategory = z.infer<typeof StatusCategorySchema>;

// ─────────────────────────────────────────────────────────
// DR group — diminishing return scope key
// ─────────────────────────────────────────────────────────

export const DRGroupSchema = z.enum([
  'hard_cc',     // freeze / stun / petrify share DR
  'soft_cc',     // slow / silence / blind share DR
  'dot',         // burn / poison / bleed (rarely DR'd)
  'hot',
  'none',        // no DR
]);
export type DRGroup = z.infer<typeof DRGroupSchema>;

// ─────────────────────────────────────────────────────────
// Stack behavior — 5 type per Phase 2 spec
// ─────────────────────────────────────────────────────────

export const StackBehaviorSchema = z.enum([
  'additive',      // burn stacks damage (sum amounts)
  'refresh',       // freeze refreshes duration
  'strongest',     // shield replaces if incoming larger
  'capped',        // additive but cap at stack_limit
  'unique',        // first wins, ignore subsequent (until expire)
]);
export type StackBehavior = z.infer<typeof StackBehaviorSchema>;

// ─────────────────────────────────────────────────────────
// Status effect runtime instance
// ─────────────────────────────────────────────────────────

export const StatusEffectSchema = z.object({
  /** Unique instance ID (encounter-scoped, deterministic). */
  effectId: z.string(),
  /** Effect type (from EffectTypeSchema 28 type). */
  type: EffectTypeSchema,
  /** Category for cleanse + DR scoping. */
  category: StatusCategorySchema,
  /** Caster who applied. */
  sourceId: z.string(),
  /** Target receiving effect. */
  targetId: z.string(),
  /** Turn applied (immutable). */
  turnApplied: z.number().int().nonnegative(),
  /** Remaining duration (turns). Decremented per tick. */
  remainingTurns: z.number().int().nonnegative(),
  /** Current stack count (for additive/capped). */
  stacks: z.number().int().nonnegative(),
  /** Magnitude per stack (BP for shield/threat amp, INT for damage/heal). */
  amount: z.number().int(),
  /** Tick interval — every N turn DOT/HOT fire. */
  tickInterval: z.number().int().positive(),
  /** Last tick turn (for tick scheduling). */
  lastTickTurn: z.number().int().nonnegative(),
  /** DR group (for diminishing return tracking). */
  drGroup: DRGroupSchema,
  /** Stack behavior. */
  stackBehavior: StackBehaviorSchema,
});
export type StatusEffect = z.infer<typeof StatusEffectSchema>;

/**
 * Protected fields — pre_resolve mutation guard. Match CLAUDE.md mục 14.8.5 (R33).
 * These fields define effect identity — KHÔNG cho phép mutate after apply.
 */
export const PROTECTED_STATUS_FIELDS: readonly string[] = [
  'effectId',
  'sourceId',
  'targetId',
  'turnApplied',
  'category',
];

/**
 * Whitelist — fields cho phép mutate runtime (vd buff stack, refresh duration).
 */
export const ALLOWED_STATUS_MUTATION_FIELDS: readonly string[] = [
  'remainingTurns',
  'stacks',
  'amount',
  'lastTickTurn',
];

// ─────────────────────────────────────────────────────────
// Effect handler interface — plug-in pattern (FRAMEWORK FIRST, no hardcode per type)
// ─────────────────────────────────────────────────────────

import type { CombatChar, CombatContext } from './types.js';

export type EffectHandlerContext = CombatContext;

export interface EffectHandler {
  /** Effect type this handler handles. */
  readonly type: EffectType;
  readonly category: StatusCategory;
  readonly drGroup: DRGroup;
  readonly stackBehavior: StackBehavior;

  /**
   * Apply effect side-effect (vd shield → target.shield += amount).
   * Pure direct mutation per R33 — no async, no abstraction.
   */
  onApply?(target: CombatChar, instance: StatusEffect, ctx: EffectHandlerContext): void;

  /**
   * Tick fire (DOT damage / HOT heal / cooldown decrement).
   * Called from `tickEffect()` when (currentTurn - lastTickTurn) % tickInterval === 0.
   */
  onTick?(target: CombatChar, instance: StatusEffect, ctx: EffectHandlerContext): void;

  /**
   * Remove side-effect (vd shield → target.shield -= remainingShield).
   * Called when expired / cleansed / overwritten.
   */
  onRemove?(target: CombatChar, instance: StatusEffect, ctx: EffectHandlerContext): void;
}

// ─────────────────────────────────────────────────────────
// Apply pipeline result
// ─────────────────────────────────────────────────────────

export type ApplyOutcome =
  | 'applied'
  | 'immune'
  | 'resisted'
  | 'dr_blocked'
  | 'stack_capped'
  | 'overwritten'
  | 'refreshed'
  | 'duplicate_unique';

export interface ApplyResult {
  outcome: ApplyOutcome;
  effect?: StatusEffect;     // The applied/refreshed instance
  removed?: StatusEffect[];  // Effects removed by overwrite
}

// ─────────────────────────────────────────────────────────
// DR tracker per target per group
// ─────────────────────────────────────────────────────────

export interface DRTrackerEntry {
  group: DRGroup;
  /** Number of times group triggered within reset window. */
  level: number;
  /** Turn last triggered (for reset detection). */
  lastTriggerTurn: number;
}

// ─────────────────────────────────────────────────────────
// Cleanse filter — selective/category/all
// ─────────────────────────────────────────────────────────

export const CleanseFilterSchema = z.object({
  /** Categories to cleanse (empty = all). */
  categories: z.array(StatusCategorySchema).optional(),
  /** Specific effect types to cleanse. */
  types: z.array(EffectTypeSchema).optional(),
  /** Max effects removed (0 / omitted = all). */
  maxCount: z.number().int().nonnegative().optional(),
  /** If target has immunity tag matching, cleanse skipped. Default false. */
  bypassImmunity: z.boolean().optional(),
  /**
   * FIX #4 — optional priority order for category-aware smart cleanse.
   * If provided, candidates sorted by index trong array (smaller index = removed first).
   * Effects KHÔNG nằm trong list xếp cuối, ổn định theo array index gốc.
   *
   * Default: deterministic array index order (NO behavior change).
   */
  priorityOrder: z.array(StatusCategorySchema).optional(),
});
export type CleanseFilter = z.infer<typeof CleanseFilterSchema>;
