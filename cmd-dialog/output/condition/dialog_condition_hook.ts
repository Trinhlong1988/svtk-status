/**
 * DIALOG CONDITION HOOK — Contract #3 (CMD3 Phase 8 interface-first batch).
 *
 * Data-driven dialog branching per bootstrap §XI:
 *   "DO NOT hardcode dialog branching in code. USE registry/data-driven nodes."
 *   "Correct: DialogRegistry.get(dialog_id). NOT: if(npc === 'old_man')."
 *
 * Layer: Layer 2 LOGIC (pure condition evaluator).
 *
 * Hook responsibilities:
 *   - Evaluate dialog node condition expressions (parsed, data-driven)
 *   - Compose context cho condition (char state + quest state + world flag + companion affinity)
 *   - Detect dialog_complete event → emit ProgressionEvent (on_dialog_complete)
 *   - Validate dialog payload (anti-malformed dialog injection)
 *
 * Hook KHÔNG:
 *   - Mutate entity / quest state directly (emit event qua ProgressionEventBridge)
 *   - Hardcode NPC-specific logic
 *   - Mutate inventory (out of scope)
 *
 * Anti-pattern blocked:
 *   - `if (npc_id === 'npc_su_van_hanh') { ... }` — registry dispatch
 *   - `if (player.level > 10 && quest_completed) showBranch()` — condition expression in data
 *
 * ⚠ NO IMPLEMENTATION trong file này — chỉ contract interface.
 *    Implementation sau Mr.Long ack: `dialog_condition_evaluator.ts` + `dialog_registry.ts`.
 */
import { z } from 'zod';
import {
  type QuestCharId,
  type QuestId,
  type WorldStateFlagId,
} from './quest_types.js';

// ───────── Dialog ID ─────────
/**
 * Dialog id — registry key.
 *
 * Format: `dialog_<npc_short>_<context>_<branch>` snake_case unaccent.
 * Examples:
 *  - `dialog_su_van_hanh_intro_xuyen_khong`
 *  - `dialog_yet_kieu_bond_tier_3_unlock`
 */
export const DialogIdSchema = z.string().regex(/^dialog_[a-z0-9_]+$/);
export type DialogId = z.infer<typeof DialogIdSchema>;

// ───────── Dialog Node ID (within dialog tree) ─────────
export const DialogNodeIdSchema = z.string().regex(/^node_[a-z0-9_]+$/);
export type DialogNodeId = z.infer<typeof DialogNodeIdSchema>;

// ───────── Condition Expression (parsed by data-driven evaluator) ─────────
/**
 * Condition string parsed bởi evaluator. NO eval(). NO function execution.
 *
 * Supported operators (deterministic, anti-injection):
 *  - `flag(<flag_id>) == <int>` — world state flag check
 *  - `flag(<flag_id>) >= <int>`
 *  - `quest(<quest_id>) == <state>` — quest state check (state literal one of QuestState enum)
 *  - `affinity(<companion_id>) >= <int>` — companion bond points check
 *  - `affinity_tier(<companion_id>) == <tier>` — companion affinity tier check
 *  - `AND`, `OR`, `NOT`, parens
 *
 * Examples:
 *  - `flag(flag_main_chapter_1_done) == 1`
 *  - `quest(quest_main_hoa_lu_001) == completed AND affinity_tier(companion_yet_kieu_p_01) >= trusted`
 *  - `NOT flag(flag_region_dong_do_unlocked)`
 *
 * Parser ship trong impl batch — file này CHỈ contract.
 */
export const ConditionExpressionSchema = z.string().min(1);
export type ConditionExpression = z.infer<typeof ConditionExpressionSchema>;

// ───────── Dialog Branch (data shape) ─────────
/**
 * 1 branch trong dialog node.
 *
 * Pure data — evaluator scan branches in order, take first whose condition true.
 *
 *  - branch_id: stable id (for replay anchor + telemetry)
 *  - condition: ConditionExpression (optional — undefined = always true, default branch)
 *  - next_node_id: destination after branch picked
 *  - emit_event_on_complete: optional ProgressionEvent kind to emit (typical `on_dialog_complete`)
 */
export const DialogBranchSchema = z.object({
  branch_id: z.string().regex(/^br_[a-z0-9_]+$/),
  condition: ConditionExpressionSchema.optional(),
  next_node_id: DialogNodeIdSchema.optional(),
  /** Emit event after branch resolved (typical: complete). */
  emit_event_kind: z.enum([
    'on_dialog_complete',
    'on_companion_unlock',
    'on_region_enter',
  ]).optional(),
});
export type DialogBranch = z.infer<typeof DialogBranchSchema>;

// ───────── Dialog Node ─────────
/**
 * 1 node trong dialog tree.
 *
 *  - speaker_id: NPC id hoặc 'player' / 'companion'
 *  - text_vi: hiển thị Vietnamese có dấu (display layer)
 *  - branches: list branch (≥1)
 *  - terminal: true nếu node là endpoint (no next branch)
 */
export const DialogNodeSchema = z.object({
  node_id: DialogNodeIdSchema,
  speaker_id: z.string(),
  text_vi: z.string(),
  branches: z.array(DialogBranchSchema).min(1),
  terminal: z.boolean().default(false),
});
export type DialogNode = z.infer<typeof DialogNodeSchema>;

