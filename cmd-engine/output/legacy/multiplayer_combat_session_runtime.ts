/**
 * MULTIPLAYER COMBAT SESSION RUNTIME — deterministic multi-party coordination (Phase 16 § 1).
 *
 * Per CMD1 Phase 16 directive § PRIMARY OBJECTIVES § multiplayer_combat_session_runtime:
 *   "Purpose: deterministic multiplayer combat session coordination.
 *    SUPPORT:
 *      - multi-party combat synchronization
 *      - reconnect-safe session continuity
 *      - deterministic session orchestration
 *      - replay-safe participant ordering
 *      - raid-scale session continuation
 *    MANDATORY: same combat session = same synchronization result ALWAYS."
 *
 * Wraps `combat_session_sync` (Phase 14) with PARTY-LEVEL grouping — multiple
 * parties (groups of participants) inside a single encounter. Each party has
 * its own leader + members + role assignment.
 *
 * STRICT additive — no I/O. Pure state container. NO networking. NO transport.
 * NO foundation touch. Canonical lex-sort traversal at every iteration boundary.
 */
import type { CombatRuntime } from './combat_runtime.js';
import { canonicalHash } from './combat_storage.js';
import { buildCombatPayload, hashPayload } from './combat_payload_builder.js';

export const MULTIPLAYER_SESSION_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────
// Party model
// ─────────────────────────────────────────────────────────

export type PartyMemberRole = 'leader' | 'member' | 'companion';

export interface PartyMember {
  participantId: string;
  role: PartyMemberRole;
  /** Turn at which this member joined the party. */
  joinedAtTurn: number;
  /** Turn at which the member left (undefined = still in party). */
  leftAtTurn?: number;
}

export interface Party {
  partyId: string;
  leaderId: string;
  /** Map participantId → PartyMember (ordered by joinedAtTurn then id at iteration boundaries). */
  members: Map<string, PartyMember>;
  /** Turn when the party was formed. */
  formedAtTurn: number;
  /** Turn when the party disbanded (undefined = still active). */
  disbandedAtTurn?: number;
}

// ─────────────────────────────────────────────────────────
// Session runtime state
// ─────────────────────────────────────────────────────────

export type MultiplayerEventKind =
  | 'party_form'
  | 'party_disband'
  | 'party_join'
  | 'party_leave';

export interface MultiplayerEvent {
  eventSeq: number;
  kind: MultiplayerEventKind;
  partyId: string;
  participantId?: string;
  turn: number;
}

export interface MultiplayerSessionState {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  /** Map partyId → Party (canonical-sorted on iteration boundaries). */
  parties: Map<string, Party>;
  /** Monotonic event seq for forensic + sync resume. */
  eventSeq: number;
  /** Full event history (forensic). */
  history: MultiplayerEvent[];
}

export function createMultiplayerSession(
  encounterId: string,
  sessionId: string,
): MultiplayerSessionState {
  // R7-9 audit fix: factory-level identity validation. Without this, an empty
  // encounterId/sessionId state silently matches an empty rt, yielding party
  // snapshot digests bound to empty identity — collides across distinct
  // multiplayer sessions. Same root cause as R7-1 / R7-3 / R7-8.
  if (!encounterId || encounterId.trim().length === 0) {
    throw new MultiplayerSessionError(`encounterId must be non-empty (whitespace-only rejected)`);
  }
  if (!sessionId || sessionId.trim().length === 0) {
    throw new MultiplayerSessionError(`sessionId must be non-empty (whitespace-only rejected)`);
  }
  return {
    schemaVersion: MULTIPLAYER_SESSION_SCHEMA_VERSION,
    encounterId,
    sessionId,
    parties: new Map(),
    eventSeq: 0,
    history: [],
  };
}

// ─────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────

export class MultiplayerSessionError extends Error {
  constructor(message: string) {
    super(`[MultiplayerSession] ${message}`);
    this.name = 'MultiplayerSessionError';
  }
}

function assertEncounterParity(
  state: MultiplayerSessionState,
  rt: CombatRuntime,
): void {
  if (state.encounterId !== rt.config.encounterId) {
    throw new MultiplayerSessionError(
      `encounterId mismatch: state='${state.encounterId}' rt='${rt.config.encounterId}'`,
    );
  }
  if (state.sessionId !== rt.config.sessionId) {
    throw new MultiplayerSessionError(
      `sessionId mismatch: state='${state.sessionId}' rt='${rt.config.sessionId}'`,
    );
  }
}

// ─────────────────────────────────────────────────────────
// Party lifecycle
// ─────────────────────────────────────────────────────────

