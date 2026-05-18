/**
 * COMPANION PROGRESSION HOOK — Contract #5 (CMD3 Phase 8 interface-first batch).
 *
 * Companion affinity + bond progression per bootstrap §XII:
 *   "SVTK DNA: 1 player + 1 companion.
 *    Quest/progression MUST support: companion affinity, companion unlock, companion reaction,
 *    companion story progression — WITHOUT separate companion quest engine."
 *
 * Layer: Layer 3 service interface (stateful affinity store) + Layer 2 pure transition logic.
 *
 * Hook responsibilities:
 *   - Increment/decrement companion affinity points (bond quest reward, dialog reaction)
 *   - Detect tier transitions (stranger → familiar → trusted → bonded → soulbound)
 *   - Emit `on_companion_unlock` event khi tier advance (downstream qua ProgressionEventBridge)
 *   - Track companion_unlock state (each char has 1 active companion + N reserve, bootstrap §XII)
 *   - Snapshot/restore (replay-safe)
 *
 * Hook KHÔNG:
 *   - Mutate companion combat stat (combat core untouched — Phase 3 CompanionRuntime own stat)
 *   - Mutate inventory (companion gear out of CMD3 scope — CMD2 itemization own)
 *   - Run separate companion quest engine (anti-pattern — bootstrap §XII)
 *
 * Hardening FIX #8 — Isolation LOCK (CMD3-Copy-Copy.docx §X):
 *   "Phase 3 combat companion runtime ≠ CMD3 narrative/bond progression.
 *    DO NOT merge systems. Integration ONLY through event hooks.
 *    BLOCK: combat stat mutation, runtime ownership leak, duplicate companion state."
 *
 *   Lock enforced at compile-time:
 *     - File này KHÔNG `import` từ `src/logic/companion_runtime.ts` (Phase 3 CMD1)
 *     - File này KHÔNG `import` từ `src/logic/combat_entity.ts` (combat stat)
 *     - Affinity store standalone — companion combat stat queried via owner runtime adapter (Phase later)
 *
 *   Lock enforced at runtime: `IsolationLockGuard.assertNoCombatMutation(call_site)`
 *     để verify caller chỉ invoke event-emit pattern.
 *
 * Anti-pattern blocked:
 *   - `if (companion.id === 'yet_kieu') unlockChain(...)` — registry dispatch
 *   - Direct CompanionRuntime mutation — emit event qua ProgressionEventBridge
 *
 * ⚠ NO IMPLEMENTATION trong file này — chỉ contract interface.
 *    Implementation sau Mr.Long ack: `companion_affinity_store.ts`.
 */
import { z } from 'zod';
import {
  type CompanionAffinity,
  type CompanionAffinityTier,
  type QuestCharId,
  CompanionAffinitySchema,
  CompanionAffinityTierSchema,
  QuestCharIdSchema,
} from './quest_types.js';

// ───────── Affinity Delta Source ─────────
/**
 * 5 source — where affinity change comes from:
 *
 *  - quest_complete: bond quest reward (QuestRewardContract.grantReward delegates)
 *  - dialog_choice: positive/negative reaction from dialog branch
 *  - combat_assist: companion helped in encounter (small +)
 *  - gift_offered: player give item to companion (Phase later)
 *  - story_milestone: story flag set granting bond
 */
export const AffinityDeltaSourceSchema = z.enum([
  'quest_complete',
  'dialog_choice',
  'combat_assist',
  'gift_offered',
  'story_milestone',
]);
export type AffinityDeltaSource = z.infer<typeof AffinityDeltaSourceSchema>;

// ───────── Affinity Tier Table (data-driven thresholds) ─────────
/**
 * Tier thresholds — points required to advance.
 *
 * Loaded từ `data/companion_affinity_thresholds.json`:
 *
 *  - stranger:  0–999    (initial)
 *  - familiar:  1000–2999
 *  - trusted:   3000–6999
 *  - bonded:    7000–14999
 *  - soulbound: 15000+ (cap tier)
 *
 * Cap per char 3 tier (bootstrap §XII alignment — limit soulbound per char to prevent meta abuse).
 */
export const AffinityTierThresholdSchema = z.object({
  tier: CompanionAffinityTierSchema,
  /** Min points to enter this tier (inclusive). */
  min_points: z.number().int().nonnegative(),
  /** Max points before advancing to next tier (exclusive, or undefined for cap tier). */
  max_points_exclusive: z.number().int().positive().optional(),
});
export type AffinityTierThreshold = z.infer<typeof AffinityTierThresholdSchema>;

// ───────── Affinity Delta Context ─────────
export const AffinityDeltaContextSchema = z.object({
  char_id: QuestCharIdSchema,         // owner player
  companion_id: QuestCharIdSchema,    // companion
  source: AffinityDeltaSourceSchema,
  /** Points delta (signed integer — negative for negative reaction). */
  delta_points: z.number().int(),
  /** Idempotency anchor. */
  idempotency_key: z.string().min(1),
  /** Turn ordinal. */
  ordinal: z.number().int().nonnegative(),
});
export type AffinityDeltaContext = z.infer<typeof AffinityDeltaContextSchema>;

