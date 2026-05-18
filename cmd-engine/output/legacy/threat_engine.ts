/**
 * THREAT ENGINE — Phase 4 top-level orchestration.
 *
 * Tie pieces:
 *   - Table (per encounter) — pure threat_table helpers
 *   - Modifier registry — role/tag-based mult
 *   - Heal threat — dedicated coef
 *   - Decay — turn-end sweep
 *   - Taunt — forced target apply
 *   - Resolver — 6-mode target selection
 *
 * State owner: caller (encounter manager) holds Map<encounterId, ThreatEngineState>.
 * Engine is stateless — pure functions over state references.
 */
import type { Role } from './types.js';
import type {
  ThreatEntryV2,
  TauntStateEntry,
  ThreatActionInput,
  ThreatGenerationSource,
  TargetResolveContext,
  TargetResolveResult,
} from './threat_types.js';
import type { RNG } from './rng.js';
import {
  getOrCreateEntry,
  addThreatToEntry,
  snapshotTable,
  restoreTable,
  clearTable,
  dropAttacker,
} from './threat_table.js';
import { threatModifierRegistry } from './threat_modifier.js';
import { calcSourceThreatDelta } from './heal_threat.js';
import { decayAll, type DecayOptions } from './threat_decay.js';
import { applyTaunt, type TauntApplyResult, type TauntApplyInput } from './taunt_system.js';
import { resolveTarget } from './threat_resolver.js';
import { ThreatConstants } from './threat_constants.js';

/** Coefficient lookup per source. Pure dispatch (no if-switch on string). */
const COEF_BY_SOURCE: Record<ThreatGenerationSource, number> = {
  damage:  ThreatConstants.THREAT_COEF_DAMAGE_BP,
  heal:    ThreatConstants.THREAT_COEF_HEAL_BP,
  shield:  ThreatConstants.THREAT_COEF_SHIELD_BP,
  taunt:   ThreatConstants.THREAT_COEF_TAUNT_BP,
  passive: ThreatConstants.THREAT_COEF_PASSIVE_BP,
  summon:  ThreatConstants.THREAT_COEF_SUMMON_BP,
  dot:     ThreatConstants.THREAT_COEF_DOT_BP,
  hot:     ThreatConstants.THREAT_COEF_HOT_BP,
};

/** Per-encounter threat state. Caller owns. */
export interface ThreatEngineState {
  encounterId: string;
  table: Map<string, ThreatEntryV2>;
  taunt?: TauntStateEntry;
  currentTargetId?: string;
}

export function createThreatEngineState(encounterId: string): ThreatEngineState {
  return { encounterId, table: new Map(), currentTargetId: undefined };
}

export interface ApplyThreatResult {
  delta: number;
  totalThreat: number;
  spike: boolean;
  forcedTaunt: boolean;
}

/**
 * Apply 1 threat action. Mutates state.table. Returns delta + summary.
 *
 * NOTE: Spike + forcedTaunt are HINTS — caller decides whether to mutate spikeUntilTurn.
 */
export function applyThreatAction(
  state: ThreatEngineState,
  attackerId: string,
  attackerRole: Role,
  attackerTags: readonly string[],
  action: ThreatActionInput,
  currentTurn: number,
): ApplyThreatResult {
  const coefBP = COEF_BY_SOURCE[action.source];
  const roleModBP = threatModifierRegistry.resolveMultBP(attackerRole, attackerTags, action.source);
  const delta = calcSourceThreatDelta(action.amount, coefBP, roleModBP);

  const entry = getOrCreateEntry(state.table, attackerId, currentTurn);
  addThreatToEntry(entry, delta);
  entry.lastActionTurn = currentTurn;

  let spike = false;
  if (action.isCrit && action.source === 'damage') {
    entry.spikeUntilTurn = currentTurn + 2;
    spike = true;
  }

  // Summon owner propagation
  if (action.source === 'summon' && action.summonOwnerId) {
    const ownerEntry = getOrCreateEntry(state.table, action.summonOwnerId, currentTurn);
    const propagateDelta = Math.floor((delta * ThreatConstants.SUMMON_OWNER_THREAT_PROPAGATE_BP) / 10000);
    addThreatToEntry(ownerEntry, propagateDelta);
    ownerEntry.lastActionTurn = currentTurn;
  }

  return {
    delta,
    totalThreat: entry.threat,
    spike,
    forcedTaunt: state.taunt?.forcedSourceId === attackerId,
  };
}

/**
 * Apply taunt — wraps taunt_system.applyTaunt + writes state.taunt.
 */
export function applyTauntAction(
  state: ThreatEngineState,
  input: TauntApplyInput,
  currentTurn: number,
  rng: RNG,
): TauntApplyResult {
  const result = applyTaunt(state.taunt, input, currentTurn, rng);
  if (result.state) {
    state.taunt = result.state;
  }
  return result;
}

/** Decay sweep — call at turn end. */
export function tickDecay(
  state: ThreatEngineState,
  currentTurn: number,
  opts: DecayOptions = {},
): number {
  return decayAll(state.table, currentTurn, opts);
}

/** Resolve current target — caller invokes after decay. Also updates state.currentTargetId. */
export function resolveAndCommitTarget(
  state: ThreatEngineState,
  ctx: TargetResolveContext,
): TargetResolveResult {
  const r = resolveTarget(
    { table: state.table, taunt: state.taunt, currentTargetId: state.currentTargetId },
    ctx,
  );
  if (r.targetId) state.currentTargetId = r.targetId;
  return r;
}

/** Drop attacker entry (entity died/left). */
export function dropFromEngine(state: ThreatEngineState, attackerId: string): boolean {
  return dropAttacker(state.table, attackerId);
}

/** Snapshot entire engine state for replay. */
export function snapshotEngine(state: ThreatEngineState): {
  encounterId: string;
  table: ThreatEntryV2[];
  taunt?: TauntStateEntry;
  currentTargetId?: string;
} {
  return {
    encounterId: state.encounterId,
    table: snapshotTable(state.table),
    taunt: state.taunt ? { ...state.taunt } : undefined,
    currentTargetId: state.currentTargetId,
  };
}

/** Restore engine from snapshot. */
export function restoreEngine(snap: ReturnType<typeof snapshotEngine>): ThreatEngineState {
  return {
    encounterId: snap.encounterId,
    table: restoreTable(snap.table),
    taunt: snap.taunt ? { ...snap.taunt } : undefined,
    currentTargetId: snap.currentTargetId,
  };
}

/** Encounter end cleanup. */
export function endThreatEncounter(state: ThreatEngineState): { entriesRemoved: number } {
  const n = clearTable(state.table);
  state.taunt = undefined;
  state.currentTargetId = undefined;
  return { entriesRemoved: n };
}
