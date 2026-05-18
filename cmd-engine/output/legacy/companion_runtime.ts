/**
 * COMPANION RUNTIME — first-class combat entity lifecycle (Phase 5).
 *
 * SVTK combat DNA: 1 player = 1 main + 1 companion.
 * Companion MUST behave as first-class CombatEntity (NOT visual pet).
 *
 * Module gộp: companion_runtime + companion_reserve + companion_lifecycle +
 * companion_state + companion_owner_link.
 *
 * Stateful — caller (server orchestration) owns 1 CompanionRuntime per owner.
 */
import { NpcConstants } from './npc_constants.js';
import { applyCompanionSwap, type CompanionSwapPolicy } from './companion_threat_policy.js';
import type { ThreatEngineState } from './threat_engine.js';

export type CompanionState =
  | 'active'        // currently in formation slot
  | 'reserve'       // bench, available to swap in
  | 'dead'          // killed, awaiting revive
  | 'recalled'      // returned to inventory (out of combat)
  | 'persistent';   // alive but in transit (between encounters)

export interface CompanionEntry {
  companionId: string;
  ownerId: string;
  state: CompanionState;
  /** Last activity turn. */
  lastActiveTurn: number;
  /** Slot when active (formation). */
  activeSlot?: number;
  /** Death turn (for revive cooldown). */
  deathTurn?: number;
}

export interface CompanionRuntime {
  ownerId: string;
  /** Active companion id (currently in slot). */
  activeCompanionId?: string;
  /** Reserve pool — max COMPANION_RESERVE_MAX_SLOTS. */
  reserve: CompanionEntry[];
  /** Persistent out-of-combat companions (lazy load). */
  persistent: CompanionEntry[];
  /** Recall cooldown remaining. */
  recallCooldownRemaining: number;
}

export function createCompanionRuntime(ownerId: string): CompanionRuntime {
  return {
    ownerId,
    reserve: [],
    persistent: [],
    recallCooldownRemaining: 0,
  };
}

// ─────────────────────────────────────────────────────────
// Add / spawn companion
// ─────────────────────────────────────────────────────────

export type AddCompanionOutcome =
  | 'added_active'
  | 'added_reserve'
  | 'added_persistent'
  | 'reserve_full';

export function addCompanion(
  runtime: CompanionRuntime,
  companionId: string,
  initialState: CompanionState = 'reserve',
  currentTurn: number = 0,
): AddCompanionOutcome {
  const entry: CompanionEntry = {
    companionId,
    ownerId: runtime.ownerId,
    state: initialState,
    lastActiveTurn: currentTurn,
  };
  if (initialState === 'active') {
    runtime.activeCompanionId = companionId;
    entry.activeSlot = 5;     // default companion slot
    return 'added_active';
  }
  if (initialState === 'reserve') {
    if (runtime.reserve.length >= NpcConstants.COMPANION_RESERVE_MAX_SLOTS) {
      return 'reserve_full';
    }
    runtime.reserve.push(entry);
    return 'added_reserve';
  }
  if (initialState === 'persistent') {
    runtime.persistent.push(entry);
    return 'added_persistent';
  }
  return 'reserve_full';
}

// ─────────────────────────────────────────────────────────
// Swap — mid-battle exchange
// ─────────────────────────────────────────────────────────

export interface SwapInput {
  newCompanionId: string;
  policy: CompanionSwapPolicy;
  threat: ThreatEngineState;
  currentTurn: number;
}

export type SwapOutcome =
  | 'swapped'
  | 'no_active_to_swap_out'
  | 'reserve_not_found'
  | 'cooldown_active';

export interface SwapResultDetail {
  outcome: SwapOutcome;
  oldCompanionId?: string;
  threatTransferred?: number;
}