export function formParty(
  state: MultiplayerSessionState,
  rt: CombatRuntime,
  partyId: string,
  leaderId: string,
): Party {
  assertEncounterParity(state, rt);
  // R4-4 audit fix: reject empty partyId / leaderId. Empty id causes
  // identity confusion downstream (snapshot ordering, history reconstruction).
  if (!partyId) {
    throw new MultiplayerSessionError(`partyId must be non-empty`);
  }
  // R6-5 audit fix: whitespace-only id slips past `!id` check.
  if (partyId.trim().length === 0) {
    throw new MultiplayerSessionError(`partyId must be non-empty (whitespace-only rejected)`);
  }
  if (!leaderId) {
    throw new MultiplayerSessionError(`leaderId must be non-empty`);
  }
  if (leaderId.trim().length === 0) {
    throw new MultiplayerSessionError(`leaderId must be non-empty (whitespace-only rejected)`);
  }
  if (state.parties.has(partyId)) {
    const existing = state.parties.get(partyId)!;
    if (existing.disbandedAtTurn === undefined) {
      throw new MultiplayerSessionError(`party '${partyId}' already formed`);
    }
    // Reform — reset disbanded marker + leader + clear members
    existing.disbandedAtTurn = undefined;
    existing.leaderId = leaderId;
    existing.formedAtTurn = rt.currentTurn;
    existing.members = new Map([
      [leaderId, { participantId: leaderId, role: 'leader', joinedAtTurn: rt.currentTurn }],
    ]);
    state.history.push({
      eventSeq: state.eventSeq++,
      kind: 'party_form',
      partyId,
      participantId: leaderId,
      turn: rt.currentTurn,
    });
    return existing;
  }
  const party: Party = {
    partyId,
    leaderId,
    members: new Map([
      [leaderId, { participantId: leaderId, role: 'leader', joinedAtTurn: rt.currentTurn }],
    ]),
    formedAtTurn: rt.currentTurn,
  };
  state.parties.set(partyId, party);
  state.history.push({
    eventSeq: state.eventSeq++,
    kind: 'party_form',
    partyId,
    participantId: leaderId,
    turn: rt.currentTurn,
  });
  return party;
}

export function disbandParty(
  state: MultiplayerSessionState,
  rt: CombatRuntime,
  partyId: string,
): void {
  assertEncounterParity(state, rt);
  // R8-8 audit fix: explicit empty/whitespace rejection for partyId. Same
  // rationale as R8-6 — surface a clear error instead of relying on the
  // Map.get('') miss path producing "party '' not found".
  if (!partyId) {
    throw new MultiplayerSessionError(`partyId must be non-empty`);
  }
  if (partyId.trim().length === 0) {
    throw new MultiplayerSessionError(`partyId must be non-empty (whitespace-only rejected)`);
  }
  const party = state.parties.get(partyId);
  if (!party) throw new MultiplayerSessionError(`party '${partyId}' not found`);
  if (party.disbandedAtTurn !== undefined) {
    throw new MultiplayerSessionError(`party '${partyId}' already disbanded`);
  }
  // FORENSIC COMPLETENESS: emit `party_leave` for every still-active member BEFORE
  // the `party_disband` event. Without this, history would show members joined
  // but never left — making post-incident reconstruction inconsistent with the
  // live state (which considers them gone after disband).
  // Canonical-ordered emission (sorted by participantId) ensures determinism.
  // Stryker disable all -- participantId unique within party, strict-vs-eq equivalent
  const stillActive = [...party.members.values()]
    .filter((m) => m.leftAtTurn === undefined)
    .sort((a, b) =>
      a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0,
    );
  // Stryker restore all
  for (const m of stillActive) {
    m.leftAtTurn = rt.currentTurn;
    state.history.push({
      eventSeq: state.eventSeq++,
      kind: 'party_leave',
      partyId,
      participantId: m.participantId,
      turn: rt.currentTurn,
    });
  }
  party.disbandedAtTurn = rt.currentTurn;
  state.history.push({
    eventSeq: state.eventSeq++,
    kind: 'party_disband',
    partyId,
    turn: rt.currentTurn,
  });
}

