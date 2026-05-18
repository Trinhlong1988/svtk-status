/**
 * COMBAT NETWORK ADAPTER — transport-agnostic wire packet preparation (Phase 14).
 *
 * Per CMD1 1.docx Phase 14 § 1:
 *   "Purpose: transport-agnostic combat wire adapter.
 *    SUPPORT:
 *      - payload sequencing
 *      - canonical packet wrapping
 *      - replay-safe payload dispatch
 *      - reconnect-safe payload replay
 *      - deterministic ordering
 *    MANDATORY: NO actual socket implementation.
 *               ONLY adapter contracts + wire-safe packet preparation."
 *
 * Wraps `CombatPayload` (Phase 12 INIT) and `SpectatorSnapshot` (Phase 12 INIT)
 * into deterministic packets ready for any transport (TCP/UDP/WS/HTTP). The
 * actual transport is OUT OF SCOPE (per § DO NOT BUILD: "real websocket server",
 * "UDP/TCP runtime").
 *
 * Caller responsibility:
 *   - assign monotonic `seq` per outbound packet
 *   - dispatch packet bytes via their own transport
 *   - validate incoming packet `seq` order
 *
 * STRICT additive — pure function module. No state. No I/O.
 */
import { canonicalJson, canonicalHash } from './combat_storage.js';
import {
  serializePayload,
  type CombatPayload,
} from './combat_payload_builder.js';
import {
  serializeSpectatorSnapshot,
  type SpectatorSnapshot,
} from './spectator_snapshot.js';

export const COMBAT_NETWORK_ADAPTER_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────
// Packet shape — transport-agnostic envelope
// ─────────────────────────────────────────────────────────

export type CombatPacketKind =
  | 'payload'           // CombatPayload (server-authoritative state)
  | 'spectator'         // SpectatorSnapshot (sanitized observer view)
  | 'heartbeat'         // empty payload — connection-keepalive
  | 'sync_snapshot';    // session sync snapshot (Phase 14 module 2)

export interface CombatPacket {
  schemaVersion: number;
  /** Monotonic per-session packet sequence — caller assigns, must increase. */
  seq: number;
  kind: CombatPacketKind;
  encounterId: string;
  sessionId: string;
  /** Canonical JSON bytes of the wrapped object (or empty for heartbeat). */
  bodyJson: string;
  /** Stable FNV-1a digest of the body bytes — wire integrity. */
  digest: string;
}

// ─────────────────────────────────────────────────────────
// Wrap APIs — pure factories
// ─────────────────────────────────────────────────────────

/**
 * Compute the canonical packet digest, binding the FULL envelope (NOT just
 * bodyJson). Without envelope binding, an attacker could rewrite
 * `kind`/`encounterId`/`sessionId`/`seq`/`schemaVersion` while keeping
 * bodyJson + digest unchanged — passing integrity verification while
 * misrouting the packet (Phase 17 § Area #7 FORBIDDEN "replay-affecting
 * transport metadata").
 */
function computePacketDigest(envelope: {
  schemaVersion: number;
  seq: number;
  kind: CombatPacketKind;
  encounterId: string;
  sessionId: string;
  bodyJson: string;
}): string {
  return canonicalHash(envelope);
}

/**
 * R8-1 audit fix: wrap functions previously accepted any number as `seq`
 * (NaN, Infinity, float, negative). The parse path already rejects malformed
 * seq via `isCombatPacketShape`. Without symmetric validation here, a sender
 * could ship `wrapPayloadPacket(payload, NaN)` — digest computed over NaN
 * (canonical JSON `null`) — and the receiver's `parsePacket` would reject it.
 * Asymmetric failure: sender claims success, receiver rejects.
 *
 * Validates the same invariant `isCombatPacketShape` checks on the wire side.
 */
function assertValidSeq(seq: number): void {
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
    throw new CombatPacketParseError(`seq must be a non-negative integer, got ${String(seq)}`);
  }
}