export function swapCompanion(runtime: CompanionRuntime, input: SwapInput): SwapResultDetail {
  if (runtime.recallCooldownRemaining > 0) {
    return { outcome: 'cooldown_active' };
  }
  const oldId = runtime.activeCompanionId;
  if (!oldId) return { outcome: 'no_active_to_swap_out' };

  const reserveIdx = runtime.reserve.findIndex((c) => c.companionId === input.newCompanionId);
  if (reserveIdx < 0) return { outcome: 'reserve_not_found' };

  const reserveEntry = runtime.reserve[reserveIdx]!;

  // Apply threat policy
  const r = applyCompanionSwap(input.threat, {
    oldCompanionId: oldId,
    newCompanionId: input.newCompanionId,
    ownerId: runtime.ownerId,
    policy: input.policy,
    currentTurn: input.currentTurn,
  });

  // Move old to reserve (or dead/persistent based on state)
  runtime.reserve.push({
    companionId: oldId,
    ownerId: runtime.ownerId,
    state: 'reserve',
    lastActiveTurn: input.currentTurn,
  });
  // Activate new
  reserveEntry.state = 'active';
  reserveEntry.activeSlot = 5;
  reserveEntry.lastActiveTurn = input.currentTurn;
  runtime.reserve.splice(reserveIdx, 1);
  runtime.activeCompanionId = input.newCompanionId;

  // Cooldown
  runtime.recallCooldownRemaining = NpcConstants.COMPANION_RECALL_COOLDOWN_TURNS;

  return {
    outcome: 'swapped',
    oldCompanionId: oldId,
    threatTransferred: r.newCompanionThreat ?? 0,
  };
}

// ─────────────────────────────────────────────────────────
// Death / revive / recall
// ─────────────────────────────────────────────────────────

export function markCompanionDead(runtime: CompanionRuntime, companionId: string, currentTurn: number): boolean {
  if (runtime.activeCompanionId === companionId) {
    runtime.activeCompanionId = undefined;
    // Move to reserve as dead (for revive flow).
    runtime.reserve.push({
      companionId, ownerId: runtime.ownerId,
      state: 'dead', lastActiveTurn: currentTurn, deathTurn: currentTurn,
    });
    return true;
  }
  const inReserveIdx = runtime.reserve.findIndex((c) => c.companionId === companionId);
  if (inReserveIdx >= 0) {
    runtime.reserve[inReserveIdx]!.state = 'dead';
    runtime.reserve[inReserveIdx]!.deathTurn = currentTurn;
    return true;
  }
  const inPersistentIdx = runtime.persistent.findIndex((c) => c.companionId === companionId);
  if (inPersistentIdx >= 0) {
    runtime.persistent[inPersistentIdx]!.state = 'dead';
    runtime.persistent[inPersistentIdx]!.deathTurn = currentTurn;
    return true;
  }
  return false;
}

export function recallActiveCompanion(runtime: CompanionRuntime, currentTurn: number): boolean {
  const id = runtime.activeCompanionId;
  if (!id) return false;
  if (runtime.recallCooldownRemaining > 0) return false;
  runtime.activeCompanionId = undefined;
  runtime.persistent.push({
    companionId: id,
    ownerId: runtime.ownerId,
    state: 'recalled',
    lastActiveTurn: currentTurn,
  });
  runtime.recallCooldownRemaining = NpcConstants.COMPANION_RECALL_COOLDOWN_TURNS;
  return true;
}

// ─────────────────────────────────────────────────────────
// Tick — call per turn end
// ─────────────────────────────────────────────────────────

export function tickCompanionRuntime(runtime: CompanionRuntime, _currentTurn: number): void {
  if (runtime.recallCooldownRemaining > 0) runtime.recallCooldownRemaining -= 1;
}

// ─────────────────────────────────────────────────────────
// Snapshot / restore
// ─────────────────────────────────────────────────────────

export function snapshotCompanionRuntime(runtime: CompanionRuntime): CompanionRuntime {
  return {
    ownerId: runtime.ownerId,
    activeCompanionId: runtime.activeCompanionId,
    reserve: runtime.reserve.map((e) => ({ ...e })),
    persistent: runtime.persistent.map((e) => ({ ...e })),
    recallCooldownRemaining: runtime.recallCooldownRemaining,
  };
}

export function restoreCompanionRuntime(snap: CompanionRuntime): CompanionRuntime {
  return snapshotCompanionRuntime(snap);
}
