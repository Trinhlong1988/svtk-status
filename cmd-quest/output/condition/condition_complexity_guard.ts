/**
 * CONDITION COMPLEXITY GUARD — Hardening FIX #6 (CMD3 Phase 8 pass).
 *
 * Per CMD3-Copy-Copy.docx (HARDENING) §VIII:
 *   "Current NO eval = CORRECT. ADD ConditionComplexityGuard.
 *    Block: recursive conditions, infinite branch chain, malformed parser tree, giant nested condition spam.
 *    LIMIT: MAX_CONDITION_DEPTH."
 *
 * Layer: Layer 2 LOGIC (pure parser + validation).
 *
 * Guard responsibilities:
 *   - Parse ConditionExpression → AST (canonical tree)
 *   - Compute AST depth (deepest nested AND/OR/NOT)
 *   - Reject AST depth > MAX_CONDITION_DEPTH (default 6)
 *   - Detect recursive condition (flag(x) refers to flag set by quest depending on x — declared graph)
 *   - Detect infinite branch chain (condition graph cycle)
 *   - Validate AST shape (malformed → reject)
 *   - Block giant token count (anti-DoS)
 *
 * Guard KHÔNG:
 *   - Execute condition (DialogConditionHook.evaluateCondition responsibility)
 *   - Use eval()/Function() (R32 + R Mục III layer separation)
 *   - Mutate AST (read-only validation)
 *
 * ⚠ NO IMPLEMENTATION — contract only.
 */
import { z } from 'zod';
import type { ConditionExpression } from './dialog_condition_hook.js';

// ───────── Guard Config (data-driven) ─────────
/**
 * Default tuning (override `data/quest_constants.json`):
 *
 *  - max_condition_depth: 6 (deepest AND/OR/NOT nesting)
 *  - max_token_count: 100 (anti giant expression DoS)
 *  - max_referenced_flags: 20 (anti reference explosion)
 */
export const ConditionGuardConfigSchema = z.object({
  max_condition_depth: z.number().int().positive().default(6),
  max_token_count: z.number().int().positive().default(100),
  max_referenced_flags: z.number().int().positive().default(20),
  /** Allow operators whitelist — block anything else. */
  allowed_operators: z.array(z.string()).default([
    'flag', 'quest', 'affinity', 'affinity_tier',
    'AND', 'OR', 'NOT', '==', '>=', '<=', '>', '<',
  ]),
});
export type ConditionGuardConfig = z.infer<typeof ConditionGuardConfigSchema>;

// ───────── AST Node Kind ─────────
/**
 * AST node kinds — canonical parser output.
 *
 *  - literal: integer literal hoặc state literal (vd 1, "completed", "trusted")
 *  - identifier: flag/quest/affinity reference (vd flag(flag_x), quest(quest_y))
 *  - binary_op: == >= <= > <
 *  - logical_and / logical_or: combinator
 *  - logical_not: unary
 */
export const ASTNodeKindSchema = z.enum([
  'literal',
  'identifier',
  'binary_op',
  'logical_and',
  'logical_or',
  'logical_not',
]);
export type ASTNodeKind = z.infer<typeof ASTNodeKindSchema>;

// ───────── AST Validation Result ─────────
/**
 * Outcome khi validateCondition():
 *  - ok: AST valid, depth ≤ max
 *  - depth_exceeded: AST depth > max_condition_depth
 *  - token_count_exceeded: > max_token_count
 *  - reference_count_exceeded: > max_referenced_flags
 *  - recursive_reference: flag(x) → quest depends on x → flag(x) cycle
 *  - infinite_branch: condition graph cycle
 *  - malformed: parser error (syntax / unknown operator / mismatched paren)
 *  - operator_not_allowed: operator not in whitelist
 */
export const ConditionValidationStatusSchema = z.enum([
  'ok',
  'depth_exceeded',
  'token_count_exceeded',
  'reference_count_exceeded',
  'recursive_reference',
  'infinite_branch',
  'malformed',
  'operator_not_allowed',
]);
export type ConditionValidationStatus = z.infer<typeof ConditionValidationStatusSchema>;

export const ConditionValidationResultSchema = z.object({
  status: ConditionValidationStatusSchema,
  expression: z.string(),
  /** Measured AST depth (cho telemetry + debug). */
  measured_depth: z.number().int().nonnegative(),
  /** Measured token count. */
  measured_token_count: z.number().int().nonnegative(),
  /** Measured flag references. */
  measured_reference_count: z.number().int().nonnegative(),
  /** Path of recursive/infinite cycle (debug). */
  cycle_path: z.array(z.string()).optional(),
  reason: z.string().optional(),
});
export type ConditionValidationResult = z.infer<typeof ConditionValidationResultSchema>;

// ───────── Condition Reference Graph ─────────
/**
 * Graph nodes = flags + quests + affinities.
 * Edges: condition references → state setter.
 *
 * Built at registry boot: for each quest condition, parse expression, extract identifiers,
 * link to state setters. Cycle detect via DFS.
 */
export const ConditionReferenceGraphSchema = z.object({
  /** Map source → targets (identifiers referenced by condition). */
  edges: z.array(z.object({
    source: z.string(),
    target: z.string(),
  })),
  /** Detected cycles (sorted lex). */
  cycles: z.array(z.array(z.string())),
});
export type ConditionReferenceGraph = z.infer<typeof ConditionReferenceGraphSchema>;

// ───────── ConditionComplexityGuard Contract ─────────
/**
 * CONTRACT — interface mà implementation PHẢI satisfy.
 *
 * Determinism guarantee:
 *  - Same expression → same validation result
 *  - AST structure stable (canonical operator precedence)
 *  - Graph cycle detection deterministic (DFS order = identifier lex sort)
 */
export interface ConditionComplexityGuard {
  /**
   * Validate single condition expression.
   *
   * Steps:
   *   1. Tokenize expression
   *   2. Parse to AST (no eval, no Function())
   *   3. Walk AST: measure depth, count tokens, count references
   *   4. Validate operators in whitelist
   *   5. Check limits → return status
   */
  validateCondition(
    expression: ConditionExpression,
  ): ConditionValidationResult;

  /**
   * Build reference graph from registry.
   *
   * Called at quest registry boot. Detects cycles across all quest conditions.
   *
   * @returns Graph with detected cycles list (empty cycles = OK)
   */
  buildReferenceGraph(
    expressions: ReadonlyMap<string, ConditionExpression>,
  ): ConditionReferenceGraph;

  /**
   * Check if expression references state setter that would create cycle.
   */
  hasCycleReference(
    expression: ConditionExpression,
    graph: ConditionReferenceGraph,
  ): boolean;

  /**
   * Reset (test-only).
   */
  _resetForTest(): void;
}

// ───────── ★ NO IMPLEMENTATION ─────────
