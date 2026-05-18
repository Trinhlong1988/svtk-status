/**
 * THREAT CLEANUP — entity lifecycle hooks (FIX PHASE 4 #3 CRITICAL).
 *
 * Prevent ghost aggro / memory leak / dead entity threat / invalid target.
 *
 * 5 cleanup events:
 *   - entity_death       — drop attacker entry
 *   - entity_disconnect  — drop entry (player leave mid-combat)
 *   - summon_despawn     — drop summon entry; optional propagate residue to owner
 *   - companion_swap     — apply CompanionThreatPolicy (separate module, see fix #7)
 *   - encounter_reset    — clear all (already in EncounterManager.reset)
 */
import { dropFromEngine, type ThreatEngineState } from './threat_engine.js';

export type CleanupReason =
  | 'entity_death'
  | 'entity_disconnect'
  | 'summon_despawn'
  | 'companion_swap'
  | 'encounter_reset';

export interface CleanupResult {
  reason: CleanupReason;
  entityId: string;
  removed: boolean;
  threatBefore: number;
  /** Entry id propagated residue to (for summon → owner). */
  propagatedTo?: string;
  propagatedAmount?: number;
}

/**
 * Cleanup an entity from threat. Returns result for telemetry.
 *
 * @param state    threat engine state
 * @param entityId entity to clean up
 * @param reason   cleanup reason
 * @param ownerId  optional owner for summon propagation (residue split)
 */
export function cleanupEntity(
  state: ThreatEngineState,
  entityId: string,
  reason: CleanupReason,
  ownerId?: string,
): CleanupResult {
  const entry = state.table.get(entityId);
  const threatBefore = entry?.threat ?? 0;

  // Summon → propagate residual % to owner before drop
  let propagatedTo: string | undefined;
  let propagatedAmount: number | undefined;
  if (reason === 'summon_despawn' && ownerId && entry && threatBefore > 0) {
    const ownerEntry = state.table.get(ownerId);
    if (ownerEntry) {
      const propagate = Math.floor(threatBefore / 2);    // 50% residue
      ownerEntry.threat += propagate;
      propagatedTo = ownerId;
      propagatedAmount = propagate;
    }
  }

  // Clear forced/spike if entity is the source/target
  if (state.taunt && state.taunt.forcedSourceId === entityId) {
    state.taunt = undefined;
  }
  if (state.currentTargetId === entityId) {
    state.currentTargetId = undefined;
  }

  const removed = dropFromEngine(state, entityId);
  return { reason, entityId, removed, threatBefore, propagatedTo, propagatedAmount };
}

/**
 * Bulk cleanup — call after wipe / encounter reset.
 * Returns count of entries cleared.
 */
export function cleanupAllParticipants(
  state: ThreatEngineState,
  participantIds: readonly string[],
  reason: CleanupReason,
): number {
  let n = 0;
  for (const id of participantIds) {
    const r = cleanupEntity(state, id, reason);
    if (r.removed) n++;
  }
  return n;
}

/**
 * Sanity sweep — remove entries with attackerId NOT in alive set
 * (defensive: catch ghost entries from missed cleanup callbacks).
 */
export function sweepGhostEntries(
  state: ThreatEngineState,
  aliveSet: ReadonlySet<string>,
): { removed: number; ghostIds: string[] } {
  const ghostIds: string[] = [];
  for (const id of state.table.keys()) {
    if (!aliveSet.has(id)) ghostIds.push(id);
  }
  for (const id of ghostIds) cleanupEntity(state, id, 'entity_disconnect');
  return { removed: ghostIds.length, ghostIds };
}