/**
 * Wrap a CombatPayload into a transport-ready packet.
 * Same payload + same seq + same envelope → same packet bytes ALWAYS.
 */
export function wrapPayloadPacket(
  payload: CombatPayload,
  seq: number,
): CombatPacket {
  assertValidSeq(seq);
  const bodyJson = serializePayload(payload);
  const envelope = {
    schemaVersion: COMBAT_NETWORK_ADAPTER_SCHEMA_VERSION,
    seq,
    kind: 'payload' as const,
    encounterId: payload.encounterId,
    sessionId: payload.sessionId,
    bodyJson,
  };
  return { ...envelope, digest: computePacketDigest(envelope) };
}

/**
 * Wrap a SpectatorSnapshot into a packet for observer broadcast.
 * The spectator snapshot is already sanitized (Phase 12 INIT) — packet
 * digests the full envelope so receivers verify integrity.
 */
export function wrapSpectatorPacket(
  snapshot: SpectatorSnapshot,
  seq: number,
): CombatPacket {
  assertValidSeq(seq);
  const bodyJson = serializeSpectatorSnapshot(snapshot);
  const envelope = {
    schemaVersion: COMBAT_NETWORK_ADAPTER_SCHEMA_VERSION,
    seq,
    kind: 'spectator' as const,
    encounterId: snapshot.encounterId,
    sessionId: snapshot.sessionId,
    bodyJson,
  };
  return { ...envelope, digest: computePacketDigest(envelope) };
}

/**
 * Wrap a sync snapshot (Phase 14 module 2 output) into a packet.
 * `bodyObject` MUST already be JSON-safe canonical (no Date/Map/Set/BigInt).
 */
export function wrapSyncSnapshotPacket(
  bodyObject: Readonly<Record<string, unknown>>,
  encounterId: string,
  sessionId: string,
  seq: number,
): CombatPacket {
  // R8-1 + R8-2 audit fix: wrap-time validation mirrors parsePacket invariants.
  // Without this, sender could ship a packet with empty/whitespace IDs or
  // malformed seq — receiver's `parsePacket` rejects, producing asymmetric
  // failure (server-side log shows success, client-side shows parse error).
  assertValidSeq(seq);
  if (!encounterId || encounterId.trim().length === 0) {
    throw new CombatPacketParseError(`encounterId must be non-empty (whitespace-only rejected)`);
  }
  if (!sessionId || sessionId.trim().length === 0) {
    throw new CombatPacketParseError(`sessionId must be non-empty (whitespace-only rejected)`);
  }
  const bodyJson = canonicalJson(bodyObject);
  const envelope = {
    schemaVersion: COMBAT_NETWORK_ADAPTER_SCHEMA_VERSION,
    seq,
    kind: 'sync_snapshot' as const,
    encounterId,
    sessionId,
    bodyJson,
  };
  return { ...envelope, digest: computePacketDigest(envelope) };
}

/**
 * Build a heartbeat packet — empty body, used by transport keepalive.
 * Digest still binds the full envelope (so heartbeat can't be re-tagged).
 */
export function buildHeartbeatPacket(
  encounterId: string,
  sessionId: string,
  seq: number,
): CombatPacket {
  // R8-1 + R8-3 audit fix: wrap-time validation mirrors parsePacket invariants
  // (same rationale as wrapSyncSnapshotPacket).
  assertValidSeq(seq);
  if (!encounterId || encounterId.trim().length === 0) {
    throw new CombatPacketParseError(`encounterId must be non-empty (whitespace-only rejected)`);
  }
  if (!sessionId || sessionId.trim().length === 0) {
    throw new CombatPacketParseError(`sessionId must be non-empty (whitespace-only rejected)`);
  }
  const envelope = {
    schemaVersion: COMBAT_NETWORK_ADAPTER_SCHEMA_VERSION,
    seq,
    kind: 'heartbeat' as const,
    encounterId,
    sessionId,
    bodyJson: '',
  };
  return { ...envelope, digest: computePacketDigest(envelope) };
}

