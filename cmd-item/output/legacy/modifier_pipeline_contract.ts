/**
 * MODIFIER PIPELINE CONTRACT — Contract #2 (Phase 7 batch 1, REFACTORED batch 2 per CMD2.docx FIX #2).
 *
 * Define 7-STEP ORDER + 4-tuple TIE-BREAK cho modifier application — bit-identical replay enforcement.
 *
 * Layer: Layer 2 LOGIC (pure function).
 *
 * CMD2.docx FIX #2 STABLE MODIFIER ORDERING — locked 7 step (KHÔNG đổi):
 *   1. BASE              — base stat từ char (level + class + Tinh Anh)
 *   2. FLAT              — cộng absolute INT (vd +50 HP)
 *   3. ADDITIVE_BP       — % cộng vào base (additive, vd 1500 BP + 1000 BP = 2500 BP)
 *   4. MULTIPLICATIVE_BP — % nhân chain (multiplicative, vd ×1.2 × 1.15 = ×1.38)
 *   5. FINAL_BP          — final modifier (PvP red, vulnerability, role mod ×1.0/×1.2/×1.4)
 *   6. CLAMP             — clamp INT to [lo, hi] (vd HP nonnegative)
 *   7. SOFTCAP           — applySoftCap from src/logic/soft_cap.ts (R24 + Bạo Kích cap 50%)
 *
 * Tie-break (CMD2.docx FIX #2):
 *   priority ASC → sourceType ASC → sourceId lexicographical ASC → insertionOrder ASC
 *
 * Replay MUST produce bit-identical stat output (CMD2.docx FIX #5).
 *
 * R30 BP scale + R31 NO float + R deterministic ordering + ZERO Map traversal dependency.
 *
 * ⚠ NO IMPLEMENTATION — chỉ contract interface.
 */
import { z } from 'zod';
import {
  type StatModifier,
  type ItemStatBlock,
} from './itemization_types.js';

// ───────── 7-STEP Pipeline Order (LOCKED — CMD2.docx FIX #2) ─────────
/**
 * 7 step áp dụng modifier — KHÔNG đổi thứ tự (vỡ math + vỡ replay invariant).
 *
 * KHÔNG dùng Object iteration order (Map traversal dependency = anti-determinism).
 * Resolver iterate theo array hardcoded order dưới đây.
 */
export const PipelineStepSchema = z.enum([
  'step_1_base',              // Base stat từ char (input)
  'step_2_flat',              // Flat add absolute (vd +50 HP)
  'step_3_additive_bp',       // Additive % BP (vd 1500 + 1000 = 2500 BP cộng vào)
  'step_4_multiplicative_bp', // Multiplicative % BP chain (vd ×1.2 × ×1.15)
  'step_5_final_bp',          // Final modifier (PvP, role, vulnerability)
  'step_6_clamp',              // Clamp INT to [lo, hi]
  'step_7_softcap',            // applySoftCap (R24 + Bạo Kích cap 50%)
]);
export type PipelineStep = z.infer<typeof PipelineStepSchema>;

/**
 * STEP_ORDER — readonly array, source of truth cho iteration.
 * Resolver iterate STEP_ORDER, KHÔNG iterate Object.keys() / Map.entries().
 */
export const STEP_ORDER: readonly PipelineStep[] = Object.freeze([
  'step_1_base',
  'step_2_flat',
  'step_3_additive_bp',
  'step_4_multiplicative_bp',
  'step_5_final_bp',
  'step_6_clamp',
  'step_7_softcap',
]);

// ───────── Modifier Source Type (cho tie-break) ─────────
/**
 * Source type cho tie-break alphabetical ASC.
 *
 * Order: affix < base_item < passive < set_bonus < tinh_anh
 */
export const ModifierSourceTypeSchema = z.enum([
  'affix',
  'base_item',
  'passive',
  'set_bonus',
  'tinh_anh',
]);
export type ModifierSourceType = z.infer<typeof ModifierSourceTypeSchema>;

