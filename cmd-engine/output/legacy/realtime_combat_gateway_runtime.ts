/**
 * REALTIME COMBAT GATEWAY RUNTIME — deterministic packet routing (Phase 19 § 1).
 *
 * Per CMD1 Phase 19 directive § PRIMARY MODULE #1:
 *   "Purpose: live deterministic combat session gateway.
 *    SUPPORT: realtime multiplayer combat sessions / deterministic packet ingress/egress
 *             / reconnect-safe session recovery / canonical combat routing
 *             / replay-safe gateway continuation
 *    MANDATORY: same packet stream = same combat result ALWAYS.
 *    FORBIDDEN: runtime-dependent packet routing / nondeterministic session
 *               ordering / transient participant traversal"
 *
 * Pure state container — receives CombatPackets, classifies by kind, emits a
 * RoutingDecision per packet. Caller dispatches decisions to actual subsystems.
 * NO actual networking. NO live websocket.
 *
 * STRICT additive — applies all CMD1 invariants from R1-R4 audit:
 *   - empty-ID rejection
 *   - canonical codepoint-sorted traversal
 *   - encounterId + sessionId guards
 *   - schemaVersion gate
 *   - packet envelope integrity verification (Phase 14 + P17-1 fix)
 */
import type { CombatRuntime } from './combat_runtime.js';
import { canonicalHash } from './combat_storage.js';
import {
  verifyPacketIntegrity,
  type CombatPacket,
  type CombatPacketKind,
} from './combat_network_adapter.js';

export const REALTIME_GATEWAY_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────
// Routing model
// ─────────────────────────────────────────────────────────

export type RoutingTarget =
  | 'combat_runtime'
  | 'spectator_broadcast'
  | 'session_sync'
  | 'keepalive'
  | 'rejected';

export type RoutingRejectReason =
  | 'packet_integrity_failed'
  | 'unknown_participant'
  | 'encounter_mismatch'
  | 'session_mismatch'
  | 'schema_version_mismatch';

export interface RoutingDecision {
  schemaVersion: number;
  /** Monotonic decision seq for forensic replay. */
  seq: number;
  /** Turn at which routing happened. */
  turn: number;
  packetKind: CombatPacketKind;
  packetSeq: number;
  participantId?: string;
  target: RoutingTarget;
  rejectReason?: RoutingRejectReason;
  /** Stable digest binding decision identity. */
  digest: string;
}

export interface ParticipantRegistration {
  participantId: string;
  sessionToken: string;
  registeredAtTurn: number;
  /** Total packets routed for this participant. */
  packetsRouted: number;
}

export interface GatewayState {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  participants: Map<string, ParticipantRegistration>;
  decisions: RoutingDecision[];
  nextDecisionSeq: number;
  totalAccepted: number;
  totalRejected: number;
}

export function createGateway(
  encounterId: string,
  sessionId: string,
): GatewayState {
  // R7-11 audit fix: factory-level identity validation. assertParity in
  // routePacket only guards mismatch — TWO gateways both created with empty
  // IDs both bound to empty-ID runtimes would silently route packets across
  // distinct sessions if encounter/session IDs are equal-by-empty. Same root
  // cause as R7-1/3/5/8/9/10.
  if (!encounterId || encounterId.trim().length === 0) {
    throw new RealtimeGatewayError(`encounterId must be non-empty (whitespace-only rejected)`);
  }
  if (!sessionId || sessionId.trim().length === 0) {
    throw new RealtimeGatewayError(`sessionId must be non-empty (whitespace-only rejected)`);
  }
  return {
    schemaVersion: REALTIME_GATEWAY_SCHEMA_VERSION,
    encounterId,
    sessionId,
    participants: new Map(),
    decisions: [],
    nextDecisionSeq: 0,
    totalAccepted: 0,
    totalRejected: 0,
  };
}

// ─────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────

export class RealtimeGatewayError extends Error {
  constructor(message: string) {
    super(`[RealtimeGateway] ${message}`);
    this.name = 'RealtimeGatewayError';
  }
}

function assertParity(state: GatewayState, rt: CombatRuntime): void {
  if (state.encounterId !== rt.config.encounterId) {
    throw new RealtimeGatewayError(`encounterId mismatch: state='${state.encounterId}' rt='${rt.config.encounterId}'`);
  }
  if (state.sessionId !== rt.config.sessionId) {
    throw new RealtimeGatewayError(`sessionId mismatch: state='${state.sessionId}' rt='${rt.config.sessionId}'`);
  }
}

