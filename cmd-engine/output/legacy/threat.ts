/**
 * THREAT — Layer 2 PURE functions, INT BP scale (CLAUDE.md mục 14, R30).
 *
 * KHÔNG state. KHÔNG I/O. Pure deterministic helpers for F-4 Threat Formula.
 *
 * Stateful container (per-encounter table + decideTarget) sống ở Layer 3
 * (`src/server/threat_service.ts`) — xem CLAUDE.md mục 7B' và spec/06_THREAT_SYSTEM.md.
 *
 * 5 mech CRITICAL (R21) — đầy đủ implementation Module 4:
 *   1. threat decay   — đã có pure helper `decayValue`
 *   2. target memory  — Layer 3 ThreatService giữ memory
 *   3. threat spike   — Layer 3 entry field `spikeUntilTurn`
 *   4. forced target  — Layer 3 entry field `forcedUntilTurn`
 *   5. anti-heal aggro — Layer 3 ngữ cảnh encounter
 */
import { BP_DENOM } from './constants.js';

/** Loại action gây threat (R10). */
export type ThreatActionType = 'damage' | 'heal' | 'taunt' | 'guard' | 'summon' | 'buff';

export interface ThreatAction {
  type: ThreatActionType;
  /** Damage / heal value gốc trước coef. */
  amount: number;
  /** Cờ crit để Layer 3 tính spike. */
  isCrit?: boolean;
  /** Số turn taunt hold (cho action 'taunt'). */
  tauntDuration?: number;
}

/**
 * F-4 Threat Delta — pure, INT BP fixed-point.
 *
 * @param amount    base action value (damage / heal absolute, integer)
 * @param coefBP    THREAT_COEF_*_BP từ constants.json (damage 10000, taunt 50000)
 * @param roleModBP per-role multiplier BP (Tank 25000, DPS 10000)
 * @returns         threat delta integer ≥ 0 (single ÷10^8 cuối — 2 mult ×10000)
 */
export function calcThreatDelta(
  amount: number,
  coefBP: number,
  roleModBP: number,
): number {
  if (amount <= 0) return 0;
  return Math.floor((amount * coefBP * roleModBP) / (BP_DENOM * BP_DENOM));
}

/**
 * Apply decay tick — pure, INT BP.
 *
 * @param threat        current threat value (integer)
 * @param decayBP       decay rate BP (500 = 5%/turn)
 * @returns             post-decay integer, không âm
 */
export function decayValue(threat: number, decayBP: number): number {
  if (threat <= 0) return 0;
  const after = Math.floor((threat * (BP_DENOM - decayBP)) / BP_DENOM);
  return after < 0 ? 0 : after;
}
