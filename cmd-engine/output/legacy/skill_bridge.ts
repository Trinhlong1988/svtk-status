/**
 * SKILL → STATUS BRIDGE (Phase 3 spec § XI).
 *
 * Skill MUST NOT directly call applyEffect on target. Instead, skill emit
 * `ResolvedStatusRequest[]`, status engine consume vào pipeline.
 *
 * GOAL:
 *   - Decouple Skill module from Status module
 *   - Allow batching, dedup, recursion control
 *   - Preserve replay determinism (status apply order = skill resolution order)
 *
 * Hot-path: pure transform — NO I/O, NO async, NO mutation of target.
 */
import type {
  SkillTemplate,
  SkillCastRequest,
  ResolvedStatusRequest,
} from './skill_types.js';
import { clampLevel } from './skill_scaling.js';
import { SkillConstants } from './skill_constants.js';
import { sanitizeIncomingStatus } from './status_security.js';
import { buildStatusEffect } from './status_events.js';

/**
 * Resolve all status requests for skill at level, for each target.
 * Returns array of ResolvedStatusRequest — caller feed vào applyEffect per request.
 *
 * Order: stable (skill.status_requests array order × targetIds order).
 * Cap: MAX_STATUS_REQUEST_PER_CAST per cast (extra requests dropped + telemetry).
 */
export function resolveStatusRequests(
  skill: SkillTemplate,
  request: SkillCastRequest,
  targetIds: readonly string[],
): ResolvedStatusRequest[] {
  if (!skill.status_requests || skill.status_requests.length === 0) return [];
  const lv = clampLevel(request.level);
  const out: ResolvedStatusRequest[] = [];
  const cap = SkillConstants.MAX_STATUS_REQUEST_PER_CAST;

  for (const sr of skill.status_requests) {
    const amount = pickPerLevel(sr.amount_by_level, lv);
    const duration = pickPerLevel(sr.duration_by_level, lv);
    const tickInterval = sr.tickInterval ?? 1;
    const initialStacks = sr.initialStacks ?? 1;

    for (const tid of targetIds) {
      if (out.length >= cap) return out;
      out.push({
        targetId: tid,
        effectType: sr.effectType,
        category: sr.category,
        drGroup: sr.drGroup,
        stackBehavior: sr.stackBehavior,
        amount,
        duration,
        tickInterval,
        initialStacks,
        sourceId: request.casterId,
        sourceSkillId: skill.id,
      });
    }
  }
  return out;
}

function pickPerLevel(arr: readonly number[], lv: number): number {
  const idx = Math.max(0, Math.min(lv - 1, arr.length - 1));
  return arr[idx] ?? 0;
}

/**
 * Convert ResolvedStatusRequest → StatusEffect template (ready for applyEffect).
 * Sanitize per FIX #13 (Phase 2 hardening) before construct.
 */
export function buildStatusFromRequest(
  req: ResolvedStatusRequest,
  currentTurn: number,
  effectIdSeq: number,
): import('./status_types.js').StatusEffect {
  const fresh = buildStatusEffect({
    effectId: `${req.sourceSkillId}.${req.targetId}.${effectIdSeq}`,
    type: req.effectType,
    category: req.category,
    sourceId: req.sourceId,
    targetId: req.targetId,
    turnApplied: currentTurn,
    duration: req.duration,
    amount: req.amount,
    tickInterval: req.tickInterval,
    drGroup: req.drGroup,
    stackBehavior: req.stackBehavior,
    initialStacks: req.initialStacks,
  });
  // Sanitize external-source values (skill JSON content may carry tuning bug).
  const { sanitized } = sanitizeIncomingStatus(fresh);
  return sanitized;
}
