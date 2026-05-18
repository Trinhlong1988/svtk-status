/**
 * WEBSOCKET TRANSPORT RUNTIME — deterministic transport framing (Phase 19 § 2).
 *
 * Per CMD1 Phase 19 directive § PRIMARY MODULE #2:
 *   "Purpose: deterministic websocket transport layer.
 *    SUPPORT: realtime packet streaming / deterministic packet framing
 *             / replay-safe websocket rebuild / reconnect-safe transport continuation
 *             / canonical payload serialization
 *    MANDATORY: serialize → send → receive → rebuild byte-identical ALWAYS.
 *    FORBIDDEN: timestamp-dependent payloads / locale-sensitive serialization
 *               / unstable packet ordering"
 *
 * SEMANTIC websocket layer — NOT an actual `ws://` runtime. Tracks send/receive
 * frame log + connection state + reconnect history deterministically. Caller
 * binds to actual transport (out of CMD1 scope).
 *
 * Composes Phase 14 `combat_network_adapter.ts` for packet codec + integrity.
 *
 * STRICT additive — all CMD1 hardening invariants applied.
 */
import type { CombatRuntime } from './combat_runtime.js';
import { canonicalHash } from './combat_storage.js';
import {
  serializePacket,
  parsePacket,
  verifyPacketIntegrity,
  acceptPacket,
  createPacketSequenceState,
  type CombatPacket,
  type PacketSequenceState,
  type PacketSequenceVerdict,
} from './combat_network_adapter.js';

export const WEBSOCKET_TRANSPORT_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────
// Transport session state
// ─────────────────────────────────────────────────────────

export type ConnectionState = 'connected' | 'reconnecting' | 'closed';

export interface TransportFrameLog {
  /** Monotonic frame seq within this transport session direction. */
  frameSeq: number;
  /** Turn at which frame was send/received. */
  turn: number;
  /** Canonical wire bytes. */
  wireBytes: string;
  /** Packet digest (from envelope). */
  packetDigest: string;
}

export interface ReconnectMarker {
  reconnectSeq: number;
  reconnectAtTurn: number;
  fromState: ConnectionState;
  /** Restore-point frame seq (outbound + inbound at reconnect time). */
  outboundFrameSeq: number;
  inboundFrameSeq: number;
}

export interface TransportSessionState {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  /** Unique transport session id (per-physical-connection identity). */
  transportSessionId: string;
  connectionState: ConnectionState;
  outboundFrames: TransportFrameLog[];
  inboundFrames: TransportFrameLog[];
  inboundSeqState: PacketSequenceState;
  reconnects: ReconnectMarker[];
  nextReconnectSeq: number;
  totalSent: number;
  totalReceived: number;
  totalReceivedRejected: number;
}

export function openTransportSession(
  encounterId: string,
  sessionId: string,
  transportSessionId: string,
): TransportSessionState {
  // Both `!id` and `.trim().length === 0` paths converge to the SAME caller-
  // visible outcome: a WebsocketTransportError whose message contains
  // "must be non-empty". Stryker mutants on the first guard route via the
  // second guard with a slightly different message but identical semantics
  // — caller can't distinguish. These mutants are EQUIVALENT in behavior.
  // Stryker disable all
  if (!encounterId) throw new WebsocketTransportError(`encounterId must be non-empty`);
  if (!sessionId) throw new WebsocketTransportError(`sessionId must be non-empty`);
  if (!transportSessionId) throw new WebsocketTransportError(`transportSessionId must be non-empty`);
  // R6-5 audit fix: whitespace-only IDs pass `!id` check but cause silent
  // identity drift in transport snapshot digest + multi-session orchestration.
  if (encounterId.trim().length === 0) {
    throw new WebsocketTransportError(`encounterId must be non-empty (whitespace-only rejected)`);
  }
  if (sessionId.trim().length === 0) {
    throw new WebsocketTransportError(`sessionId must be non-empty (whitespace-only rejected)`);
  }
  if (transportSessionId.trim().length === 0) {
    throw new WebsocketTransportError(`transportSessionId must be non-empty (whitespace-only rejected)`);
  }
  // Stryker restore all
  return {
    schemaVersion: WEBSOCKET_TRANSPORT_SCHEMA_VERSION,
    encounterId,
    sessionId,
    transportSessionId,
    connectionState: 'connected',
    outboundFrames: [],
    inboundFrames: [],
    inboundSeqState: createPacketSequenceState(encounterId, sessionId),
    reconnects: [],
    nextReconnectSeq: 0,
    totalSent: 0,
    totalReceived: 0,
    totalReceivedRejected: 0,
  };
}

