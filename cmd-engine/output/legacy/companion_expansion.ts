/**
 * COMPANION EXPANSION — Phase 6 first-class entity behaviors.
 *
 * Extends companion_runtime with:
 *   - revive policy (cooldown + cost + condition predicates)
 *   - owner-follow logic (companion repositions near owner each turn)
 *   - companion leash (snap-back when too far from owner)
 *   - AI assist (auto-cast helper — picks supportive action based on owner intent)
 *
 * STRICT per CMD1.docx: companion remains FIRST-CLASS combat entity, NOT cosmetic pet.
 * All logic is deterministic + replay-safe. Caller passes rng_ai substream for AI choices.
 *
 * Pure helpers — caller mutates companion_runtime state via existing companion_runtime API.
 */
import { z } from 'zod';
import type { CompanionRuntime, CompanionEntry } from './companion_runtime.js';
import type { Position } from './spatial_threat.js';
import type { SpatialLayerState } from './spatial_layer.js';
import { setPosition, getPosition } from './spatial_layer.js';
import { chebyshevDistance } from './spatial_threat.js';
import type { RNG } from './rng.js';

// ─────────────────────────────────────────────────────────
// Revive policy
// ─────────────────────────────────────────────────────────

export const REVIVE_DEFAULT_COOLDOWN_TURNS = 8 as const;
export const REVIVE_DEFAULT_HP_RATIO_BP = 5000 as const;     // 50% HP

export const RevivePolicyKindSchema = z.enum([
  'never',                  // no auto-revive
  'manual_only',            // owner spends resource
  'cooldown_auto',          // auto revive after N turns
  'on_phase_transition',    // revive when boss enters new phase
  'on_owner_revive',        // chain revive — owner res → companion res
]);
export type RevivePolicyKind = z.infer<typeof RevivePolicyKindSchema>;

export const RevivePolicySchema = z.object({
  kind: RevivePolicyKindSchema,
  cooldownTurns: z.number().int().nonnegative().default(REVIVE_DEFAULT_COOLDOWN_TURNS),
  reviveHpRatioBP: z.number().int().min(1).max(10000).default(REVIVE_DEFAULT_HP_RATIO_BP),
  /** Cost in mana / resource for manual revive. */
  manualCost: z.number().int().nonnegative().default(0),
});
export type RevivePolicy = z.infer<typeof RevivePolicySchema>;

export interface ReviveEligibility {
  eligible: boolean;
  reason?: string;
  /** Turn after which revive becomes available (for cooldown_auto). */
  earliestTurn?: number;
}

export interface ReviveQuery {
  companionId: string;
  currentTurn: number;
  bossPhaseTransitioned?: boolean;
  ownerRevivedThisTurn?: boolean;
  ownerResourceAvailable?: number;
}

export function isReviveEligible(
  runtime: CompanionRuntime,
  policy: RevivePolicy,
  query: ReviveQuery,
): ReviveEligibility {
  if (policy.kind === 'never') {
    return { eligible: false, reason: 'policy_never' };
  }

  const entry = findEntry(runtime, query.companionId);
  if (!entry) return { eligible: false, reason: 'companion_not_found' };
  if (entry.state !== 'dead') return { eligible: false, reason: 'not_dead' };
  if (entry.deathTurn === undefined) return { eligible: false, reason: 'death_turn_missing' };

  switch (policy.kind) {
    case 'manual_only':
      if ((query.ownerResourceAvailable ?? 0) < policy.manualCost) {
        return { eligible: false, reason: 'insufficient_resource' };
      }
      return { eligible: true };
    case 'cooldown_auto': {
      const ready = entry.deathTurn + policy.cooldownTurns;
      if (query.currentTurn < ready) {
        return { eligible: false, reason: 'cooldown', earliestTurn: ready };
      }
      return { eligible: true, earliestTurn: ready };
    }
    case 'on_phase_transition':
      if (!query.bossPhaseTransitioned) return { eligible: false, reason: 'no_phase_transition' };
      return { eligible: true };
    case 'on_owner_revive':
      if (!query.ownerRevivedThisTurn) return { eligible: false, reason: 'owner_not_revived' };
      return { eligible: true };
  }
}

export interface ReviveResult {
  applied: boolean;
  companionId: string;
  hpRestored: number;
  reason?: string;
}

/**
 * Apply revive — moves dead → reserve, restores HP per policy.
 * Caller is responsible for actually setting entity HP via combat_entity API.
 */
