/**
 * COMBAT SESSION SYNC — encounter-level session synchronization (Phase 14 § 2).
 *
 * Per CMD1 1.docx Phase 14 § 2:
 *   "Purpose: combat session synchronization layer.
 *    SUPPORT:
 *      - reconnect session resume
 *      - spectator session attach/detach
 *      - deterministic session snapshot
 *      - replay-linked sync state
 *    VERIFY: same combat state = same sync snapshot ALWAYS."
 *
 * Tracks per-encounter session membership (participants + roles), produces
 * deterministic sync snapshots for network broadcast, restores membership
 * from snapshot on reconnect.
 *
 * STRICT additive — pure state container. No I/O. No combat math changes.
 * Reuses `reconnectRestore` (Phase 13) for runtime restore + `wrapSyncSnapshotPacket`
 * (Phase 14 § 1) for wire packaging.
 */
import type { CombatRuntime } from './combat_runtime.js';
import { buildCombatPayload, hashPayload } from './combat_payload_builder.js';
import { canonicalHash } from './combat_storage.js';
import {
  reconnectRestore,
  verifyIdentityParity,
  type ReconnectRestoreResult,
} from './reconnect_restore.js';
import type { CombatStorage } from './combat_storage.js';

export const SESSION_SYNC_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────
// Participant model
// ─────────────────────────────────────────────────────────

export type ParticipantRole = 'player' | 'companion' | 'spectator' | 'replay_observer';

export interface Participant {
  /** Unique id within the session (player_42, observer_77, ...). */
  participantId: string;
  role: ParticipantRole;
  /** Turn the participant attached at (for forensic). */
  attachedAtTurn: number;
  /** Optional detach turn (undefined = still attached). */
  detachedAtTurn?: number;
}

// ─────────────────────────────────────────────────────────
// Sync state
// ─────────────────────────────────────────────────────────

export interface SessionSyncState {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  /** Map participantId → Participant (ordered by attach time). */
  participants: Map<string, Participant>;
  /** Monotonic event seq within this session sync layer (attach/detach). */
  syncEventSeq: number;
  /** History of attach/detach events for forensic. */
  history: SessionSyncEvent[];
}

export type SessionSyncEventKind = 'attach' | 'detach';

export interface SessionSyncEvent {
  eventSeq: number;
  kind: SessionSyncEventKind;
  participantId: string;
  role: ParticipantRole;
  turn: number;
}

export function createSessionSync(
  encounterId: string,
  sessionId: string,
): SessionSyncState {
  // R7-8 audit fix: validate identity at factory boundary. Empty/whitespace
  // IDs silently match an rt also constructed with empty IDs → digests bind
  // empty identity → cross-encounter snapshot collision. Same root cause as
  // R7-1 / R7-3.
  if (!encounterId || encounterId.trim().length === 0) {
    throw new SessionSyncError(`encounterId must be non-empty (whitespace-only rejected)`);
  }
  if (!sessionId || sessionId.trim().length === 0) {
    throw new SessionSyncError(`sessionId must be non-empty (whitespace-only rejected)`);
  }
  return {
    schemaVersion: SESSION_SYNC_SCHEMA_VERSION,
    encounterId,
    sessionId,
    participants: new Map(),
    syncEventSeq: 0,
    history: [],
  };
}

// ─────────────────────────────────────────────────────────
// Attach / detach
// ─────────────────────────────────────────────────────────

export class SessionSyncError extends Error {
  constructor(message: string) {
    super(`[SessionSync] ${message}`);
    this.name = 'SessionSyncError';
  }
}

