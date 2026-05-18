/**
 * EVENT EMIT POLICY — FIX #14 R33 alignment.
 *
 * Đề phòng emit-everything anti-pattern khi world boss spawn 50+ effect/sec.
 *
 * RULES:
 *   1. Combat hot-path (DOT tick, HOT tick, shield update) — DIRECT MUTATION ONLY,
 *      KHÔNG emit per-mutation. Pipeline emit aggregate event ('damage', 'heal') sau resolve.
 *   2. Event emit ONLY khi:
 *      - telemetry/audit (effect_applied, effect_expired)
 *      - listener subscribe (passive trigger, anti-cheat audit, modding hook)
 *      - recursion-sensitive (reflect → burn → on_tick passive chain)
 *   3. Per-effect emit cap = 1 (apply) + 1 (expire) — ABSOLUTELY NO emit per onTick mutation.
 *
 * Bull-case world boss capacity:
 *   - 100 char × 5 effect avg = 500 active effect
 *   - 1 turn = 500 emit max (NO per-tick emit)
 *   - 60 turn / phút × 500 = 30k event/phút telemetry max
 *   - 30 phút raid = 900k event — fits RollingFlushStore 100k buffer with 5% sampling
 *
 * Document only — TypeScript compile-time enum để team grep grep allowed event kinds.
 */

/** Hot-path direct mutation events — DO NOT emit per occurrence. */
export const DIRECT_MUTATION_EVENTS = [
  'dot_damage_per_tick',
  'hot_heal_per_tick',
  'shield_apply_amount',
  'shield_consume_amount',
  'cc_flag_set',
  'cc_flag_clear',
] as const;

/** Approved emit kinds at status pipeline boundary. */
export const APPROVED_STATUS_EMIT = [
  'effect_applied',
  'effect_expired',
  'cast_failed',
  'damage',
  'heal',
  'dot_tick',
  'hot_tick',
  'cc_applied',
  'cc_expired',
] as const;

/** Approved telemetry-only emit (write to Telemetry, NOT bus). */
export const APPROVED_TELEMETRY_ONLY = [
  'dr_triggered',
  'cleanse_triggered',
  'effect_overwritten',
  'status_apply_fail',
  'invalid_cleanse_attempt',
  'dr_immune_trigger',
  'stack_cap_hit',
  'overwrite_replace',
  'invalid_status_shape',
  'recursion_abort',
] as const;

export type DirectMutationEvent = (typeof DIRECT_MUTATION_EVENTS)[number];
export type ApprovedStatusEmit = (typeof APPROVED_STATUS_EMIT)[number];
export type ApprovedTelemetryOnly = (typeof APPROVED_TELEMETRY_ONLY)[number];