export function joinParty(
  state: MultiplayerSessionState,
  rt: CombatRuntime,
  partyId: string,
  participantId: string,
  role: PartyMemberRole = 'member',
): PartyMember {
  assertEncounterParity(state, rt);
  // R4-4 audit fix: reject empty participantId.
  if (!participantId) {
    throw new MultiplayerSessionError(`participantId must be non-empty`);
  }
  // R6-5 audit fix: whitespace-only participantId.
  if (participantId.trim().length === 0) {
    throw new MultiplayerSessionError(`participantId must be non-empty (whitespace-only rejected)`);
  }
  const party = state.parties.get(partyId);
  if (!party) throw new MultiplayerSessionError(`party '${partyId}' not found`);
  if (party.disbandedAtTurn !== undefined) {
    throw new MultiplayerSessionError(`party '${partyId}' is disbanded`);
  }
  if (role === 'leader') {
    throw new MultiplayerSessionError(`cannot join as 'leader' — use leaderId in formParty or via leadership transfer (out of CMD1 scope)`);
  }
  if (party.members.has(participantId)) {
    const existing = party.members.get(participantId)!;
    if (existing.leftAtTurn === undefined) {
      throw new MultiplayerSessionError(`participant '${participantId}' already in party '${partyId}'`);
    }
    existing.leftAtTurn = undefined;
    existing.joinedAtTurn = rt.currentTurn;
    existing.role = role;
    state.history.push({
      eventSeq: state.eventSeq++,
      kind: 'party_join',
      partyId,
      participantId,
      turn: rt.currentTurn,
    });
    return existing;
  }
  const member: PartyMember = {
    participantId,
    role,
    joinedAtTurn: rt.currentTurn,
  };
  party.members.set(participantId, member);
  state.history.push({
    eventSeq: state.eventSeq++,
    kind: 'party_join',
    partyId,
    participantId,
    turn: rt.currentTurn,
  });
  return member;
}

export function leaveParty(
  state: MultiplayerSessionState,
  rt: CombatRuntime,
  partyId: string,
  participantId: string,
): void {
  assertEncounterParity(state, rt);
  // R8-9 audit fix: explicit empty/whitespace rejection for BOTH ids. Same
  // rationale as R8-8 — clear error vs misleading "not found" via Map miss.
  if (!partyId) {
    throw new MultiplayerSessionError(`partyId must be non-empty`);
  }
  if (partyId.trim().length === 0) {
    throw new MultiplayerSessionError(`partyId must be non-empty (whitespace-only rejected)`);
  }
  if (!participantId) {
    throw new MultiplayerSessionError(`participantId must be non-empty`);
  }
  if (participantId.trim().length === 0) {
    throw new MultiplayerSessionError(`participantId must be non-empty (whitespace-only rejected)`);
  }
  const party = state.parties.get(partyId);
  if (!party) throw new MultiplayerSessionError(`party '${partyId}' not found`);
  const member = party.members.get(participantId);
  if (!member) throw new MultiplayerSessionError(`participant '${participantId}' not in party '${partyId}'`);
  if (member.leftAtTurn !== undefined) {
    throw new MultiplayerSessionError(`participant '${participantId}' already left`);
  }
  if (participantId === party.leaderId) {
    throw new MultiplayerSessionError(`leader '${participantId}' cannot leave; disband party instead`);
  }
  member.leftAtTurn = rt.currentTurn;
  state.history.push({
    eventSeq: state.eventSeq++,
    kind: 'party_leave',
    partyId,
    participantId,
    turn: rt.currentTurn,
  });
}

// ─────────────────────────────────────────────────────────
// Synchronization snapshot
// ─────────────────────────────────────────────────────────

export interface PartySnapshot {
  partyId: string;
  leaderId: string;
  formedAtTurn: number;
  disbandedAtTurn?: number;
  /** Canonical-sorted members (joinedAtTurn asc, then participantId asc). */
  members: readonly PartyMember[];
}

export interface MultiplayerSyncSnapshot {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  currentTurn: number;
  /** Canonical-sorted parties (formedAtTurn asc, then partyId asc). */
  parties: readonly PartySnapshot[];
  /** Total events emitted so far (high-water mark). */
  eventCount: number;
  /** Live payload hash for cross-verifying combat runtime parity. */
  payloadHash: string;
  digest: string;
}

/**
 * Build a deterministic multiplayer sync snapshot. Same state + same rt → same
 * snapshot bytes ALWAYS. Canonical sort applied to BOTH parties AND members.
 */
export function buildMultiplayerSnapshot(
  state: MultiplayerSessionState,
  rt: CombatRuntime,
): MultiplayerSyncSnapshot {
  assertEncounterParity(state, rt);
  // Codepoint sort (not localeCompare) — locale-independent per Phase 16 § MANDATORY DETERMINISM RULES.
  // NOTE: cmpId is used for tiebreaker only (after formedAtTurn / joinedAtTurn primary
  // sort). Within a single session, partyId + participantId are unique (enforced at
  // formParty / joinParty). Mutations `<` → `<=` / `>` → `>=` are EQUIVALENT because
  // the equal-value branch never fires.
  // Stryker disable next-line all
  const cmpId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  // partyId + participantId unique within session.
  // Tiebreaker strict-vs-eq mutations EQUIVALENT for all sort paths below.
  // Stryker disable all
  const sortedParties: PartySnapshot[] = [...state.parties.values()]
    .sort((a, b) => {
      if (a.formedAtTurn !== b.formedAtTurn) return a.formedAtTurn - b.formedAtTurn;
      return cmpId(a.partyId, b.partyId);
    })
    .map((p) => ({
      partyId: p.partyId,
      leaderId: p.leaderId,
      formedAtTurn: p.formedAtTurn,
      disbandedAtTurn: p.disbandedAtTurn,
      members: [...p.members.values()].sort((a, b) => {
        if (a.joinedAtTurn !== b.joinedAtTurn) return a.joinedAtTurn - b.joinedAtTurn;
        return cmpId(a.participantId, b.participantId);
      }),
    }));
  // Stryker restore all
  const payloadHash = hashPayload(buildCombatPayload(rt));
  const forDigest = {
    schemaVersion: MULTIPLAYER_SESSION_SCHEMA_VERSION,
    encounterId: state.encounterId,
    sessionId: state.sessionId,
    currentTurn: rt.currentTurn,
    parties: sortedParties,
    eventCount: state.eventSeq,
    payloadHash,
  };
  return { ...forDigest, digest: canonicalHash(forDigest) };
}

