/**
 * CAST RULE — 10-step canonical cast pipeline order (Phase 3 spec § XIII).
 *
 * Documented + enforced order. Used by skillResolver.ts.
 *
 * STEP ORDER:
 *   1. validate         (skillValidator — typed errors)
 *   2. target resolve   (skillTargeting — 9 modes)
 *   3. mana check       (canPay)
 *   4. cooldown check   (canCast)
 *   5. formula resolve  (Module 1 calcDamage / calcHeal per target)
 *   6. damage/heal apply (direct mutate target.hp per R33)
 *   7. status request   (skillBridge — emit ResolvedStatusRequest, status engine apply)
 *   8. threat emit      (Module 4 ThreatService.addThreat per target)
 *   9. telemetry emit   (cast / hit / damage / heal / status_request_emit)
 *  10. replay record    (mutationLog push if enabled)
 *
 * Step 1-4 = pre-resolve gates (fail-fast).
 * Step 5-10 = resolve sequence (deterministic order per replay).
 */
export const CAST_PIPELINE_STEPS = [
  'validate',
  'target_resolve',
  'mana_check',
  'cooldown_check',
  'formula_resolve',
  'damage_heal_apply',
  'status_request',
  'threat_emit',
  'telemetry_emit',
  'replay_record',
] as const;

export type CastPipelineStep = (typeof CAST_PIPELINE_STEPS)[number];

/** Audit helper — used by tests + telemetry. */
export function castStepIndex(step: CastPipelineStep): number {
  return CAST_PIPELINE_STEPS.indexOf(step);
}