export function attachParticipant(
  state: SessionSyncState,
  rt: CombatRuntime,
  participantId: string,
  role: ParticipantRole,
): Participant {
  if (state.encounterId !== rt.config.encounterId) {
    throw new SessionSyncError(`encounterId mismatch: state='${state.encounterId}' rt='${rt.config.encounterId}'`);
  }
  // R3-1 audit fix: sessionId guard. Without this, attach would record events
  // with rt.currentTurn from a different session timeline → silent inconsistency.
  if (state.sessionId !== rt.config.sessionId) {
    throw new SessionSyncError(`sessionId mismatch: state='${state.sessionId}' rt='${rt.config.sessionId}'`);
  }
  // R4-4 audit fix: reject empty participantId — matches input projection's
  // existing `empty_originator` rejection. Empty id causes identity confusion
  // downstream (filters, snapshot ordering).
  if (!participantId) {
    throw new SessionSyncError(`participantId must be non-empty`);
  }
  // R6-5 audit fix: reject whitespace-only participantId (would pass !id check
  // but still cause silent identity confusion in canonical sort/snapshot).
  if (participantId.trim().length === 0) {
    throw new SessionSyncError(`participantId must be non-empty (whitespace-only rejected)`);
  }
  if (state.participants.has(participantId)) {
    const existing = state.participants.get(participantId)!;
    if (existing.detachedAtTurn === undefined) {
      throw new SessionSyncError(`participant '${participantId}' already attached`);
    }
    // Re-attach scenario: reset detach
    existing.detachedAtTurn = undefined;
    existing.attachedAtTurn = rt.currentTurn;
    existing.role = role;
    state.history.push({
      eventSeq: state.syncEventSeq++,
      kind: 'attach',
      participantId,
      role,
      turn: rt.currentTurn,
    });
    return existing;
  }
  const p: Participant = {
    participantId,
    role,
    attachedAtTurn: rt.currentTurn,
  };
  state.participants.set(participantId, p);
  state.history.push({
    eventSeq: state.syncEventSeq++,
    kind: 'attach',
    participantId,
    role,
    turn: rt.currentTurn,
  });
  return p;
}

export function detachParticipant(
  state: SessionSyncState,
  rt: CombatRuntime,
  participantId: string,
): void {
  // R3-1 audit fix: encounter + session parity guard. Previously detach used
  // rt.currentTurn without any guard — wrong rt would inject wrong-session timestamp.
  if (state.encounterId !== rt.config.encounterId) {
    throw new SessionSyncError(`encounterId mismatch: state='${state.encounterId}' rt='${rt.config.encounterId}'`);
  }
  if (state.sessionId !== rt.config.sessionId) {
    throw new SessionSyncError(`sessionId mismatch: state='${state.sessionId}' rt='${rt.config.sessionId}'`);
  }
  // R8-6 audit fix: explicit empty/whitespace rejection. Without this, an
  // empty or whitespace participantId would fall into the Map.get('') miss
  // path and throw "participant '' not attached" — a misleading error that
  // hides the actual root cause (bad input). Consistent with R4-4 / R6-5
  // invariants applied to attachParticipant.
  if (!participantId) {
    throw new SessionSyncError(`participantId must be non-empty`);
  }
  if (participantId.trim().length === 0) {
    throw new SessionSyncError(`participantId must be non-empty (whitespace-only rejected)`);
  }
  const p = state.participants.get(participantId);
  if (!p) throw new SessionSyncError(`participant '${participantId}' not attached`);
  if (p.detachedAtTurn !== undefined) {
    throw new SessionSyncError(`participant '${participantId}' already detached`);
  }
  p.detachedAtTurn = rt.currentTurn;
  state.history.push({
    eventSeq: state.syncEventSeq++,
    kind: 'detach',
    participantId,
    role: p.role,
    turn: rt.currentTurn,
  });
}

// ─────────────────────────────────────────────────────────
// Sync snapshot — for wire broadcast / persistence
// ─────────────────────────────────────────────────────────

export interface SyncSnapshot {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  currentTurn: number;
  /** Canonical-ordered participant list (sorted by attach time, then id). */
  participants: readonly Participant[];
  /** Total attach + detach events to date. */
  syncEventCount: number;
  /** Payload hash of combat state at snapshot time — for reconcile w/ replay. */
  payloadHash: string;
  /** Stable digest of the whole sync snapshot. */
  digest: string;
}

/**
 * Build a deterministic sync snapshot from current state + runtime.
 *
 * Same state + same rt → same snapshot bytes ALWAYS.
 * Participant list is canonical-ordered (by attachedAtTurn asc, then participantId asc).
 */