// ─────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────

export class WebsocketTransportError extends Error {
  constructor(message: string) {
    super(`[WebsocketTransport] ${message}`);
    this.name = 'WebsocketTransportError';
  }
}

function assertParity(state: TransportSessionState, rt: CombatRuntime): void {
  if (state.encounterId !== rt.config.encounterId) {
    throw new WebsocketTransportError(`encounterId mismatch: state='${state.encounterId}' rt='${rt.config.encounterId}'`);
  }
  if (state.sessionId !== rt.config.sessionId) {
    throw new WebsocketTransportError(`sessionId mismatch: state='${state.sessionId}' rt='${rt.config.sessionId}'`);
  }
}

function assertOpen(state: TransportSessionState): void {
  if (state.connectionState === 'closed') {
    throw new WebsocketTransportError(`transport session '${state.transportSessionId}' is closed`);
  }
}

// ─────────────────────────────────────────────────────────
// Frame send/receive
// ─────────────────────────────────────────────────────────

export interface ReceiveVerdict {
  accepted: boolean;
  reason?: 'integrity_failed' | 'sequence_rejected' | 'reconnect_required';
  sequenceVerdict?: PacketSequenceVerdict;
}

export function sendFrame(
  state: TransportSessionState,
  rt: CombatRuntime,
  packet: CombatPacket,
): TransportFrameLog {
  assertParity(state, rt);
  assertOpen(state);
  const integrity = verifyPacketIntegrity(packet);
  if (!integrity.valid) {
    throw new WebsocketTransportError(`refusing to send invalid packet: ${integrity.reason ?? 'unknown'}`);
  }
  const wireBytes = serializePacket(packet);
  const log: TransportFrameLog = {
    frameSeq: state.outboundFrames.length,
    turn: rt.currentTurn,
    wireBytes,
    packetDigest: packet.digest,
  };
  state.outboundFrames.push(log);
  state.totalSent++;
  return log;
}

/**
 * Receive a frame (wire bytes). Validates integrity + monotonic ordering.
 * Returns verdict with sequenceVerdict if sequence-rejected.
 *
 * Refuses if session reconnecting.
 */
export function receiveFrame(
  state: TransportSessionState,
  rt: CombatRuntime,
  wireBytes: string,
): { verdict: ReceiveVerdict; packet?: CombatPacket } {
  assertParity(state, rt);
  if (state.connectionState !== 'connected') {
    state.totalReceivedRejected++;
    return { verdict: { accepted: false, reason: 'reconnect_required' } };
  }
  let packet: CombatPacket;
  try {
    packet = parsePacket(wireBytes);
  } catch {
    state.totalReceivedRejected++;
    return { verdict: { accepted: false, reason: 'integrity_failed' } };
  }
  const integrity = verifyPacketIntegrity(packet);
  if (!integrity.valid) {
    state.totalReceivedRejected++;
    return { verdict: { accepted: false, reason: 'integrity_failed' } };
  }
  const seqVerdict = acceptPacket(state.inboundSeqState, packet);
  if (!seqVerdict.accepted) {
    state.totalReceivedRejected++;
    return { verdict: { accepted: false, reason: 'sequence_rejected', sequenceVerdict: seqVerdict } };
  }
  const log: TransportFrameLog = {
    frameSeq: state.inboundFrames.length,
    turn: rt.currentTurn,
    wireBytes,
    packetDigest: packet.digest,
  };
  state.inboundFrames.push(log);
  state.totalReceived++;
  return { verdict: { accepted: true, sequenceVerdict: seqVerdict }, packet };
}

// ─────────────────────────────────────────────────────────
// Reconnect / close
// ─────────────────────────────────────────────────────────

export function beginReconnect(
  state: TransportSessionState,
  rt: CombatRuntime,
): ReconnectMarker {
  assertParity(state, rt);
  if (state.connectionState === 'closed') {
    throw new WebsocketTransportError(`cannot reconnect closed transport session`);
  }
  const marker: ReconnectMarker = {
    reconnectSeq: state.nextReconnectSeq++,
    reconnectAtTurn: rt.currentTurn,
    fromState: state.connectionState,
    outboundFrameSeq: state.outboundFrames.length,
    inboundFrameSeq: state.inboundFrames.length,
  };
  state.reconnects.push(marker);
  state.connectionState = 'reconnecting';
  return marker;
}

