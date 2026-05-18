/**
 * EVENT VALIDATOR — Zod runtime validate AFTER pre_resolve merge (FIX #2 hardening).
 *
 * Catches: type corruption, NaN, Infinity, missing field, extra field, wrong shape.
 * Throws MutationValidationError with detail.
 */
import { z } from 'zod';
import type { CombatEvent, CombatEventType } from './event_bus.js';

const finiteInt = z.number().int().refine((v) => Number.isFinite(v), 'must be finite (no NaN/Infinity)');
const finiteNum = z.number().refine((v) => Number.isFinite(v), 'must be finite (no NaN/Infinity)');

const turn = finiteInt;
const id = z.string().min(1);

const VARIANT_SCHEMAS: Record<CombatEventType, z.ZodTypeAny> = {
  cast: z.object({ type: z.literal('cast'), turn, casterId: id, skillId: id, targetId: id }).strict(),
  hit: z.object({ type: z.literal('hit'), turn, casterId: id, targetId: id, damage: finiteNum, isCrit: z.boolean() }).strict(),
  miss: z.object({ type: z.literal('miss'), turn, casterId: id, targetId: id, reason: z.enum(['dodge', 'accuracy']) }).strict(),
  heal: z.object({ type: z.literal('heal'), turn, casterId: id, targetId: id, heal: finiteNum }).strict(),
  effect_applied: z.object({ type: z.literal('effect_applied'), turn, targetId: id, effectType: z.string(), duration: finiteInt }).strict(),
  effect_expired: z.object({ type: z.literal('effect_expired'), turn, targetId: id, effectType: z.string() }).strict(),
  dot_tick: z.object({ type: z.literal('dot_tick'), turn, targetId: id, effectType: z.string(), damage: finiteNum }).strict(),
  hot_tick: z.object({ type: z.literal('hot_tick'), turn, targetId: id, effectType: z.string(), heal: finiteNum }).strict(),
  cc_applied: z.object({ type: z.literal('cc_applied'), turn, targetId: id, ccType: z.string(), duration: finiteInt }).strict(),
  cc_expired: z.object({ type: z.literal('cc_expired'), turn, targetId: id, ccType: z.string() }).strict(),
  threat_change: z.object({ type: z.literal('threat_change'), turn, targetId: id, casterId: id, delta: finiteNum }).strict(),
  shield_break: z.object({ type: z.literal('shield_break'), turn, targetId: id }).strict(),
  death: z.object({ type: z.literal('death'), turn, victimId: id, killerId: id }).strict(),
  revive: z.object({ type: z.literal('revive'), turn, targetId: id, reviverId: id }).strict(),
  phase_change: z.object({ type: z.literal('phase_change'), turn, bossId: id, fromPhase: finiteInt, toPhase: finiteInt }).strict(),
  enrage: z.object({ type: z.literal('enrage'), turn, bossId: id }).strict(),
  mana_drain: z.object({ type: z.literal('mana_drain'), turn, targetId: id, amount: finiteNum }).strict(),
  cast_failed: z.object({ type: z.literal('cast_failed'), turn, casterId: id, reason: z.string() }).strict(),
};

export class MutationValidationError extends Error {
  constructor(public readonly eventType: string, public readonly issues: z.ZodIssue[]) {
    super(`Event '${eventType}' failed Zod validation:\n${JSON.stringify(issues, null, 2)}`);
    this.name = 'MutationValidationError';
  }
}

/**
 * Validate event against per-variant schema. Throws MutationValidationError on fail.
 * Used by EventBus AFTER pre_resolve merge to catch listener-injected corruption.
 */
export function validateEvent(event: CombatEvent): void {
  const schema = VARIANT_SCHEMAS[event.type as CombatEventType];
  if (!schema) {
    throw new MutationValidationError(event.type, [
      { code: 'custom', path: ['type'], message: `Unknown event.type '${event.type}'` } as z.ZodIssue,
    ]);
  }
  const result = schema.safeParse(event);
  if (!result.success) {
    throw new MutationValidationError(event.type, result.error.issues);
  }
}