export function buildSyncSnapshot(
  state: SessionSyncState,
  rt: CombatRuntime,
): SyncSnapshot {
  if (state.encounterId !== rt.config.encounterId) {
    throw new SessionSyncError(`encounterId mismatch: state='${state.encounterId}' rt='${rt.config.encounterId}'`);
  }
  // R3-1 audit fix: sessionId guard. snap.sessionId comes from state but
  // payloadHash comes from buildCombatPayload(rt). Mismatch would embed
  // inconsistent sessionId vs payload — silent.
  if (state.sessionId !== rt.config.sessionId) {
    throw new SessionSyncError(`sessionId mismatch: state='${state.sessionId}' rt='${rt.config.sessionId}'`);
  }
  // Canonical participant ordering — replay-safe sort.
  // participantId unique within session (enforced at attachParticipant).
  // Tiebreaker strict-vs-eq mutations EQUIVALENT (equal-id branch never fires).
  // Stryker disable all
  const sortedParticipants = [...state.participants.values()].sort((a, b) => {
    if (a.attachedAtTurn !== b.attachedAtTurn) return a.attachedAtTurn - b.attachedAtTurn;
    return a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0;
  });
  // Stryker restore all
  const payload = buildCombatPayload(rt);
  const payloadHash = hashPayload(payload);

  const snapshotForDigest = {
    schemaVersion: SESSION_SYNC_SCHEMA_VERSION,
    encounterId: state.encounterId,
    sessionId: state.sessionId,
    currentTurn: rt.currentTurn,
    participants: sortedParticipants,
    syncEventCount: state.syncEventSeq,
    payloadHash,
  };
  const digest = canonicalHash(snapshotForDigest);

  return { ...snapshotForDigest, digest };
}

/**
 * Compare two sync snapshots — same combat state should produce same digest.
 */
export interface SyncSnapshotDivergence {
  divergent: boolean;
  field?: 'digest' | 'currentTurn' | 'participants' | 'payloadHash' | 'syncEventCount';
}

export function compareSyncSnapshots(
  expected: SyncSnapshot,
  actual: SyncSnapshot,
): SyncSnapshotDivergence {
  if (expected.digest !== actual.digest) {
    // Drill down to find first field difference
    if (expected.payloadHash !== actual.payloadHash) {
      return { divergent: true, field: 'payloadHash' };
    }
    if (expected.currentTurn !== actual.currentTurn) {
      return { divergent: true, field: 'currentTurn' };
    }
    if (expected.syncEventCount !== actual.syncEventCount) {
      return { divergent: true, field: 'syncEventCount' };
    }
    if (expected.participants.length !== actual.participants.length) {
      return { divergent: true, field: 'participants' };
    }
    return { divergent: true, field: 'digest' };
  }
  return { divergent: false };
}

// ─────────────────────────────────────────────────────────
// Restore from sync snapshot — reconnect helper
// ─────────────────────────────────────────────────────────

export interface RestoreSyncResult {
  restored: boolean;
  failureReason?:
    | 'snapshot_missing'
    | 'integrity_drift'
    | 'session_mismatch'
    | 'schema_incompatible'
    | 'reconnect_failed';
  /** Combat runtime + payload from reconnectRestore (if succeeded). */
  combat?: ReconnectRestoreResult;
  /** Session sync state hydrated from the snapshot. */
  syncState?: SessionSyncState;
}

/**
 * Hydrate a fresh SessionSyncState from a SyncSnapshot + reconnect the
 * combat runtime via storage. Identity parity automatically checked.
 *
 * Use case: server restart → load both runtime AND session membership.
 */