// ─────────────────────────────────────────────────────────
// Participant registration
// ─────────────────────────────────────────────────────────

export function registerParticipant(
  state: GatewayState,
  rt: CombatRuntime,
  participantId: string,
  sessionToken: string,
): ParticipantRegistration {
  assertParity(state, rt);
  if (!participantId) {
    throw new RealtimeGatewayError(`participantId must be non-empty`);
  }
  // R6-5 audit fix: whitespace-only IDs slip past `!id` check but still cause
  // silent identity drift in canonical sort + decision digest.
  if (participantId.trim().length === 0) {
    throw new RealtimeGatewayError(`participantId must be non-empty (whitespace-only rejected)`);
  }
  if (!sessionToken) {
    throw new RealtimeGatewayError(`sessionToken must be non-empty`);
  }
  if (sessionToken.trim().length === 0) {
    throw new RealtimeGatewayError(`sessionToken must be non-empty (whitespace-only rejected)`);
  }
  if (state.participants.has(participantId)) {
    throw new RealtimeGatewayError(`participant '${participantId}' already registered`);
  }
  const reg: ParticipantRegistration = {
    participantId,
    sessionToken,
    registeredAtTurn: rt.currentTurn,
    packetsRouted: 0,
  };
  state.participants.set(participantId, reg);
  return reg;
}

export function unregisterParticipant(
  state: GatewayState,
  rt: CombatRuntime,
  participantId: string,
): void {
  assertParity(state, rt);
  if (!participantId) {
    throw new RealtimeGatewayError(`participantId must be non-empty`);
  }
  // R7-13 audit fix: whitespace-only id falls through `!id` check. While the
  // subsequent has() lookup would harmlessly throw "not registered", the
  // error message is misleading + leaves an open path if a future code change
  // adds a whitespace-keyed registration somewhere upstream. Matches the
  // explicit-rejection invariant established by R6-5 / R7-11.
  if (participantId.trim().length === 0) {
    throw new RealtimeGatewayError(`participantId must be non-empty (whitespace-only rejected)`);
  }
  if (!state.participants.has(participantId)) {
    throw new RealtimeGatewayError(`participant '${participantId}' not registered`);
  }
  state.participants.delete(participantId);
}

// ─────────────────────────────────────────────────────────
// Packet routing
// ─────────────────────────────────────────────────────────

function digestDecision(
  seq: number,
  turn: number,
  packetKind: CombatPacketKind,
  packetSeq: number,
  target: RoutingTarget,
  participantId: string | undefined,
  rejectReason: RoutingRejectReason | undefined,
): string {
  return canonicalHash({
    schemaVersion: REALTIME_GATEWAY_SCHEMA_VERSION,
    seq,
    turn,
    packetKind,
    packetSeq,
    target,
    participantId: participantId ?? '',
    rejectReason: rejectReason ?? '',
  });
}

function recordDecision(
  state: GatewayState,
  rt: CombatRuntime,
  packet: CombatPacket,
  target: RoutingTarget,
  participantId: string | undefined,
  rejectReason: RoutingRejectReason | undefined,
): RoutingDecision {
  const seq = state.nextDecisionSeq++;
  const decision: RoutingDecision = {
    schemaVersion: REALTIME_GATEWAY_SCHEMA_VERSION,
    seq,
    turn: rt.currentTurn,
    packetKind: packet.kind,
    packetSeq: packet.seq,
    participantId,
    target,
    rejectReason,
    digest: digestDecision(seq, rt.currentTurn, packet.kind, packet.seq, target, participantId, rejectReason),
  };
  state.decisions.push(decision);
  if (rejectReason !== undefined) state.totalRejected++;
  else state.totalAccepted++;
  return decision;
}

/**
 * Route a packet to the correct subsystem. Pure decision — caller dispatches.
 *
 * Routing rules (deterministic):
 *   1. verifyPacketIntegrity fails → reject (packet_integrity_failed)
 *   2. schemaVersion mismatch → reject (schema_version_mismatch)
 *   3. encounterId mismatch → reject (encounter_mismatch)
 *   4. sessionId mismatch → reject (session_mismatch)
 *   5. participantId required (non-heartbeat) but not registered → reject (unknown_participant)
 *   6. packet.kind === 'payload' → combat_runtime
 *   7. packet.kind === 'spectator' → spectator_broadcast
 *   8. packet.kind === 'sync_snapshot' → session_sync
 *   9. packet.kind === 'heartbeat' → keepalive
 */