// ─────────────────────────────────────────────────────────
// Serialize / parse — wire-safe encoding
// ─────────────────────────────────────────────────────────

/**
 * Encode packet to canonical JSON wire bytes.
 * Same packet → same bytes ALWAYS (canonical field ordering).
 */
export function serializePacket(packet: CombatPacket): string {
  return canonicalJson(packet);
}

/**
 * Parse incoming packet bytes. Throws if JSON invalid or shape malformed.
 * Caller MUST `verifyPacketIntegrity` afterward.
 */
export class CombatPacketParseError extends Error {
  constructor(reason: string) {
    super(`[CombatPacket] parse error: ${reason}`);
    this.name = 'CombatPacketParseError';
  }
}

export function parsePacket(wireBytes: string): CombatPacket {
  let raw: unknown;
  try {
    raw = JSON.parse(wireBytes);
  } catch (err) {
    throw new CombatPacketParseError(`invalid JSON: ${(err as Error).message}`);
  }
  if (!isCombatPacketShape(raw)) {
    throw new CombatPacketParseError('shape mismatch — missing required fields');
  }
  // R5-11 audit fix: STRIP unknown fields from incoming wire bytes. Without
  // stripping, an attacker could inject `{...envelope, evilMetadata:'x', digest:H(envelope)}`
  // — digest verification computes from the 6 known envelope fields and matches,
  // but downstream consumers could read `evilMetadata`. Returning only the 7 known
  // fields prevents metadata injection. Spec § Area #1 FORBIDDEN "replay-affecting
  // transport metadata".
  const o = raw as unknown as Record<string, unknown>;
  return {
    schemaVersion: o['schemaVersion'] as number,
    seq: o['seq'] as number,
    kind: o['kind'] as CombatPacketKind,
    encounterId: o['encounterId'] as string,
    sessionId: o['sessionId'] as string,
    bodyJson: o['bodyJson'] as string,
    digest: o['digest'] as string,
  };
}

function isCombatPacketShape(v: unknown): v is CombatPacket {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  // R4-2 audit fix: validate seq + schemaVersion are non-negative integers.
  // Float seq would slip through type check and cause weird gaps in orderPackets.
  const seqOk = typeof o['seq'] === 'number'
    && Number.isInteger(o['seq'])
    && (o['seq'] as number) >= 0;
  const schemaOk = typeof o['schemaVersion'] === 'number'
    && Number.isInteger(o['schemaVersion'])
    && (o['schemaVersion'] as number) >= 1;
  // R5-6 audit fix: validate non-empty encounterId / sessionId / digest. Empty
  // strings pass `typeof === 'string'` but defeat identity invariants.
  const idsOk = typeof o['encounterId'] === 'string' && (o['encounterId'] as string).length > 0
    && typeof o['sessionId'] === 'string' && (o['sessionId'] as string).length > 0
    && typeof o['digest'] === 'string' && (o['digest'] as string).length > 0;
  return schemaOk
    && seqOk
    && idsOk
    && typeof o['kind'] === 'string'
    && typeof o['bodyJson'] === 'string'
    && ['payload', 'spectator', 'heartbeat', 'sync_snapshot'].includes(o['kind'] as string);
}

// ─────────────────────────────────────────────────────────
// Integrity verification
// ─────────────────────────────────────────────────────────

export interface PacketIntegrityReport {
  valid: boolean;
  reason?: 'digest_mismatch' | 'schema_version_mismatch' | 'empty_body';
  expectedDigest: string;
  actualDigest: string;
}

/**
 * Verify packet integrity — recomputes digest over the FULL envelope (not just
 * bodyJson) and compares to embedded digest. Catches transport corruption +
 * any field tampering (envelope re-tag, encounter swap, seq replay, etc.).
 *
 * Empty-body packets are valid only for kind === 'heartbeat'. Any other kind
 * with an empty body is rejected with `empty_body` — closes a digest-bypass
 * where an attacker could ship `{ kind: 'payload', bodyJson: '' }` with the
 * pre-computed digest of empty string.
 */
