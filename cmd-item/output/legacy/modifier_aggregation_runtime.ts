/**
 * MODIFIER AGGREGATION RUNTIME — CMD2.docx Mục VI.
 *
 * Thin runtime wrapper trên modifier_pipeline (core).
 * Public façade cho Combat Core / NPC Runtime.
 *
 * Strict 7-step order: BASE → FLAT → ADDITIVE_BP → MULTIPLICATIVE_BP → FINAL_BP → CLAMP → SOFTCAP.
 * Replay-safe + deterministic + INT-only (R31).
 *
 * KHÔNG hidden modifier stage. KHÔNG ECMAScript Array.sort dependency.
 */
import {
  type ItemStatBlock,
  type StatModifier,
} from './itemization_types.js';
import {
  type ModifierPipelineContract,
  type PipelineSnapshot,
  STEP_ORDER,
} from './modifier_pipeline_contract.js';
import { createModifierPipeline } from './modifier_pipeline.js';

export interface ModifierAggregationRuntime {
  /** Apply 7-step pipeline. Strict order locked. */
  aggregate(
    base: ItemStatBlock,
    mods: readonly StatModifier[],
    snapshot: PipelineSnapshot,
  ): ItemStatBlock;

  /** Inspect mod ordering invariant (no hidden stage). */
  validateOrdering(mods: readonly StatModifier[]): void;

  /** Pipeline step list (frozen 7 entry). */
  readonly stepOrder: typeof STEP_ORDER;
}

export function createModifierAggregationRuntime(
  pipeline?: ModifierPipelineContract,
): ModifierAggregationRuntime {
  const pl = pipeline ?? createModifierPipeline();
  return {
    aggregate(base, mods, snapshot) {
      return pl.applyPipeline(base, mods, snapshot);
    },
    validateOrdering(mods) {
      pl.validateOrderingInvariant(mods);
    },
    stepOrder: STEP_ORDER,
  };
}