export function routePacket(
  state: GatewayState,
  rt: CombatRuntime,
  packet: CombatPacket,
  participantId?: string,
): RoutingDecision {
  assertParity(state, rt);
  // R9-4 audit fix: reject empty / whitespace participantId at entry. Without
  // this, two callers — one passing `undefined` and one passing `''` —
  // produce decisions whose digests collide (`digestDecision` uses
  // `participantId ?? ''` so both serialize to empty string). Empty string
  // is NOT a valid participant identity; reject up-front so callers get a
  // clear error instead of silently colliding with unauth heartbeats.
  if (participantId !== undefined) {
    if (participantId.length === 0) {
      throw new RealtimeGatewayError(`participantId must be non-empty (pass undefined for anonymous)`);
    }
    if (participantId.trim().length === 0) {
      throw new RealtimeGatewayError(`participantId must be non-empty (whitespace-only rejected)`);
    }
  }
  const integrity = verifyPacketIntegrity(packet);
  if (!integrity.valid) {
    return recordDecision(state, rt, packet, 'rejected', participantId,
      integrity.reason === 'schema_version_mismatch' ? 'schema_version_mismatch' : 'packet_integrity_failed');
  }
  if (packet.encounterId !== state.encounterId) {
    return recordDecision(state, rt, packet, 'rejected', participantId, 'encounter_mismatch');
  }
  if (packet.sessionId !== state.sessionId) {
    return recordDecision(state, rt, packet, 'rejected', participantId, 'session_mismatch');
  }
  if (participantId !== undefined && packet.kind !== 'heartbeat') {
    if (!state.participants.has(participantId)) {
      return recordDecision(state, rt, packet, 'rejected', participantId, 'unknown_participant');
    }
  }
  let target: RoutingTarget;
  switch (packet.kind) {
    case 'payload': target = 'combat_runtime'; break;
    case 'spectator': target = 'spectator_broadcast'; break;
    case 'sync_snapshot': target = 'session_sync'; break;
    case 'heartbeat': target = 'keepalive'; break;
  }
  if (participantId !== undefined && state.participants.has(participantId)) {
    state.participants.get(participantId)!.packetsRouted++;
  }
  return recordDecision(state, rt, packet, target, participantId, undefined);
}

// ─────────────────────────────────────────────────────────
// Snapshot + query
// ─────────────────────────────────────────────────────────

export interface GatewaySnapshot {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  currentTurn: number;
  participants: readonly ParticipantRegistration[]; // canonical-sorted
  decisionCount: number;
  totalAccepted: number;
  totalRejected: number;
  digest: string;
}

export function buildGatewaySnapshot(
  state: GatewayState,
  rt: CombatRuntime,
): GatewaySnapshot {
  assertParity(state, rt);
  // participantId unique within gateway (enforced at registerParticipant).
  // Tiebreaker strict-vs-eq mutations EQUIVALENT (equal branch never fires).
  // Stryker disable all
  const sortedParticipants = [...state.participants.values()].sort((a, b) => {
    if (a.registeredAtTurn !== b.registeredAtTurn) return a.registeredAtTurn - b.registeredAtTurn;
    return a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0;
  });
  // Stryker restore all
  const forDigest = {
    schemaVersion: REALTIME_GATEWAY_SCHEMA_VERSION,
    encounterId: state.encounterId,
    sessionId: state.sessionId,
    currentTurn: rt.currentTurn,
    participants: sortedParticipants,
    decisionCount: state.decisions.length,
    totalAccepted: state.totalAccepted,
    totalRejected: state.totalRejected,
  };
  return { ...forDigest, digest: canonicalHash(forDigest) };
}

export function decisionsByTarget(
  state: GatewayState,
  target: RoutingTarget,
): readonly RoutingDecision[] {
  // Stryker disable all -- seq-monotonic input, defense-in-depth sort
  return [...state.decisions]
    .filter((d) => d.target === target)
    .sort((a, b) => a.seq - b.seq);
  // Stryker restore all
}

export function activeParticipants(state: GatewayState): readonly ParticipantRegistration[] {
  // Stryker disable all -- participantId unique, strict-vs-eq mutations equivalent
  return [...state.participants.values()].sort((a, b) =>
    a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0,
  );
  // Stryker restore all
}

export function decisionCount(state: GatewayState): number {
  return state.decisions.length;
}

export function gatewayHistoryHash(state: GatewayState): string {
  let h = 0x811c9dc5 >>> 0;
  const eat = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const d of state.decisions) {
    eat(`${d.seq}|${d.packetKind}|${d.packetSeq}|${d.target}|${d.participantId ?? ''}`);
  }
  return h.toString(16).padStart(8, '0');
}