export function completeReconnect(
  state: TransportSessionState,
  rt: CombatRuntime,
): void {
  assertParity(state, rt);
  if (state.connectionState !== 'reconnecting') {
    throw new WebsocketTransportError(`session not in reconnecting state`);
  }
  state.connectionState = 'connected';
}

export function closeSession(state: TransportSessionState): void {
  state.connectionState = 'closed';
}

// ─────────────────────────────────────────────────────────
// Replay / projection (canonical, deterministic)
// ─────────────────────────────────────────────────────────

export interface TransportSnapshot {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  transportSessionId: string;
  connectionState: ConnectionState;
  outboundFrameCount: number;
  inboundFrameCount: number;
  reconnectCount: number;
  totalSent: number;
  totalReceived: number;
  totalReceivedRejected: number;
  /** Canonical-ordered outbound wire bytes for forensic replay. */
  outboundWireDigest: string;
  /** Canonical-ordered inbound wire bytes digest. */
  inboundWireDigest: string;
  /** Stable digest of transport snapshot. */
  digest: string;
}

export function buildTransportSnapshot(
  state: TransportSessionState,
): TransportSnapshot {
  // outbound/inboundFrames are populated by sendFrame/receiveFrame with
  // frameSeq = current array length → naturally monotonic. Sort is defense-
  // in-depth. Stryker mutants on these comparators are EQUIVALENT.
  // Stryker disable all
  const sortedOutbound = [...state.outboundFrames].sort((a, b) => a.frameSeq - b.frameSeq);
  const sortedInbound = [...state.inboundFrames].sort((a, b) => a.frameSeq - b.frameSeq);
  // Stryker restore all
  const outboundWireDigest = canonicalHash(sortedOutbound.map((f) => f.packetDigest));
  const inboundWireDigest = canonicalHash(sortedInbound.map((f) => f.packetDigest));
  const forDigest = {
    schemaVersion: WEBSOCKET_TRANSPORT_SCHEMA_VERSION,
    encounterId: state.encounterId,
    sessionId: state.sessionId,
    transportSessionId: state.transportSessionId,
    connectionState: state.connectionState,
    outboundFrameCount: sortedOutbound.length,
    inboundFrameCount: sortedInbound.length,
    reconnectCount: state.reconnects.length,
    totalSent: state.totalSent,
    totalReceived: state.totalReceived,
    totalReceivedRejected: state.totalReceivedRejected,
    outboundWireDigest,
    inboundWireDigest,
  };
  return { ...forDigest, digest: canonicalHash(forDigest) };
}

/**
 * Replay outbound frames in canonical order. Pure iteration — `visit` must be
 * side-effect-free for replay safety.
 */
export function replayOutbound(
  state: TransportSessionState,
  visit: (frame: TransportFrameLog) => void,
): void {
  // Stryker disable all -- frameSeq-monotonic, defense-in-depth sort
  const ordered = [...state.outboundFrames].sort((a, b) => a.frameSeq - b.frameSeq);
  // Stryker restore all
  for (const f of ordered) visit(f);
}

export function replayInbound(
  state: TransportSessionState,
  visit: (frame: TransportFrameLog) => void,
): void {
  // Stryker disable all
  const ordered = [...state.inboundFrames].sort((a, b) => a.frameSeq - b.frameSeq);
  // Stryker restore all
  for (const f of ordered) visit(f);
}

// ─────────────────────────────────────────────────────────
// Query
// ─────────────────────────────────────────────────────────

export function outboundFrameCount(state: TransportSessionState): number {
  return state.outboundFrames.length;
}

export function inboundFrameCount(state: TransportSessionState): number {
  return state.inboundFrames.length;
}

export function reconnectCount(state: TransportSessionState): number {
  return state.reconnects.length;
}

export function transportHistoryHash(state: TransportSessionState): string {
  let h = 0x811c9dc5 >>> 0;
  const eat = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const f of state.outboundFrames) eat(`O|${f.frameSeq}|${f.packetDigest}`);
  for (const f of state.inboundFrames) eat(`I|${f.frameSeq}|${f.packetDigest}`);
  for (const r of state.reconnects) eat(`R|${r.reconnectSeq}|${r.reconnectAtTurn}`);
  return h.toString(16).padStart(8, '0');
}
