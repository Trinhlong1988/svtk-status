/**
 * MODIFIER RECURSION GUARD — Contract #4 (CMD2.docx FIX #1).
 *
 * Prevent infinite recursion chain:
 *   equipment modifier → passive trigger → companion aura → equipment proc → modifier add → ...
 *
 * Without guard:
 *   - Replay desync (chain depth khác mỗi run)
 *   - CPU explode (infinite loop)
 *   - Infinite buff stack
 *   - Determinism vỡ
 *
 * Layer: Layer 2 LOGIC (pure function — guard là pure tracker, KHÔNG state global).
 *
 * R deterministic + R31 INT + R replay-safe.
 *
 * ⚠ NO IMPLEMENTATION — chỉ contract interface + constants.
 */
import { z } from 'zod';
import { type StatModifier } from './itemization_types.js';

// ───────── Constants ─────────
/**
 * MAX recursion depth — KHÔNG đổi trừ khi balance review.
 *
 * Source: CONST_MAX_MODIFIER_DEPTH trong data/itemization_constants.json (TBD).
 * Default 8 — đủ cho hầu hết combo (equipment → passive → companion → set bonus → trigger).
 */
export const CONST_MAX_MODIFIER_DEPTH = 8 as const;

/**
 * Recursion failure mode — deterministic safe abort.
 *
 * abort_silently = drop modifier, continue pipeline (safe but invisible)
 * abort_with_log = drop + telemetry log (recommended)
 * throw_error    = crash pipeline (debug-only)
 */
export const RecursionAbortModeSchema = z.enum([
  'abort_silently',
  'abort_with_log',
  'throw_error',
]);
export type RecursionAbortMode = z.infer<typeof RecursionAbortModeSchema>;

// ───────── Recursion Chain Entry (path tracking) ─────────
/**
 * 1 entry trong recursion chain — pure data, replay-safe.
 *
 * Chain example (depth 4):
 *   [equip:item_kim_a] → [passive:lifesteal_burst] → [companion:item_yet_kieu_b] → [proc:bleed_on_crit]
 */
export const RecursionChainEntrySchema = z.object({
  /** Source kind. */
  source_kind: z.enum(['equipment', 'passive', 'companion_aura', 'proc', 'set_bonus']),
  /** Source id (item_id, passive_type, set_id...). */
  source_id: z.string(),
  /** Depth at this entry (0 = root). */
  depth: z.number().int().nonnegative(),
});
export type RecursionChainEntry = z.infer<typeof RecursionChainEntrySchema>;

// ───────── Recursion Result ─────────
/**
 * Result của 1 attempt apply modifier qua guard.
 */
export const RecursionResultSchema = z.object({
  /** Apply OK hay aborted. */
  status: z.enum(['ok', 'aborted_max_depth', 'aborted_cycle']),
  /** Final depth reached. */
  final_depth: z.number().int().nonnegative(),
  /** Full chain path (for telemetry + debug). */
  chain_path: z.array(RecursionChainEntrySchema),
  /** Modifier dropped (nếu aborted). */
  dropped_modifier: z.string().optional(),
});
export type RecursionResult = z.infer<typeof RecursionResultSchema>;

// ───────── ModifierRecursionGuard Contract ─────────
/**
 * CONTRACT — Implementation `modifier_recursion_guard_impl.ts` PHẢI satisfy.
 *
 * Determinism guarantee:
 *  - Cùng input chain → cùng abort decision
 *  - Cycle detection deterministic (KHÔNG random tie-break)
 *  - Telemetry hook KHÔNG affect logic — chỉ observation
 *
 * Pure function: KHÔNG state global, mỗi resolveSkillCast() có guard instance riêng.
 */
export interface ModifierRecursionGuard {
  /**
   * Try apply modifier với recursion check.
   *
   * @param modifier         StatModifier muốn apply
   * @param current_chain    Recursion chain hiện tại (immutable input)
   * @returns                RecursionResult — caller decide proceed hay drop
   *
   * Behavior:
   *  - depth >= CONST_MAX_MODIFIER_DEPTH → status = 'aborted_max_depth', drop modifier
   *  - source_id đã có trong chain (cycle) → status = 'aborted_cycle', drop modifier
   *  - else → status = 'ok', new entry appended
   */
  tryApply(
    modifier: StatModifier,
    current_chain: readonly RecursionChainEntry[],
  ): RecursionResult;

  /**
   * Detect cycle pure function — utility cho test/audit.
   *
   * @returns true nếu source_id đã exist trong chain
   */
  hasCycle(source_id: string, chain: readonly RecursionChainEntry[]): boolean;

  /**
   * Telemetry hook — emit khi abort xảy ra.
   * Implementation gọi observability_hook.ts (CMD2.docx FIX #9).
   *
   * KHÔNG affect logic — chỉ side effect telemetry.
   */
  onAbort?(result: RecursionResult): void;

  /**
   * Configured max depth (test override).
   * Production: trả CONST_MAX_MODIFIER_DEPTH.
   */
  readonly maxDepth: number;

  /**
   * Configured abort mode.
   */
  readonly abortMode: RecursionAbortMode;
}

// ───────── Schema re-exports ─────────
export {
  RecursionChainEntrySchema as _RecursionChainEntrySchema,
  RecursionResultSchema as _RecursionResultSchema,
};