// ───────── Affinity Apply Status ─────────
/**
 * Outcome:
 *
 *  - applied: points changed, tier maybe transitioned
 *  - tier_advanced: same as applied + tier crossed threshold (emit on_companion_unlock)
 *  - tier_demoted: points went down, tier crossed threshold downward (rare — negative source)
 *  - no_change: delta = 0 or tier_cap reached
 *  - duplicate: idempotency_key đã commit
 *  - companion_not_found: companion_id chưa register
 *  - cap_per_char_reached: char đã có 3 soulbound companion (bootstrap §XII)
 */
export const AffinityApplyStatusSchema = z.enum([
  'applied',
  'tier_advanced',
  'tier_demoted',
  'no_change',
  'duplicate',
  'companion_not_found',
  'cap_per_char_reached',
]);
export type AffinityApplyStatus = z.infer<typeof AffinityApplyStatusSchema>;

export const AffinityApplyResultSchema = z.object({
  status: AffinityApplyStatusSchema,
  char_id: QuestCharIdSchema,
  companion_id: QuestCharIdSchema,
  before: CompanionAffinitySchema.optional(),
  after: CompanionAffinitySchema.optional(),
  /** Optional: if tier_advanced, the new tier. */
  new_tier: CompanionAffinityTierSchema.optional(),
  /** Emit signal — caller forward to ProgressionEventBridge as `on_companion_unlock`. */
  should_emit_unlock_event: z.boolean(),
  ordinal: z.number().int().nonnegative(),
  reason: z.string().optional(),
});
export type AffinityApplyResult = z.infer<typeof AffinityApplyResultSchema>;

// ───────── Companion Snapshot (replay-safe) ─────────
export const CompanionProgressionSnapshotSchema = z.object({
  schema_version: z.number().int().positive().default(1),
  /** Affinity entries sorted by `${char_id}|${companion_id}` for deterministic JSON. */
  affinities: z.array(CompanionAffinitySchema),
  ordinal: z.number().int().nonnegative(),
});
export type CompanionProgressionSnapshot = z.infer<typeof CompanionProgressionSnapshotSchema>;

// ───────── CompanionProgressionHook Contract ─────────
/**
 * CONTRACT — interface mà implementation `companion_affinity_store.ts` PHẢI satisfy.
 *
 * Determinism guarantee:
 *  - Cùng `(snapshot, deltas_sequence)` → cùng final snapshot
 *  - Tier transition deterministic theo threshold table (data-driven)
 *  - Iteration order stable (sorted owner+companion)
 *  - Replay-safe: JSON-serializable INT
 *
 * Server-authoritative:
 *  - Server canonical affinity points, client KHÔNG inject
 *  - Cap per char 3 soulbound enforced server-side
 */
export interface CompanionProgressionHook {
  /**
   * Apply affinity delta.
   *
   * Steps:
   *   1. Validate ctx (Zod)
   *   2. Check idempotency registry
   *   3. Lookup CompanionAffinity current (or initialize stranger tier với 0 points)
   *   4. Apply delta_points (clamp ≥ 0 if would go negative)
   *   5. Lookup new tier from threshold table
   *   6. Check cap_per_char (block soulbound if char already has 3)
   *   7. Set should_emit_unlock_event = (tier advanced upward)
   *   8. Update affinity record
   *   9. Build AffinityApplyResult
   */
  applyDelta(ctx: AffinityDeltaContext): AffinityApplyResult;

  /**
   * Get affinity for (char_id, companion_id).
   *
   * @returns CompanionAffinity (initialized stranger if first lookup)
   */
  getAffinity(char_id: QuestCharId, companion_id: QuestCharId): CompanionAffinity;

  /**
   * List all companions known to char (for UI).
   *
   * @returns sorted alphabetical by companion_id
   */
  listCompanionsForChar(char_id: QuestCharId): readonly CompanionAffinity[];

  /**
   * Register tier threshold table.
   *
   * 5 thresholds (one per tier). Re-register → throw.
   */
  registerThresholds(thresholds: readonly AffinityTierThreshold[]): void;

  /**
   * Snapshot cho replay.
   */
  snapshot(ordinal: number): CompanionProgressionSnapshot;

  /**
   * Restore from snapshot.
   *
   * @throws Error nếu schema_version mismatch
   */
  restore(snapshot: CompanionProgressionSnapshot): void;

  /**
   * Reset (test-only).
   */
  _resetForTest(): void;

  // ─── Hardening FIX #8 — Isolation lock ───
  /**
   * Assert no combat mutation occurred during call.
   *
   * Runtime guard: invoked by impl pre/post each mutation. If call site imports
   * forbidden module (combat_entity / companion_runtime / threat_engine) → throw.
   *
   * Lint rule cấm import từ `src/logic/companion_runtime.ts` + `src/logic/combat_entity.ts`
   * trong toàn bộ `src/modules/quest/`.
   */
  assertIsolation(call_site: string): void;
}

// ───────── ★ NO IMPLEMENTATION ─────────
// Implementation: companion_affinity_store.ts (ship sau Mr.Long ack contract).