export function verifyPacketIntegrity(packet: CombatPacket): PacketIntegrityReport {
  if (packet.schemaVersion !== COMBAT_NETWORK_ADAPTER_SCHEMA_VERSION) {
    return {
      valid: false,
      reason: 'schema_version_mismatch',
      expectedDigest: '',
      actualDigest: packet.digest,
    };
  }
  if (packet.bodyJson === '' && packet.kind !== 'heartbeat') {
    const emptyEnvelope = {
      schemaVersion: packet.schemaVersion,
      seq: packet.seq,
      kind: packet.kind,
      encounterId: packet.encounterId,
      sessionId: packet.sessionId,
      bodyJson: '',
    };
    return {
      valid: false,
      reason: 'empty_body',
      expectedDigest: computePacketDigest(emptyEnvelope),
      actualDigest: packet.digest,
    };
  }
  // R8-5 audit fix: enforce symmetry of the heartbeat invariant. Empty body in
  // non-heartbeat is already rejected above as `empty_body`. The mirror case —
  // non-empty body in heartbeat — was previously allowed, opening a side
  // channel where attacker ships `{kind:'heartbeat', bodyJson:'malicious'}`
  // with a valid digest (since digest binds the full envelope). Heartbeat is
  // defined as "empty payload — connection-keepalive" so any non-empty body
  // is a contract violation; reject it loud.
  if (packet.kind === 'heartbeat' && packet.bodyJson !== '') {
    const reEnvelope = {
      schemaVersion: packet.schemaVersion,
      seq: packet.seq,
      kind: packet.kind,
      encounterId: packet.encounterId,
      sessionId: packet.sessionId,
      bodyJson: '',
    };
    return {
      valid: false,
      reason: 'empty_body',
      expectedDigest: computePacketDigest(reEnvelope),
      actualDigest: packet.digest,
    };
  }
  const computedDigest = computePacketDigest({
    schemaVersion: packet.schemaVersion,
    seq: packet.seq,
    kind: packet.kind,
    encounterId: packet.encounterId,
    sessionId: packet.sessionId,
    bodyJson: packet.bodyJson,
  });
  if (computedDigest !== packet.digest) {
    return {
      valid: false,
      reason: 'digest_mismatch',
      expectedDigest: computedDigest,
      actualDigest: packet.digest,
    };
  }
  return { valid: true, expectedDigest: computedDigest, actualDigest: packet.digest };
}

// ─────────────────────────────────────────────────────────
// Packet sequence validator — caller maintains state
// ─────────────────────────────────────────────────────────

export interface PacketSequenceState {
  encounterId: string;
  sessionId: string;
  /** Last accepted seq, -1 = none yet. */
  lastSeq: number;
  /** Total packets accepted. */
  acceptedCount: number;
  /** Total packets rejected for ordering violation. */
  rejectedCount: number;
}

export function createPacketSequenceState(
  encounterId: string,
  sessionId: string,
): PacketSequenceState {
  // R7-14 audit fix: factory-level identity validation. acceptPacket compares
  // state.encounterId === packet.encounterId; if BOTH are empty (factory and
  // packet builder also empty), the identity guard passes silently → packets
  // from a different "empty-ID encounter" pollute the sequence state. Same
  // root cause as R7-1/3/5/8/9/10/11/12.
  if (!encounterId || encounterId.trim().length === 0) {
    throw new CombatPacketParseError(`encounterId must be non-empty (whitespace-only rejected)`);
  }
  if (!sessionId || sessionId.trim().length === 0) {
    throw new CombatPacketParseError(`sessionId must be non-empty (whitespace-only rejected)`);
  }
  return { encounterId, sessionId, lastSeq: -1, acceptedCount: 0, rejectedCount: 0 };
}

