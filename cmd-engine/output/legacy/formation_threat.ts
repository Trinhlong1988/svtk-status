/**
 * FORMATION THREAT MODIFIER — TS DNA frontline vs backline (FIX PHASE 4 #6 HIGH).
 *
 * 5v5 layout:
 *   Slot 0-2: front line (main char)        — +20% threat exposure
 *   Slot 3-4: front line edge / mid          — edge vulnerability +10%
 *   Slot 5-7: back line (companion main)     — -20% threat decay
 *   Slot 8-9: back line back (companion back) — -20% threat decay
 *
 * Frontline = MORE threat (easier target, exposed to melee)
 * Backline = LESS threat (safer, ranged advantage)
 * Edge = MORE vulnerable (corner exposure)
 *
 * Pure helper. Caller invoke BEFORE applyThreatAction to scale amount.
 */
import { ThreatConstants } from './threat_constants.js';

export type FormationRow = 'front' | 'mid' | 'back';
export type FormationEdge = 'edge' | 'center';

export interface FormationContext {
  /** Slot 0-9 in 5v5 layout. */
  slot: number;
}

export interface FormationClassification {
  row: FormationRow;
  edge: FormationEdge;
  multBP: number;
}

/**
 * Classify slot into row + edge + compute multiplier BP.
 *
 * Convention (matches battle_formation.ts):
 *   slot 0-2: front main
 *   slot 3-4: front mid (edge for slot 0,2 / 5,7)
 *   slot 5-7: back companion main
 *   slot 8-9: back companion back
 */
export function classifyFormation(slot: number): FormationClassification {
  let row: FormationRow;
  if (slot >= 0 && slot <= 2) row = 'front';
  else if (slot >= 3 && slot <= 4) row = 'mid';
  else if (slot >= 5 && slot <= 7) row = 'back';
  else row = 'back';

  // Edge slots = corners (0, 2, 5, 7)
  const edge: FormationEdge = (slot === 0 || slot === 2 || slot === 5 || slot === 7) ? 'edge' : 'center';

  let mult = 10000;
  if (row === 'front') mult = compose(mult, ThreatConstants.FORMATION_FRONT_THREAT_MULT_BP);
  else if (row === 'back') mult = compose(mult, ThreatConstants.FORMATION_BACK_THREAT_MULT_BP);
  // mid = 10000 (no change)
  if (edge === 'edge') mult = compose(mult, ThreatConstants.FORMATION_EDGE_VULNERABILITY_BP);

  return { row, edge, multBP: mult };
}

function compose(a: number, b: number): number {
  return Math.floor((a * b) / 10000);
}

/**
 * Apply formation multiplier to threat amount. Returns adjusted INT.
 */
export function applyFormationToAmount(amount: number, slot: number): number {
  if (amount <= 0) return amount;
  const { multBP } = classifyFormation(slot);
  return Math.floor((amount * multBP) / 10000);
}