export function applyRevive(
  runtime: CompanionRuntime,
  policy: RevivePolicy,
  companionId: string,
  maxHp: number,
  currentTurn: number,
): ReviveResult {
  const entry = findEntry(runtime, companionId);
  if (!entry) return { applied: false, companionId, hpRestored: 0, reason: 'not_found' };
  if (entry.state !== 'dead') {
    return { applied: false, companionId, hpRestored: 0, reason: 'not_dead' };
  }
  entry.state = 'reserve';
  entry.deathTurn = undefined;
  entry.lastActiveTurn = currentTurn;
  const hpRestored = Math.floor((maxHp * policy.reviveHpRatioBP) / 10000);
  return { applied: true, companionId, hpRestored };
}

// ─────────────────────────────────────────────────────────
// Owner-follow + leash
// ─────────────────────────────────────────────────────────

export const COMPANION_LEASH_DEFAULT_DISTANCE = 6 as const;
export const COMPANION_FOLLOW_DEFAULT_RADIUS = 3 as const;

export interface CompanionFollowPolicy {
  /** Max distance companion may stray from owner before leash triggers. */
  leashDistance: number;
  /** Desired distance — companion will reposition to within this. */
  followRadius: number;
  /** Follow active outside combat only? Defaults true. */
  outOfCombatOnly: boolean;
}

export const DEFAULT_FOLLOW_POLICY: CompanionFollowPolicy = {
  leashDistance: COMPANION_LEASH_DEFAULT_DISTANCE,
  followRadius: COMPANION_FOLLOW_DEFAULT_RADIUS,
  outOfCombatOnly: false,
};

export interface FollowTickInput {
  ownerEntityId: string;
  companionEntityId: string;
  layer: SpatialLayerState;
  policy: CompanionFollowPolicy;
  inCombat: boolean;
}

export type FollowOutcome =
  | 'no_op'
  | 'moved_closer'
  | 'leashed_snap';

export interface FollowResult {
  outcome: FollowOutcome;
  from?: Position;
  to?: Position;
  distance: number;
}

/**
 * Tick owner-follow. Deterministic — picks the closest grid cell within followRadius
 * of owner that is currently free.
 *
 * Leash: if distance > leashDistance, snap to ownerPos + (1, 0) directly.
 */
export function tickOwnerFollow(input: FollowTickInput): FollowResult {
  const ownerPos = getPosition(input.layer, input.ownerEntityId);
  const compPos = getPosition(input.layer, input.companionEntityId);
  if (!ownerPos || !compPos) {
    return { outcome: 'no_op', distance: 0 };
  }
  if (input.policy.outOfCombatOnly && input.inCombat) {
    return { outcome: 'no_op', distance: chebyshevDistance(ownerPos, compPos) };
  }

  const d = chebyshevDistance(ownerPos, compPos);
  if (d <= input.policy.followRadius) {
    return { outcome: 'no_op', from: compPos, to: compPos, distance: d };
  }

  // Leash: snap if exceeded
  if (d > input.policy.leashDistance) {
    const target: Position = { x: ownerPos.x + 1, y: ownerPos.y };
    if (!isOccupied(input.layer, target, input.companionEntityId)) {
      setPosition(input.layer, input.companionEntityId, target);
      return { outcome: 'leashed_snap', from: compPos, to: target, distance: 1 };
    }
    // Fallback: scan adjacent
    const alt = findFreeAdjacent(input.layer, ownerPos, input.companionEntityId);
    if (alt) {
      setPosition(input.layer, input.companionEntityId, alt);
      return { outcome: 'leashed_snap', from: compPos, to: alt, distance: chebyshevDistance(ownerPos, alt) };
    }
    return { outcome: 'no_op', from: compPos, to: compPos, distance: d };
  }

  // Step toward owner by 1 cell (king move).
  const next: Position = {
    x: compPos.x + Math.sign(ownerPos.x - compPos.x),
    y: compPos.y + Math.sign(ownerPos.y - compPos.y),
  };
  if (!isOccupied(input.layer, next, input.companionEntityId)) {
    setPosition(input.layer, input.companionEntityId, next);
    return {
      outcome: 'moved_closer',
      from: compPos,
      to: next,
      distance: chebyshevDistance(ownerPos, next),
    };
  }
  return { outcome: 'no_op', from: compPos, to: compPos, distance: d };
}

function isOccupied(layer: SpatialLayerState, cell: Position, exceptId: string): boolean {
  for (const [id, pos] of layer.positions) {
    if (id === exceptId) continue;
    if (pos.x === cell.x && pos.y === cell.y) return true;
  }
  return false;
}

