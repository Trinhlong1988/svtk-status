/**
 * STATUS VALIDATION — runtime Zod re-validate sau pre_resolve mutation merge (FIX #3).
 *
 * Listener (anti_cheat / passive / modding) có thể inject NaN / Infinity / overflow
 * vào StatusEffect numeric fields. Phải reject TRƯỚC apply hoặc mutation propagate
 * qua telemetry/replay.
 *
 * Reject:
 *   - NaN / Infinity / -Infinity
 *   - non-integer (R31 INT-only)
 *   - negative remainingTurns / stacks / amount (security clamp)
 *   - amount BP overflow > MAX_SAFE_INTEGER / 10000  (prevent overflow trong chainMul)
 *   - unknown effect type (Zod enum reject)
 *   - unknown stackBehavior / drGroup / category (Zod enum reject)
 *
 * Hot-path: full re-validate ~1-2µs (Zod safeParse). Acceptable cho Step 7.
 */
import { StatusEffectSchema, type StatusEffect } from './status_types.js';

export class StatusMutationValidationError extends Error {
  constructor(
    public readonly effectId: string,
    public readonly issues: ReadonlyArray<{ path: (string | number)[]; message: string }>,
  ) {
    super(
      `[StatusMutationValidation] effectId=${effectId} ` +
      `issues=${JSON.stringify(issues)}`,
    );
    this.name = 'StatusMutationValidationError';
  }
}

/** Maximum amount BP — prevent INT overflow in chainMul (×10000). */
export const MAX_STATUS_AMOUNT = Math.floor(Number.MAX_SAFE_INTEGER / 100000);
/** Maximum remainingTurns — prevent permanent effect injection. */
export const MAX_STATUS_DURATION = 9999;
/** Maximum stacks — extra defense vs spec stack_limit. */
export const MAX_STATUS_STACKS = 9999;

export function validateStatusEffectMutation(eff: StatusEffect): void {
  // Step 1 — Zod schema (type, enum, integer, nonneg)
  const parsed = StatusEffectSchema.safeParse(eff);
  if (!parsed.success) {
    throw new StatusMutationValidationError(
      eff.effectId ?? 'unknown',
      parsed.error.issues.map((i) => ({ path: [...i.path], message: i.message })),
    );
  }
  // Step 2 — explicit NaN / Infinity guard (Zod allows finite by default but harden anyway)
  const numericFields: ReadonlyArray<keyof StatusEffect> = [
    'remainingTurns', 'stacks', 'amount', 'tickInterval', 'lastTickTurn', 'turnApplied',
  ];
  for (const f of numericFields) {
    const v = eff[f] as number;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new StatusMutationValidationError(eff.effectId, [
        { path: [f as string], message: `non-finite numeric: ${String(v)}` },
      ]);
    }
  }
  // Step 3 — security clamp ranges (FIX #13 overlap, kept here for centralization)
  if (eff.remainingTurns > MAX_STATUS_DURATION) {
    throw new StatusMutationValidationError(eff.effectId, [
      { path: ['remainingTurns'], message: `> MAX_STATUS_DURATION (${MAX_STATUS_DURATION})` },
    ]);
  }
  if (eff.stacks > MAX_STATUS_STACKS) {
    throw new StatusMutationValidationError(eff.effectId, [
      { path: ['stacks'], message: `> MAX_STATUS_STACKS (${MAX_STATUS_STACKS})` },
    ]);
  }
  if (Math.abs(eff.amount) > MAX_STATUS_AMOUNT) {
    throw new StatusMutationValidationError(eff.effectId, [
      { path: ['amount'], message: `> MAX_STATUS_AMOUNT (${MAX_STATUS_AMOUNT})` },
    ]);
  }
}