// ───────── Stable Sort Comparator (4-tuple tie-break) ─────────
/**
 * Tie-break order (CMD2.docx FIX #2):
 *   1. priority ASC          (lower number = apply first)
 *   2. sourceType ASC        (alphabetical)
 *   3. sourceId lexicographical ASC
 *   4. insertionOrder ASC    (preserve input order khi 3 above bằng nhau)
 *
 * Resolver MUST use comparator này (KHÔNG default sort).
 */
export interface StableModifierComparator {
  /**
   * Compare 2 modifier theo 4-tuple tie-break.
   * @returns negative nếu a trước b, positive nếu sau, 0 nếu identical
   */
  compare(a: StatModifier, b: StatModifier): number;
}

// ───────── Pipeline Snapshot (input + intermediate) ─────────
/**
 * Snapshot trước khi resolve final/conditional step.
 * Read-only, KHÔNG mutate.
 */
export const PipelineSnapshotSchema = z.object({
  /** Char base stats (sau step 1 — base đã extract từ char). */
  base_after_step1: z.object({}).passthrough(),
  /** Tick / turn current cho time-based conditional. */
  tick: z.number().int().nonnegative(),
  /** Optional context tags (vd "in_combat", "low_hp", "vs_thuy"). */
  context_tags: z.array(z.string()).optional(),
});
export type PipelineSnapshot = z.infer<typeof PipelineSnapshotSchema>;

// ───────── ModifierPipelineContract ─────────
/**
 * CONTRACT — Implementation `modifier_pipeline.ts` PHẢI satisfy.
 *
 * Determinism guarantee (CMD2.docx FIX #2 + #5):
 *  - Cùng input modifiers + base_stats + snapshot → cùng output ItemStatBlock (BIT-IDENTICAL)
 *  - Modifier ordered theo STEP_ORDER → 4-tuple tie-break
 *  - KHÔNG random — conditional resolution dùng pure logic (snapshot.context_tags match)
 *  - INT only — KHÔNG float intermediate (R31, chainMul helper /10000 between MULTIPLICATIVE_BP)
 *  - 1000 repeated simulations → ZERO divergence (CMD2.docx FIX #5 invariant)
 */
export interface ModifierPipelineContract {
  /**
   * Apply modifier list lên base stats theo 7-step ordering + 4-tuple tie-break.
   *
   * @param base_stats   Char base stats (level + class + Tinh Anh trước item)
   * @param modifiers    Modifier list từ EquipmentStatProvider.collectModifiers()
   * @param snapshot     PipelineSnapshot cho conditional/final step resolve
   * @returns            Final ItemStatBlock sau pipeline (Combat Core consume)
   *
   * @throws Error nếu base_stats có float (R31 violation)
   * @throws Error nếu modifier kind không map được vào step
   */
  applyPipeline(
    base_stats: ItemStatBlock,
    modifiers: readonly StatModifier[],
    snapshot: PipelineSnapshot,
  ): ItemStatBlock;

  /**
   * Group modifier theo step — helper test/audit.
   *
   * @returns Array<[step, StatModifier[]]> — KHÔNG dùng Map (avoid traversal dependency).
   *          Each step's modifiers sorted by 4-tuple tie-break.
   */
  groupByStep(modifiers: readonly StatModifier[]): ReadonlyArray<readonly [PipelineStep, readonly StatModifier[]]>;

  /**
   * Stable comparator cho 4-tuple tie-break.
   * Implementation expose cho test/audit verification.
   */
  readonly comparator: StableModifierComparator;

  /**
   * Validate ordering invariant — sử dụng trong property test (CMD2.docx FIX #5).
   *
   * Cùng modifier list shuffled 1000 lần → cùng ordered output (commutative trong cùng step).
   *
   * @returns true nếu deterministic OK
   * @throws Error chi tiết nếu fail divergence
   */
  validateOrderingInvariant(modifiers: readonly StatModifier[]): true;
}

// ───────── Re-export helpers ─────────
export { PipelineStepSchema as _PipelineStepSchema };