export type PacketSequenceVerdict =
  | { accepted: true; newSeq: number }
  | { accepted: false; reason: 'session_mismatch' | 'encounter_mismatch' | 'out_of_order' | 'duplicate' | 'schema_version_mismatch'; expectedNext: number };

/**
 * Validate a packet's sequence against this state. Returns verdict + mutates
 * state on accept. Strict monotonic: rejects out-of-order, duplicate, and
 * mismatched encounter/session.
 *
 * NOTE: This is a SYNC-ordering check, not transport-layer. UDP/lossy transports
 * may legitimately drop packets; caller may relax this (e.g., accept ≥ lastSeq+1
 * with gap tracking) by NOT using this validator.
 */
export function acceptPacket(
  state: PacketSequenceState,
  packet: CombatPacket,
): PacketSequenceVerdict {
  // R4-3 audit fix: defense-in-depth schemaVersion check. verifyPacketIntegrity
  // is the primary gate but acceptPacket should also reject foreign-schema
  // packets so the sequence state isn't polluted with future-version seqs.
  if (packet.schemaVersion !== COMBAT_NETWORK_ADAPTER_SCHEMA_VERSION) {
    state.rejectedCount++;
    return { accepted: false, reason: 'schema_version_mismatch', expectedNext: state.lastSeq + 1 };
  }
  if (packet.encounterId !== state.encounterId) {
    state.rejectedCount++;
    return { accepted: false, reason: 'encounter_mismatch', expectedNext: state.lastSeq + 1 };
  }
  if (packet.sessionId !== state.sessionId) {
    state.rejectedCount++;
    return { accepted: false, reason: 'session_mismatch', expectedNext: state.lastSeq + 1 };
  }
  const expectedNext = state.lastSeq + 1;
  if (packet.seq === expectedNext) {
    state.lastSeq = packet.seq;
    state.acceptedCount++;
    return { accepted: true, newSeq: packet.seq };
  }
  state.rejectedCount++;
  if (packet.seq <= state.lastSeq) {
    return { accepted: false, reason: 'duplicate', expectedNext };
  }
  return { accepted: false, reason: 'out_of_order', expectedNext };
}

// ─────────────────────────────────────────────────────────
// Packet ordering replay — caller reconstructs ordered stream
// ─────────────────────────────────────────────────────────

/**
 * Replay a batch of packets in ascending seq order. Used by reconnect path
 * to apply buffered packets after restoring session.
 *
 * Returns packets in canonical order + flags any duplicate seq.
 */
export interface OrderedReplay {
  ordered: readonly CombatPacket[];
  duplicates: number;
  gaps: readonly { from: number; to: number }[];
}

export function orderPackets(packets: readonly CombatPacket[]): OrderedReplay {
  // R8-4 audit fix: previously sort was by seq only; for two packets sharing a
  // seq (legitimate retransmit OR adversarial collision) the kept packet was
  // whichever appeared first in input — i.e. input-order-dependent. Two callers
  // receiving the same MULTISET of packets in different orders would keep
  // different packets → split-brain in deterministic replay. Sort tiebreaker
  // on `digest` codepoint guarantees same multiset → same ordered output.
  // digest unique per envelope; tiebreaker fires only on (seq=same, digest=different)
  // which means different content. Mutations `<` → `<=` are EQUIVALENT (equal-digest
  // branch never fires because identical digest = identical envelope = same packet).
  // Stryker disable all
  const sorted = [...packets].sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    return a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0;
  });
  // Stryker restore all
  const ordered: CombatPacket[] = [];
  const gaps: { from: number; to: number }[] = [];
  let duplicates = 0;
  let prev = -1;
  for (const p of sorted) {
    if (p.seq === prev) {
      duplicates++;
      continue;
    }
    if (prev !== -1 && p.seq > prev + 1) {
      gaps.push({ from: prev + 1, to: p.seq - 1 });
    }
    ordered.push(p);
    prev = p.seq;
  }
  return { ordered, duplicates, gaps };
}
