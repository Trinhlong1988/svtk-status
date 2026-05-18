/**
 * ITEMIZATION MODULE — public exports.
 *
 * Combat Core import từ đây ONLY (KHÔNG deep-import internals).
 *
 * Phase 7 Batch 3 implementation entry point.
 */

// Types
export * from './itemization_types.js';

// Item registry
export {
  ItemSchema,
  loadItemsRegistry,
  getItem,
  getRegistryVersioning,
  type Item,
  _resetItemRegistry,
} from './item_registry.js';

// Contracts (interface-first)
export type { EquipmentStatProvider, CharId, EquippedItemMap } from './equipment_stat_provider.js';
export type { ModifierPipelineContract, PipelineStep, PipelineSnapshot, ModifierSourceType, StableModifierComparator } from './modifier_pipeline_contract.js';
export { STEP_ORDER, PipelineStepSchema, ModifierSourceTypeSchema, PipelineSnapshotSchema } from './modifier_pipeline_contract.js';
export type { CompanionEquipmentHook, CompanionId, OwnerCompanionLink } from './companion_equipment_hook.js';
export { CompanionIdSchema, OwnerCompanionLinkSchema } from './companion_equipment_hook.js';
export type { ModifierRecursionGuard, RecursionAbortMode, RecursionChainEntry, RecursionResult } from './modifier_recursion_guard.js';
export { CONST_MAX_MODIFIER_DEPTH, RecursionAbortModeSchema } from './modifier_recursion_guard.js';
export type { StatBudgetRuntime, RarityBudget, SlotCap, BudgetValidationResult } from './stat_budget_runtime.js';
export type { ItemizationObservabilityHook, ItemizationEvent, ItemizationEventType } from './itemization_observability.js';
export {
  ItemizationEventTypeSchema,
  PERF_BUDGET_AGGREGATION_US,
  PERF_BUDGET_MAX_MODIFIER_COUNT,
  PERF_BUDGET_MAX_TELEMETRY_PER_TICK,
} from './itemization_observability.js';
export type { ReplayAggregationInvariant, DivergenceReport, InvariantResult } from './replay_aggregation_invariant.js';
export { CONST_REPLAY_INVARIANT_RUNS } from './replay_aggregation_invariant.js';

// Implementations (factories — caller composes runtime)
export { createEquipmentStatProvider } from './equipment_aggregate.js';
export { createModifierPipeline } from './modifier_pipeline.js';
export { createCompanionEquipmentHook } from './companion_equipment.js';
export { createRecursionGuard, _resetRecursionGuardCache } from './modifier_recursion_guard_impl.js';
export { createStatBudgetRuntime, _resetStatBudgetCache } from './stat_budget_runtime_impl.js';
export { createObservabilityHook, _resetObservabilityCache } from './itemization_observability_impl.js';

// Helpers
export { getAffixPoolForSlot, rollAffixes, createAffixRng, _resetAffixPoolCache } from './affix_pool.js';
export { resolvePassives } from './passive_resolver.js';
export {
  resolveSetBonuses,
  _resetSetsCache,
  type SetDef,
  type SetBonusConflictPolicy,
  SetBonusConflictPolicySchema,
} from './set_bonus.js';
export { _resetBondConfigCache } from './companion_equipment.js';

// Observability symbols (new severity tier)
export {
  TelemetrySeveritySchema,
  type TelemetrySeverity,
  DEFAULT_SEVERITY_BY_TYPE,
} from './itemization_observability.js';

// Type exports for new fields
export {
  ModifierSourceTypeEnumSchema,
  type ModifierSourceTypeEnum,
} from './itemization_types.js';

// ───────── 8 Runtime wrappers (CMD2.docx Mục V) ─────────
// Public façade for Combat Core / NPC Runtime / Loot System / Network sync.
export {
  createModifierAggregationRuntime,
  type ModifierAggregationRuntime,
} from './modifier_aggregation_runtime.js';
export {
  createEquipmentRuntime,
  type EquipmentRuntime,
} from './equipment_runtime.js';
export {
  createPassiveRuntime,
  type PassiveRuntime,
} from './passive_runtime.js';
export {
  createSetBonusRuntime,
  type SetBonusRuntime,
} from './set_bonus_runtime.js';
export {
  createAffixRuntime,
  type AffixRuntime,
} from './affix_runtime.js';
export {
  createRarityRuntime,
  type RarityRuntime,
} from './rarity_runtime.js';
export {
  createItemReplayRuntime,
  type ItemReplayRuntime,
  type ItemSnapshot,
  type ReplayResult,
  snapshotToJson,
  snapshotFromJson,
  aggregatedToTransmit,
} from './item_replay_runtime.js';
export {
  createLootGenerationHooks,
  type LootGenerationHooks,
  type LootRollContext,
  type LootRollResult,
} from './loot_generation_hooks.js';
