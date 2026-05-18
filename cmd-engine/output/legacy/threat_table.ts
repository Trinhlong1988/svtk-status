/**
 * THREAT TABLE — pure Layer 2 (Phase 4 spec § IV).
 *
 * Map<EntityId, ThreatEntryV2>. Stable iteration. Replay-safe snapshot/restore.
 * Mutations via direct R33 helpers (caller owns Map).
 */
import type { ThreatEntryV2 } from './threat_types.js';
import { ThreatConstants } from './threat_constants.js';

/** Get or create entry. Mutates table. */
export function getOrCreateEntry(
  table: Map<string, ThreatEntryV2>,
  attackerId: string,
  currentTurn: number,
): ThreatEntryV2 {
  let e = table.get(attackerId);
  if (!e) {
    e = { attackerId, threat: 0, lastActionTurn: currentTurn };
    table.set(attackerId, e);
  }
  return e;
}

/** Add threat with overflow clamp. */
export function addThreatToEntry(entry: ThreatEntryV2, delta: number): void {
  if (!Number.isFinite(delta)) return;     // sanitize
  const next = entry.threat + delta;
  entry.threat = Math.min(
    Math.max(ThreatConstants.MIN_THREAT_VALUE, next),
    ThreatConstants.MAX_THREAT_VALUE,
  );
}

/** Stable sort entries by threat DESC + tiebreak by attackerId ASC (replay-safe). */
export function sortedByThreat(table: Map<string, ThreatEntryV2>): ThreatEntryV2[] {
  const arr = [...table.values()];
  arr.sort((a, b) => {
    if (a.threat !== b.threat) return b.threat - a.threat;
    return a.attackerId < b.attackerId ? -1 : a.attackerId > b.attackerId ? 1 : 0;
  });
  return arr;
}

/** Return top entry (highest threat) deterministic. */
export function topThreat(table: Map<string, ThreatEntryV2>): ThreatEntryV2 | undefined {
  const sorted = sortedByThreat(table);
  return sorted[0];
}

/** Drop attacker (vd entity dead / leave). */
export function dropAttacker(table: Map<string, ThreatEntryV2>, attackerId: string): boolean {
  return table.delete(attackerId);
}

/** Snapshot (replay). */
export function snapshotTable(table: Map<string, ThreatEntryV2>): ThreatEntryV2[] {
  return sortedByThreat(table).map((e) => ({ ...e }));
}

/** Restore from snapshot. Replaces existing. */
export function restoreTable(snap: readonly ThreatEntryV2[]): Map<string, ThreatEntryV2> {
  const out = new Map<string, ThreatEntryV2>();
  for (const e of snap) out.set(e.attackerId, { ...e });
  return out;
}

/** Total entries count. */
export function tableSize(table: Map<string, ThreatEntryV2>): number {
  return table.size;
}

/** Reset all (encounter end). */
export function clearTable(table: Map<string, ThreatEntryV2>): number {
  const n = table.size;
  table.clear();
  return n;
}
