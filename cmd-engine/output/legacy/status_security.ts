/**
 * STATUS SECURITY — external payload clamps (FIX #13).
 *
 * Effect payload có thể đến từ external source (skill JSON / future modding /
 * client request validate phase). Phải sanitize TRƯỚC khi feed vào pipeline:
 *   - negative BP overflow → clamp 0
 *   - oversize duration → clamp MAX_STATUS_DURATION
 *   - oversize stack → clamp MAX_STATUS_STACKS
 *   - oversize amount → clamp MAX_STATUS_AMOUNT
 *
 * Diff vs status_validation.ts:
 *   - validation.ts: post-merge runtime guard, THROW on violation (dev/integrity)
 *   - security.ts:   pre-pipeline sanitize, CLAMP silently (production safe)
 */
import type { StatusEffect } from './status_types.js';
import {
  MAX_STATUS_AMOUNT,
  MAX_STATUS_DURATION,
  MAX_STATUS_STACKS,
} from './status_validation.js';

export interface ClampReport {
  durationClamped: boolean;
  stacksClamped: boolean;
  amountClamped: boolean;
  amountSignFlipped: boolean;
}

/**
 * Sanitize incoming StatusEffect from external source. Returns clamped copy +
 * report cho telemetry log. Caller decide whether to emit invalid_status_shape
 * event nếu any clamp triggered.
 */
export function sanitizeIncomingStatus(
  raw: StatusEffect,
): { sanitized: StatusEffect; report: ClampReport } {
  const report: ClampReport = {
    durationClamped: false,
    stacksClamped: false,
    amountClamped: false,
    amountSignFlipped: false,
  };
  const sanitized: StatusEffect = { ...raw };

  if (!Number.isFinite(sanitized.remainingTurns) || sanitized.remainingTurns < 0) {
    sanitized.remainingTurns = 0;
    report.durationClamped = true;
  } else if (sanitized.remainingTurns > MAX_STATUS_DURATION) {
    sanitized.remainingTurns = MAX_STATUS_DURATION;
    report.durationClamped = true;
  }

  if (!Number.isFinite(sanitized.stacks) || sanitized.stacks < 1) {
    sanitized.stacks = 1;
    report.stacksClamped = true;
  } else if (sanitized.stacks > MAX_STATUS_STACKS) {
    sanitized.stacks = MAX_STATUS_STACKS;
    report.stacksClamped = true;
  }

  if (!Number.isFinite(sanitized.amount)) {
    sanitized.amount = 0;
    report.amountClamped = true;
  } else if (sanitized.amount < 0) {
    sanitized.amount = 0;
    report.amountSignFlipped = true;
    report.amountClamped = true;
  } else if (sanitized.amount > MAX_STATUS_AMOUNT) {
    sanitized.amount = MAX_STATUS_AMOUNT;
    report.amountClamped = true;
  }

  // Force INT (R31) — handler hot-path expect integer
  sanitized.remainingTurns = Math.floor(sanitized.remainingTurns);
  sanitized.stacks = Math.floor(sanitized.stacks);
  sanitized.amount = Math.floor(sanitized.amount);

  return { sanitized, report };
}

/** Quick boolean — true if any clamp triggered. */
export function clampDidMutate(report: ClampReport): boolean {
  return report.durationClamped || report.stacksClamped || report.amountClamped;
}