// ───────── Dialog Tree (registry data) ─────────
/**
 * Full dialog tree = entry_node + node map.
 *
 * Loaded từ `data/dialog_registry.json` (Zod validate).
 */
export const DialogTreeSchema = z.object({
  id: DialogIdSchema,
  name_vi: z.string(),
  entry_node_id: DialogNodeIdSchema,
  nodes: z.array(DialogNodeSchema).min(1),
});
export type DialogTree = z.infer<typeof DialogTreeSchema>;

// ───────── Condition Evaluation Context ─────────
/**
 * Snapshot context cho evaluator.
 *
 * Pure data — caller compose (server-authoritative snapshot).
 */
export const ConditionContextSchema = z.object({
  char_id: z.string().regex(/^(char_|companion_)[a-z0-9_]+$/),
  /** Map<flag_id, int_value> snapshot from WorldStateHook. */
  flags: z.record(z.string(), z.number().int()),
  /** Map<quest_id, state_string> snapshot. */
  quest_states: z.record(z.string(), z.string()),
  /** Map<companion_id, affinity_points>. */
  companion_affinity_points: z.record(z.string(), z.number().int().nonnegative()),
  /** Map<companion_id, tier_string>. */
  companion_affinity_tiers: z.record(z.string(), z.string()),
  /** Turn ordinal — replay anchor. */
  ordinal: z.number().int().nonnegative(),
});
export type ConditionContext = z.infer<typeof ConditionContextSchema>;

// ───────── Branch Resolve Outcome ─────────
/**
 * Outcome — which branch picked, next node, event to emit.
 *
 *  - picked_branch_id: stable id (replay anchor)
 *  - next_node_id: next node (undefined nếu branch terminal)
 *  - emit_event_kind: optional — caller forward to ProgressionEventBridge
 *  - terminal: true nếu branch ended dialog
 */
export const BranchResolveOutcomeSchema = z.object({
  dialog_id: DialogIdSchema,
  current_node_id: DialogNodeIdSchema,
  picked_branch_id: z.string(),
  next_node_id: DialogNodeIdSchema.optional(),
  emit_event_kind: z.enum([
    'on_dialog_complete',
    'on_companion_unlock',
    'on_region_enter',
  ]).optional(),
  terminal: z.boolean(),
  ordinal: z.number().int().nonnegative(),
});
export type BranchResolveOutcome = z.infer<typeof BranchResolveOutcomeSchema>;

// ───────── Dialog Registry ─────────
/**
 * Registry shape — `DialogRegistry.get(dialog_id)`.
 *
 * Per bootstrap §XI: registry-driven, NO hardcoded NPC dialog.
 */
export interface DialogRegistry {
  get(dialog_id: DialogId): DialogTree | undefined;
  listIds(): readonly DialogId[];
  has(dialog_id: DialogId): boolean;
}

// ───────── DialogConditionHook Contract ─────────
/**
 * CONTRACT — interface mà implementation `dialog_condition_evaluator.ts` PHẢI satisfy.
 *
 * Determinism guarantee:
 *  - Cùng `(node, branches, context)` → cùng outcome (first true branch picked, stable order)
 *  - Branches evaluated in declaration order (snapshot stable)
 *  - Default branch (no condition) PHẢI ở cuối list — runtime warn nếu khác
 *  - Parser pure — no eval(), no async
 *
 * Server-authoritative:
 *  - Server evaluate, NOT client
 *  - Client send "advance dialog" intent, server resolve next node
 */
export interface DialogConditionHook {
  /**
   * Resolve current node — pick first branch whose condition evaluates true.
   *
   * Steps:
   *   1. Validate node (Zod)
   *   2. For each branch in declaration order:
   *      a. Nếu condition undefined → match (default branch)
   *      b. Else evaluate condition string với context
   *      c. Nếu true → pick
   *   3. Compose BranchResolveOutcome
   *
   * @param node       DialogNode
   * @param context    ConditionContext
   * @param ordinal    Turn ordinal — replay anchor
   * @returns          BranchResolveOutcome
   *
   * @throws Error nếu no branch matched (corrupt dialog — should always have default)
   * @throws Error nếu condition expression parser fail (malformed data)
   */
  resolveBranch(
    node: DialogNode,
    context: ConditionContext,
    ordinal: number,
  ): BranchResolveOutcome;

  /**
   * Evaluate single condition expression — pure boolean.
   *
   * Helper exposed cho test + audit + admin tool.
   */
  evaluateCondition(expression: ConditionExpression, context: ConditionContext): boolean;

  /**
   * Reset (test-only).
   */
  _resetForTest(): void;

  // ─── Hardening FIX #6 hook ───
  /**
   * Attach ConditionComplexityGuard.
   *
   * Hook invokes guard.validateCondition() khi register dialog tree mới (lazy validate)
   * hoặc at boot time. Block load nếu validation status≠ok.
   *
   * Caller pass guard từ runtime — separation of concerns.
   */
  attachComplexityGuard(guard: import('./condition_complexity_guard.js').ConditionComplexityGuard): void;
}

// ───────── ★ NO IMPLEMENTATION ─────────
// Implementation: dialog_condition_evaluator.ts + dialog_registry.ts (ship sau Mr.Long ack contract).