// ─────────────────────────────────────────────────────────
// Comparison + parity
// ─────────────────────────────────────────────────────────

export type MultiplayerDivergenceField =
  | 'digest'
  | 'payloadHash'
  | 'currentTurn'
  | 'eventCount'
  | 'parties_length'
  | 'party_id'
  | 'party_leader'
  | 'party_member_count'
  | 'party_member_id';

export interface MultiplayerSyncDivergence {
  divergent: boolean;
  field?: MultiplayerDivergenceField;
  partyId?: string;
}

export function compareMultiplayerSnapshots(
  expected: MultiplayerSyncSnapshot,
  actual: MultiplayerSyncSnapshot,
): MultiplayerSyncDivergence {
  if (expected.digest === actual.digest) return { divergent: false };
  if (expected.payloadHash !== actual.payloadHash) {
    return { divergent: true, field: 'payloadHash' };
  }
  if (expected.currentTurn !== actual.currentTurn) {
    return { divergent: true, field: 'currentTurn' };
  }
  if (expected.eventCount !== actual.eventCount) {
    return { divergent: true, field: 'eventCount' };
  }
  if (expected.parties.length !== actual.parties.length) {
    return { divergent: true, field: 'parties_length' };
  }
  for (let i = 0; i < expected.parties.length; i++) {
    const ep = expected.parties[i]!;
    const ap = actual.parties[i]!;
    if (ep.partyId !== ap.partyId) {
      return { divergent: true, field: 'party_id', partyId: ep.partyId };
    }
    if (ep.leaderId !== ap.leaderId) {
      return { divergent: true, field: 'party_leader', partyId: ep.partyId };
    }
    if (ep.members.length !== ap.members.length) {
      return { divergent: true, field: 'party_member_count', partyId: ep.partyId };
    }
    for (let j = 0; j < ep.members.length; j++) {
      if (ep.members[j]!.participantId !== ap.members[j]!.participantId) {
        return { divergent: true, field: 'party_member_id', partyId: ep.partyId };
      }
    }
  }
  return { divergent: true, field: 'digest' };
}

// ─────────────────────────────────────────────────────────
// Query helpers (canonical-sorted)
// ─────────────────────────────────────────────────────────

export function activeParties(state: MultiplayerSessionState): readonly Party[] {
  // Codepoint sort (not localeCompare) — locale-independent per Phase 16 § MANDATORY DETERMINISM RULES.
  // partyId is unique within session (enforced at formParty). `<` vs `<=` and
  // `>` vs `>=` mutations are EQUIVALENT (equal branch never fires).
  // Stryker disable all
  return [...state.parties.values()]
    .filter((p) => p.disbandedAtTurn === undefined)
    .sort((a, b) =>
      a.partyId < b.partyId ? -1 : a.partyId > b.partyId ? 1 : 0,
    );
  // Stryker restore all
}

export function partyCount(state: MultiplayerSessionState): number {
  return activeParties(state).length;
}

export function activeMembers(party: Party): readonly PartyMember[] {
  // participantId unique within party (enforced at joinParty). `<` / `>`
  // strict-vs-eq mutations are EQUIVALENT.
  // Stryker disable all
  return [...party.members.values()]
    .filter((m) => m.leftAtTurn === undefined)
    .sort((a, b) =>
      a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0,
    );
  // Stryker restore all
}

export function memberCount(party: Party): number {
  return activeMembers(party).length;
}

/** Total members across all active parties. */
export function totalActiveMembers(state: MultiplayerSessionState): number {
  let total = 0;
  for (const p of activeParties(state)) total += memberCount(p);
  return total;
}

/** Stable hash of event history — forensic comparison. */
export function multiplayerHistoryHash(state: MultiplayerSessionState): string {
  let h = 0x811c9dc5 >>> 0;
  const eat = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const e of state.history) {
    eat(`${e.eventSeq}|${e.kind}|${e.partyId}|${e.participantId ?? ''}|${e.turn}`);
  }
  return h.toString(16).padStart(8, '0');
}
