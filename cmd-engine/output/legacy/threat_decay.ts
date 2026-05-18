/**
 * THREAT DECAY — Phase 4 § VIII.
 *
 * 3 decay flavors:
 *   - idle:      no action for IDLE_TURNS_THRESHOLD → DECAY_IDLE_BP per turn
 *   - distance:  attacker far from boss → DECAY_DISTANCE_BP per turn
 *   - disengage: attacker fled combat → DECAY_DISENGAGE_BP per turn
 *
 * RULE: turn-based deterministic timing only — NO wall-clock.
 *
 * Pure function applied to each entry per turn end.
 */
import type { ThreatEntryV2 } from './threat_types.js';
import { ThreatConstants } from './threat_constants.js';

export interface DecayOptions {
  /** Distance threshold (cell). Beyond this → distance decay applies. */
  farDistance?: number;
  /** Default = 8 cell. */
}

/**
 * Apply decay to entry. Mutates entry.threat in-place. Returns delta (negative).
 *
 * @param entry         current entry
 * @param currentTurn   turn number
 * @param opts          optional thresholds
 */
export function applyDecayToEntry(
  entry: ThreatEntryV2,
  currentTurn: number,
  opts: DecayOptions = {},
): number {
  if (entry.threat <= 0) return 0;
  const before = entry.threat;
  let totalDecayBP = 0;

  // Idle decay
  if (currentTurn - entry.lastActionTurn >= ThreatConstants.IDLE_TURNS_THRESHOLD) {
    totalDecayBP += ThreatConstants.DECAY_IDLE_BP;
  }
  // Distance decay
  const farThreshold = opts.farDistance ?? 8;
  if (entry.distance !== undefined && entry.distance > farThreshold) {
    totalDecayBP += ThreatConstants.DECAY_DISTANCE_BP;
  }
  // Disengage decay
  if (entry.disengageTurn !== undefined && currentTurn > entry.disengageTurn) {
    totalDecayBP += ThreatConstants.DECAY_DISENGAGE_BP;
  }

  if (totalDecayBP === 0) return 0;
  // Cap total decay at 9999 BP (max 99.99% per turn — protects against config bug)
  totalDecayBP = Math.min(totalDecayBP, 9999);

  const remainBP = 10000 - totalDecayBP;
  entry.threat = Math.max(0, Math.floor((entry.threat * remainBP) / 10000));
  return entry.threat - before;
}

/**
 * Sweep entire table for decay. Returns total threat removed (telemetry).
 */
export function decayAll(
  table: Map<string, ThreatEntryV2>,
  currentTurn: number,
  opts: DecayOptions = {},
): number {
  let total = 0;
  for (const entry of table.values()) {
    total += applyDecayToEntry(entry, currentTurn, opts);
  }
  return total;
}