function findFreeAdjacent(
  layer: SpatialLayerState,
  center: Position,
  exceptId: string,
): Position | undefined {
  const offsets: Array<[number, number]> = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];
  for (const [dx, dy] of offsets) {
    const cand: Position = { x: center.x + dx, y: center.y + dy };
    if (!isOccupied(layer, cand, exceptId)) return cand;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────
// AI assist — auto-pick supportive action
// ─────────────────────────────────────────────────────────

export const OwnerIntentSchema = z.enum([
  'attack_target',     // focus damage on owner's target
  'defend_owner',      // pull threat, shield owner
  'heal_owner',        // prioritize heal/cleanse owner
  'control_target',    // status / cc owner's target
  'free_roam',         // no specific intent
]);
export type OwnerIntent = z.infer<typeof OwnerIntentSchema>;

export const COMPANION_ROLE_HINT_KEYS = [
  'role_dps',
  'role_tank',
  'role_healer',
  'role_support',
  'role_control',
] as const;
export type CompanionRoleHint = (typeof COMPANION_ROLE_HINT_KEYS)[number];

export interface AssistInput {
  intent: OwnerIntent;
  roleHint: CompanionRoleHint;
  /** Companion's known skill ids. */
  skillIds: readonly string[];
  /** Predicate — is this skill on cooldown? */
  isOnCooldown: (skillId: string) => boolean;
  /** Optional skill role tag lookup. Returns 'heal' / 'damage' / 'shield' / 'cc' / etc. */
  skillRoleOf: (skillId: string) => string;
  /** RNG (rng_ai substream) — used only for tiebreak among eligible skills. */
  rng: RNG;
}

export interface AssistDecision {
  skillId?: string;
  reason: string;
}

/**
 * Pick a supportive action consistent with owner intent + companion role.
 *
 * Decision matrix (data-driven, no hardcoded boss/skill ids):
 *   intent=heal_owner    → prefer heal/shield skills off cooldown
 *   intent=defend_owner  → prefer shield/taunt skills off cooldown
 *   intent=control_target→ prefer cc/status skills off cooldown
 *   intent=attack_target → prefer damage skills off cooldown
 *   intent=free_roam     → role-default (healer→heal, tank→shield, dps→damage)
 *
 * Tie-break: deterministic RNG pick among same-priority candidates.
 */
export function pickAssistAction(input: AssistInput): AssistDecision {
  const wants = intentToWantedRoles(input.intent, input.roleHint);
  const eligible: string[] = [];
  for (const skillId of input.skillIds) {
    if (input.isOnCooldown(skillId)) continue;
    const role = input.skillRoleOf(skillId);
    if (wants.includes(role)) eligible.push(skillId);
  }
  if (eligible.length === 0) {
    return { reason: 'no_eligible_skill' };
  }
  eligible.sort();      // deterministic base order
  const idx = Math.floor(input.rng() * eligible.length);
  const safeIdx = Math.max(0, Math.min(idx, eligible.length - 1));
  return { skillId: eligible[safeIdx], reason: `assist_${input.intent}` };
}

function intentToWantedRoles(intent: OwnerIntent, roleHint: CompanionRoleHint): string[] {
  switch (intent) {
    case 'heal_owner':    return ['heal', 'shield', 'cleanse'];
    case 'defend_owner':  return ['shield', 'taunt', 'block'];
    case 'control_target':return ['cc', 'status', 'silence', 'root'];
    case 'attack_target': return ['damage', 'pierce', 'burst'];
    case 'free_roam':
      // Role-default fallback
      switch (roleHint) {
        case 'role_healer':  return ['heal', 'shield', 'cleanse'];
        case 'role_tank':    return ['shield', 'taunt', 'block'];
        case 'role_control': return ['cc', 'status', 'silence', 'root'];
        case 'role_support': return ['buff', 'shield', 'cleanse'];
        case 'role_dps':     return ['damage', 'pierce', 'burst'];
      }
  }
}

// ─────────────────────────────────────────────────────────
// Lookup helper
// ─────────────────────────────────────────────────────────

function findEntry(runtime: CompanionRuntime, companionId: string): CompanionEntry | undefined {
  if (runtime.activeCompanionId === companionId) {
    return undefined;     // active entries do not live in reserve/persistent
  }
  const inReserve = runtime.reserve.find((e) => e.companionId === companionId);
  if (inReserve) return inReserve;
  return runtime.persistent.find((e) => e.companionId === companionId);
}