export function restoreFromSyncSnapshot(
  snapshot: SyncSnapshot,
  storage: CombatStorage,
): RestoreSyncResult {
  // Step 0: schema compatibility gate — reject snapshots from a different
  // SessionSync schema version. Without this gate a v1 snapshot would be
  // silently hydrated into a v2 state container, losing whatever fields
  // changed across versions.
  if (snapshot.schemaVersion !== SESSION_SYNC_SCHEMA_VERSION) {
    return { restored: false, failureReason: 'schema_incompatible' };
  }
  // Step 1: reconnect runtime
  const combat = reconnectRestore(snapshot.encounterId, storage, {
    expectedSessionId: snapshot.sessionId,
    expectedPayloadHash: snapshot.payloadHash,
  });
  if (!combat.runtime || !combat.payload) {
    return {
      restored: false,
      failureReason: mapReconnectFailure(combat.report.failureReason),
      combat,
    };
  }
  // Step 2: identity parity check
  const parity = verifyIdentityParity(combat.runtime, combat.payload);
  if (!parity.parityHeld) {
    return { restored: false, failureReason: 'integrity_drift', combat };
  }
  // Step 3: hydrate sync state from snapshot participant list
  const syncState = createSessionSync(snapshot.encounterId, snapshot.sessionId);
  // R9-5 audit fix: defensive validation of snapshot contents BEFORE hydration.
  // A built snapshot from `buildSyncSnapshot` is well-formed by construction,
  // but a snapshot loaded from storage or wire could be tampered or corrupted
  // (R7-12 already validates encounterId; here we catch deeper anomalies).
  //   - duplicate participantId silently collapses via Map.set override →
  //     forensic info lost. Reject.
  //   - negative syncEventCount → next attach would push event with negative
  //     seq → underflow downstream. Reject.
  if (!Number.isInteger(snapshot.syncEventCount) || snapshot.syncEventCount < 0) {
    return { restored: false, failureReason: 'integrity_drift', combat };
  }
  const seenParticipantIds = new Set<string>();
  for (const p of snapshot.participants) {
    if (seenParticipantIds.has(p.participantId)) {
      return { restored: false, failureReason: 'integrity_drift', combat };
    }
    seenParticipantIds.add(p.participantId);
    syncState.participants.set(p.participantId, { ...p });
  }
  // Restore syncEventSeq to a safe high-water mark (snapshot doesn't carry
  // event history detail — caller must NOT generate new events with lower seq).
  syncState.syncEventSeq = snapshot.syncEventCount;
  return { restored: true, combat, syncState };
}

function mapReconnectFailure(
  r: ReconnectRestoreResult['report']['failureReason'],
): RestoreSyncResult['failureReason'] {
  switch (r) {
    case 'snapshot_missing':     return 'snapshot_missing';
    case 'session_mismatch':     return 'session_mismatch';
    case 'integrity_drift':      return 'integrity_drift';
    case 'schema_incompatible':  return 'schema_incompatible';
    default:                     return 'reconnect_failed';
  }
}

// ─────────────────────────────────────────────────────────
// Query helpers
// ─────────────────────────────────────────────────────────

export function attachedParticipants(state: SessionSyncState): readonly Participant[] {
  return [...state.participants.values()].filter((p) => p.detachedAtTurn === undefined);
}

export function participantsByRole(
  state: SessionSyncState,
  role: ParticipantRole,
): readonly Participant[] {
  return attachedParticipants(state).filter((p) => p.role === role);
}

export function participantCount(state: SessionSyncState): number {
  return attachedParticipants(state).length;
}

/**
 * Total attach + detach events for forensic dashboard.
 *
 * Returns `syncEventSeq` (high-water mark) rather than `history.length` so
 * the value remains accurate after `restoreFromSyncSnapshot` — snapshots
 * carry only the count, not per-event detail, so live `history` may be empty
 * even though events occurred pre-restore.
 */
export function syncEventCount(state: SessionSyncState): number {
  return state.syncEventSeq;
}

/** Stable hash of full sync history — forensic comparison across runs. */
export function syncHistoryHash(state: SessionSyncState): string {
  let h = 0x811c9dc5 >>> 0;
  const eat = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const e of state.history) {
    eat(`${e.eventSeq}|${e.kind}|${e.participantId}|${e.role}|${e.turn}`);
  }
  return h.toString(16).padStart(8, '0');
}

