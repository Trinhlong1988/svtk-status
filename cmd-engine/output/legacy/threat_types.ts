/**
 * THREAT TYPES — Phase 4 Threat Engine.
 *
 * Distinguish:
 *   - ThreatGenerationSource (8 source — damage/heal/shield/taunt/passive/summon/dot/hot)
 *   - ThreatEntry (per attacker: value + meta)
 *   - ThreatTable (encounter-scoped storage)
 *   - TauntState (forced target tracking)
 *
 * Pure types, NO state, NO I/O. Replay-safe INT.
 */
import { z } from 'zod';
import type { Role } from './types.js';

// ─────────────────────────────────────────────────────────
// Generation source — 8 type per § V
// ─────────────────────────────────────────────────────────

export const ThreatGenerationSourceSchema = z.enum([
  'damage',
  'heal',
  'shield',
  'taunt',
  'passive',
  'summon',
  'dot',
  'hot',
]);
export type ThreatGenerationSource = z.infer<typeof ThreatGenerationSourceSchema>;

// ─────────────────────────────────────────────────────────
// Threat action — input data shape
// ─────────────────────────────────────────────────────────

export interface ThreatActionInput {
  source: ThreatGenerationSource;
  /** Base value (damage / heal absolute INT). */
  amount: number;
  /** Crit flag — Layer 3 ThreatService computes spike. */
  isCrit?: boolean;
  /** Taunt duration turns (when source = taunt). */
  tauntDuration?: number;
  /** Summon owner id (propagate threat to owner). */
  summonOwnerId?: string;
  /** Pet split target — % threat split between pet and owner. */
  petSplitTarget?: string;
}

// ─────────────────────────────────────────────────────────
// Threat entry — per attacker
// ─────────────────────────────────────────────────────────

export interface ThreatEntryV2 {
  attackerId: string;
  /** Current threat value (INT, capped MAX_THREAT_VALUE). */
  threat: number;
  /** Last action turn (idle decay reference). */
  lastActionTurn: number;
  /** Spike turn — crit/burst grant temporary visibility boost. */
  spikeUntilTurn?: number;
  /** Forced target turn (set by taunt). */
  forcedUntilTurn?: number;
  /** Disengage turn — entity left combat range. */
  disengageTurn?: number;
  /** Distance from boss (cell). For distance decay. */
  distance?: number;
}

// ─────────────────────────────────────────────────────────
// Taunt state per target (boss)
// ─────────────────────────────────────────────────────────

export interface TauntStateEntry {
  /** Target affected by taunt (boss/NPC). */
  targetId: string;
  /** Current taunt source (forced attacker). */
  forcedSourceId: string;
  /** Turn until expire. */
  forcedUntilTurn: number;
  /** DR level (0..N) — diminishing return per § VII. */
  drLevel: number;
  /** Last apply turn for DR reset. */
  drLastApplyTurn: number;
}

// ─────────────────────────────────────────────────────────
// Target resolution mode (§ IX)
// ─────────────────────────────────────────────────────────

export const TargetResolveModeSchema = z.enum([
  'highest_threat',
  'nearest_threat',
  'scripted_override',
  'mechanic_override',
  'taunt_override',
  'anti_exploit_fallback',
]);
export type TargetResolveMode = z.infer<typeof TargetResolveModeSchema>;

export interface TargetResolveContext {
  currentTurn: number;
  /** Optional scripted override id (boss script forces target). */
  scriptedTargetId?: string;
  /** Optional mechanic override id (boss mechanic — vd "lowest hp"). */
  mechanicTargetId?: string;
  /** Distance map per attacker (cell distance from boss). */
  distanceMap?: Map<string, number>;
  /** Eligibility filter (alive + in-range). */
  isEligible?: (attackerId: string) => boolean;
}

export interface TargetResolveResult {
  targetId: string | null;
  mode: TargetResolveMode;
  reason?: string;
}

// ─────────────────────────────────────────────────────────
// Modifier registry tag (§ VI — generic role/tag based)
// ─────────────────────────────────────────────────────────

export interface ThreatModifierEntry {
  /** Match by role OR tag (whichever matches first). */
  role?: Role;
  tag?: string;
  /** Threat multiplier BP (10000 = no change, 25000 = ×2.5). */
  multBP: number;
  /** Restrict to specific source (vd healer +50% only on heal). */
  restrictSource?: ThreatGenerationSource;
}
