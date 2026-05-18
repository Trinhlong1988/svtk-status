/**
 * SPATIAL THREAT RESOLVER — distance-aware threat (FIX PHASE 4 #5 HIGH).
 *
 * Compute spatial multiplier per entity based on distance from boss/origin:
 *   - near (≤ NEAR_THRESHOLD)         → SPATIAL_NEAR_BONUS_BP (11000 = +10%)
 *   - mid                              → 10000 (no change)
 *   - far  (> FAR_THRESHOLD)           → SPATIAL_FAR_DECAY_BP (8500 = -15%)
 *   - line skill exposure (AoE line)   → SPATIAL_LINE_EXPOSURE_BP (12000 = +20%)
 *
 * Pure helper — caller invokes BEFORE applyThreatAction to scale amount.
 */
import { ThreatConstants } from './threat_constants.js';

export interface SpatialContext {
  /** Distance from threat source (boss/origin). */
  distance: number;
  /** Is target on AoE line — exposed. */
  onSkillLine?: boolean;
}

/**
 * Compute spatial multiplier BP. Pure INT.
 */
export function spatialMultiplierBP(ctx: SpatialContext): number {
  let mult = 10000;
  if (ctx.distance <= ThreatConstants.SPATIAL_NEAR_THRESHOLD) {
    mult = composeBP(mult, ThreatConstants.SPATIAL_NEAR_BONUS_BP);
  } else if (ctx.distance > ThreatConstants.SPATIAL_FAR_THRESHOLD) {
    mult = composeBP(mult, ThreatConstants.SPATIAL_FAR_DECAY_BP);
  }
  if (ctx.onSkillLine) {
    mult = composeBP(mult, ThreatConstants.SPATIAL_LINE_EXPOSURE_BP);
  }
  return mult;
}

/** Compose 2 BP. */
function composeBP(a: number, b: number): number {
  return Math.floor((a * b) / 10000);
}

/**
 * Apply spatial multiplier to amount. Returns adjusted amount INT.
 */
export function applySpatialToAmount(amount: number, ctx: SpatialContext): number {
  if (amount <= 0) return amount;
  const mult = spatialMultiplierBP(ctx);
  return Math.floor((amount * mult) / 10000);
}

/**
 * Build distanceMap from positions — caller (spatial subsystem Module 6) provides
 * positions; helper computes cell distance.
 */
export interface Position {
  x: number;
  y: number;
}

export function chebyshevDistance(a: Position, b: Position): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function buildDistanceMap(
  origin: Position,
  positions: ReadonlyMap<string, Position>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, pos] of positions) {
    out.set(id, chebyshevDistance(origin, pos));
  }
  return out;
}
