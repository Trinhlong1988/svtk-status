/**
 * COMPANION THREAT POLICY — swap rules (FIX PHASE 4 #7 HIGH).
 *
 * When swapping companion mid-battle, threat from OLD companion must be handled:
 *   - inherit_partial:  new pet gets X% of old pet's threat (default 50%)
 *   - decay_old:        old threat scheduled decay (over N turn)
 *   - wipe_on_swap:     old threat fully removed
 *   - owner_share:      old threat moved to owner (Y% via OWNER_SHARE_BP)
 *
 * Pure function — caller (EncounterManager.swapCompanion) invokes.
 */
import { ThreatConstants } from './threat_constants.js';
import { dropFromEngine, type ThreatEngineState } from './threat_engine.js';
import { addThreatToEntry, getOrCreateEntry } from './threat_table.js';

export type CompanionSwapPolicy =
  | 'inherit_partial'
  | 'decay_old'
  | 'wipe_on_swap'
  | 'owner_share';

export interface SwapInput {
  oldCompanionId: string;
  newCompanionId: string;
  ownerId: string;
  policy: CompanionSwapPolicy;
  currentTurn: number;
}

export interface SwapResult {
  policy: CompanionSwapPolicy;
  oldThreatBefore: number;
  newCompanionThreat: number;
  ownerSharedAmount?: number;
  decayedAmount?: number;
}

/**
 * Apply swap policy. Mutates state.table. Returns result for telemetry.
 */
export function applyCompanionSwap(
  state: ThreatEngineState,
  input: SwapInput,
): SwapResult {
  const oldEntry = state.table.get(input.oldCompanionId);
  const oldThreat = oldEntry?.threat ?? 0;
  const result: SwapResult = {
    policy: input.policy,
    oldThreatBefore: oldThreat,
    newCompanionThreat: 0,
  };

  switch (input.policy) {
    case 'inherit_partial': {
      const transfer = Math.floor((oldThreat * ThreatConstants.COMPANION_INHERIT_PARTIAL_BP) / 10000);
      const newEntry = getOrCreateEntry(state.table, input.newCompanionId, input.currentTurn);
      addThreatToEntry(newEntry, transfer);
      result.newCompanionThreat = newEntry.threat;
      dropFromEngine(state, input.oldCompanionId);
      break;
    }
    case 'decay_old': {
      // Mark for decay — set disengageTurn so threat_decay sweep reduces.
      if (oldEntry) {
        oldEntry.disengageTurn = input.currentTurn;
      }
      const newEntry = getOrCreateEntry(state.table, input.newCompanionId, input.currentTurn);
      result.newCompanionThreat = newEntry.threat;
      result.decayedAmount = oldThreat;
      // Do NOT drop old — let decay handle gradually
      break;
    }
    case 'wipe_on_swap': {
      dropFromEngine(state, input.oldCompanionId);
      const newEntry = getOrCreateEntry(state.table, input.newCompanionId, input.currentTurn);
      result.newCompanionThreat = newEntry.threat;
      break;
    }
    case 'owner_share': {
      const share = Math.floor((oldThreat * ThreatConstants.COMPANION_OWNER_SHARE_BP) / 10000);
      const ownerEntry = getOrCreateEntry(state.table, input.ownerId, input.currentTurn);
      addThreatToEntry(ownerEntry, share);
      result.ownerSharedAmount = share;
      const newEntry = getOrCreateEntry(state.table, input.newCompanionId, input.currentTurn);
      result.newCompanionThreat = newEntry.threat;
      dropFromEngine(state, input.oldCompanionId);
      break;
    }
  }

  return result;
}
