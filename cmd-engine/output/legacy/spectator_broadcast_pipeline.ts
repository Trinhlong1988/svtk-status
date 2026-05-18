/**
 * SPECTATOR BROADCAST PIPELINE — observer-safe combat broadcasting (Phase 14 § 3).
 *
 * Per CMD1 1.docx Phase 14 § 3:
 *   "Purpose: observer-safe combat broadcasting.
 *    SUPPORT:
 *      - sanitized spectator payloads
 *      - replay-linked broadcast frames
 *      - timeline-safe event ordering
 *      - anti-cheat-safe observer pipeline
 *    MANDATORY: spectator metadata MUST NEVER affect:
 *               - replay hash
 *               - deterministic state
 *               - rollback integrity"
 *
 * Builds per-frame spectator broadcasts from CombatRuntime, wraps each into
 * a network packet (Phase 14 § 1 `wrapSpectatorPacket`), and tracks attached
 * observers + their per-observer packet seq.
 *
 * STRICT additive — read-only against CombatRuntime. No mutation. No I/O.
 * Caller dispatches packets via their own transport (out of CMD1 scope).
 */
import type { CombatRuntime } from './combat_runtime.js';
import {
  buildSpectatorSnapshot,
  detectPrivateFieldLeak,
  type SpectatorSnapshot,
  type SpectatorViewerKind,
} from './spectator_snapshot.js';
import {
  wrapSpectatorPacket,
  type CombatPacket,
} from './combat_network_adapter.js';
import { canonicalHash } from './combat_storage.js';

export const SPECTATOR_BROADCAST_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────
// Observer registration
// ─────────────────────────────────────────────────────────

export interface Observer {
  observerId: string;
  /** Viewer kind — 'spectator' (live) or 'replay' (post-game). */
  viewer: SpectatorViewerKind;
  /** Turn observer attached at. */
  attachedAtTurn: number;
  /** Per-observer packet sequence — strict monotonic per observer. */
  nextPacketSeq: number;
  /** Observer detached? */
  detachedAtTurn?: number;
  /** Cumulative broadcast frame count. */
  framesReceived: number;
}

export interface BroadcastPipelineState {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  /** Map observerId → Observer. */
  observers: Map<string, Observer>;
  /** Total broadcast frame count across all observers. */
  totalFramesBroadcast: number;
  /** Total observers ever attached (incl. detached). */
  totalObserverAttachments: number;
}

export function createBroadcastPipeline(
  encounterId: string,
  sessionId: string,
): BroadcastPipelineState {
  // R7-1 audit fix: validate identity at factory boundary. Empty/whitespace
  // IDs silently pass attach/detach parity check when rt is also constructed
  // with empty IDs → produces digest with empty-string identity → collides
  // across two distinct sessions that both happened to use empty IDs.
  if (!encounterId || encounterId.trim().length === 0) {
    throw new BroadcastPipelineError(`encounterId must be non-empty (whitespace-only rejected)`);
  }
  if (!sessionId || sessionId.trim().length === 0) {
    throw new BroadcastPipelineError(`sessionId must be non-empty (whitespace-only rejected)`);
  }
  return {
    schemaVersion: SPECTATOR_BROADCAST_SCHEMA_VERSION,
    encounterId,
    sessionId,
    observers: new Map(),
    totalFramesBroadcast: 0,
    totalObserverAttachments: 0,
  };
}

// ─────────────────────────────────────────────────────────
// Attach / detach
// ─────────────────────────────────────────────────────────

export class BroadcastPipelineError extends Error {
  constructor(message: string) {
    super(`[BroadcastPipeline] ${message}`);
    this.name = 'BroadcastPipelineError';
  }
}

export function attachObserver(
  state: BroadcastPipelineState,
  rt: CombatRuntime,
  observerId: string,
  viewer: SpectatorViewerKind = 'spectator',
): Observer {
  if (state.encounterId !== rt.config.encounterId) {
    throw new BroadcastPipelineError(`encounterId mismatch`);
  }
  if (state.sessionId !== rt.config.sessionId) {
    throw new BroadcastPipelineError(
      `sessionId mismatch: state='${state.sessionId}' rt='${rt.config.sessionId}'`,
    );
  }
  // R7-2 audit fix: reject empty / whitespace observerId. Without this, an
  // empty key occupies the Map → digest binds empty observerId → broadcast
  // frame digest collides across distinct attach scenarios. Matches the R4-4 +
  // R6-5 invariant applied to other entry points.
  if (!observerId) {
    throw new BroadcastPipelineError(`observerId must be non-empty`);
  }
  if (observerId.trim().length === 0) {
    throw new BroadcastPipelineError(`observerId must be non-empty (whitespace-only rejected)`);
  }
  if (state.observers.has(observerId)) {
    const existing = state.observers.get(observerId)!;
    if (existing.detachedAtTurn === undefined) {
      throw new BroadcastPipelineError(`observer '${observerId}' already attached`);
    }
    // Re-attach
    existing.detachedAtTurn = undefined;
    existing.attachedAtTurn = rt.currentTurn;
    existing.viewer = viewer;
    state.totalObserverAttachments++;
    return existing;
  }
  const o: Observer = {
    observerId,
    viewer,
    attachedAtTurn: rt.currentTurn,
    nextPacketSeq: 0,
    framesReceived: 0,
  };
  state.observers.set(observerId, o);
  state.totalObserverAttachments++;
  return o;
}

export function detachObserver(
  state: BroadcastPipelineState,
  rt: CombatRuntime,
  observerId: string,
): void {
  // R3-2 audit fix: encounter + session parity guard. detach uses rt.currentTurn
  // for `detachedAtTurn` — a wrong-runtime would inject wrong-session timestamp
  // into observer state. Phase 14 audit fix F6 added these guards to attach +
  // broadcastFrame but missed detach.
  if (state.encounterId !== rt.config.encounterId) {
    throw new BroadcastPipelineError(`encounterId mismatch: state='${state.encounterId}' rt='${rt.config.encounterId}'`);
  }
  if (state.sessionId !== rt.config.sessionId) {
    throw new BroadcastPipelineError(`sessionId mismatch: state='${state.sessionId}' rt='${rt.config.sessionId}'`);
  }
  const o = state.observers.get(observerId);
  if (!o) throw new BroadcastPipelineError(`observer '${observerId}' not attached`);
  if (o.detachedAtTurn !== undefined) {
    throw new BroadcastPipelineError(`observer '${observerId}' already detached`);
  }
  o.detachedAtTurn = rt.currentTurn;
}

// ─────────────────────────────────────────────────────────
// Broadcast frame — produces per-observer packets
// ─────────────────────────────────────────────────────────

export interface BroadcastFrame {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  /** Combat turn at which broadcast was emitted. */
  turn: number;
  /** Shared spectator snapshot — all attached observers see same content. */
  snapshot: SpectatorSnapshot;
  /** Per-observer wire packets (observerId → packet). */
  packetsByObserver: ReadonlyMap<string, CombatPacket>;
  /** Stable digest of the broadcast frame — wire integrity. */
  digest: string;
}

/**
 * Build a broadcast frame for the current combat tick. Each attached observer
 * gets a packet with their own monotonic seq. Snapshot is sanitized once and
 * shared (all observers see same public state).
 *
 * Pure read of CombatRuntime — does NOT mutate state.
 * Mutates BroadcastPipelineState (per-observer seq + framesReceived).
 *
 * Returns frame OR throws if private field leak detected (anti-cheat gate).
 */
export function broadcastFrame(
  state: BroadcastPipelineState,
  rt: CombatRuntime,
): BroadcastFrame {
  if (state.encounterId !== rt.config.encounterId) {
    throw new BroadcastPipelineError(`encounterId mismatch`);
  }
  // sessionId guard: wrapped packets embed rt.config.sessionId (via snapshot)
  // but frame digest embeds state.sessionId. A silent mismatch would emit
  // packets that don't match the frame they belong to.
  if (state.sessionId !== rt.config.sessionId) {
    throw new BroadcastPipelineError(
      `sessionId mismatch: state='${state.sessionId}' rt='${rt.config.sessionId}'`,
    );
  }

  // Single sanitized snapshot — all attached observers receive identical view
  const snapshot = buildSpectatorSnapshot(rt, 'spectator');

  // ANTI-CHEAT GATE — fail loud if private fields leak
  const leaked = detectPrivateFieldLeak(snapshot);
  if (leaked.length > 0) {
    throw new BroadcastPipelineError(
      `private field leak detected: ${leaked.join(', ')} — anti-cheat gate triggered`,
    );
  }

  // Build per-observer packets (only attached observers).
  //
  // HARDENING (Phase 14 § hardening Issue #2): canonical lex-sorted iteration.
  // Per-observer `nextPacketSeq++` mutation MUST NOT depend on Map insertion
  // order — sort observerIds before iterating so identical broadcast state
  // produces identical per-observer mutation regardless of attach order.
  // Packet content itself is per-observer (snapshot shared) and would be
  // deterministic anyway, but explicit sort closes the "implicit insertion
  // order" failure mode flagged in the Phase 14 hardening review.
  //
  // R9-1 audit fix: two-phase commit. Previously the per-observer wrap +
  // mutation happened in the same loop iteration, so if `wrapSpectatorPacket`
  // threw mid-loop (e.g. adversarial state with an externally-mutated
  // `nextPacketSeq`), some observers would have advanced their seq while
  // others wouldn't → partial broadcast state inconsistency, hard to recover
  // from. Phase 1 builds all packets read-only; phase 2 commits mutations
  // only after every wrap succeeded. Any throw in phase 1 leaves observer
  // state untouched (transactional semantics).
  const packetsByObserver = new Map<string, CombatPacket>();
  const sortedKeys = [...state.observers.keys()].sort();
  // Phase 1: build packets (read-only against state.observers); throws here
  // leave per-observer state untouched.
  const pending: { observer: Observer; packet: CombatPacket }[] = [];
  for (const key of sortedKeys) {
    const o = state.observers.get(key)!;
    if (o.detachedAtTurn !== undefined) continue;
    const packet = wrapSpectatorPacket(snapshot, o.nextPacketSeq);
    pending.push({ observer: o, packet });
  }
  // Phase 2: commit (primitive assignments only — no throw risk).
  for (const { observer, packet } of pending) {
    packetsByObserver.set(observer.observerId, packet);
    observer.nextPacketSeq++;
    observer.framesReceived++;
  }
  state.totalFramesBroadcast++;

  // Digest covers schema + encounter identity + turn + snapshot digest +
  // ordered observer list (NOT individual packet seqs which differ per observer).
  //
  // INVARIANT: orderedObservers includes ALL ever-attached observers (including
  // currently-detached) — detachObserver never removes from the map. This keeps
  // the digest a deterministic function of the full attach/detach history so
  // replays must reproduce the same observer-set evolution. Two pipelines that
  // attach the same observer set in the same order will produce the same digest;
  // a pipeline that GC'd detached observers would diverge.
  const orderedObservers = [...state.observers.keys()].sort();
  const digestSource = {
    schemaVersion: SPECTATOR_BROADCAST_SCHEMA_VERSION,
    encounterId: state.encounterId,
    sessionId: state.sessionId,
    turn: rt.currentTurn,
    snapshotDigest: snapshot.digest,
    observers: orderedObservers,
  };

  return {
    schemaVersion: SPECTATOR_BROADCAST_SCHEMA_VERSION,
    encounterId: state.encounterId,
    sessionId: state.sessionId,
    turn: rt.currentTurn,
    snapshot,
    packetsByObserver,
    digest: canonicalHash(digestSource),
  };
}

// ─────────────────────────────────────────────────────────
// Query helpers
// ─────────────────────────────────────────────────────────

export function attachedObservers(state: BroadcastPipelineState): readonly Observer[] {
  // Canonical lex-sorted by observerId — replay-safe iteration.
  // observerId unique within pipeline. Tiebreaker strict-vs-eq mutations
  // EQUIVALENT (equal branch never fires).
  // Stryker disable all
  return [...state.observers.values()]
    .filter((o) => o.detachedAtTurn === undefined)
    .sort((a, b) =>
      a.observerId < b.observerId ? -1 : a.observerId > b.observerId ? 1 : 0,
    );
  // Stryker restore all
}

export function observerCount(state: BroadcastPipelineState): number {
  return attachedObservers(state).length;
}

export function observersByViewer(
  state: BroadcastPipelineState,
  viewer: SpectatorViewerKind,
): readonly Observer[] {
  return attachedObservers(state).filter((o) => o.viewer === viewer);
}

// ─────────────────────────────────────────────────────────
// Comparison + verification
// ─────────────────────────────────────────────────────────

export interface BroadcastFrameDivergence {
  divergent: boolean;
  reason?: 'digest_mismatch' | 'turn_mismatch' | 'observer_set_mismatch';
}

export function compareBroadcastFrames(
  expected: BroadcastFrame,
  actual: BroadcastFrame,
): BroadcastFrameDivergence {
  if (expected.digest !== actual.digest) {
    if (expected.turn !== actual.turn) return { divergent: true, reason: 'turn_mismatch' };
    if (expected.packetsByObserver.size !== actual.packetsByObserver.size) {
      return { divergent: true, reason: 'observer_set_mismatch' };
    }
    return { divergent: true, reason: 'digest_mismatch' };
  }
  return { divergent: false };
}

/**
 * Verify a broadcast frame contains NO private field leak across any observer
 * packet. This is the secondary anti-cheat gate (primary is in broadcastFrame).
 */
export interface BroadcastLeakReport {
  clean: boolean;
  leakedFields: readonly string[];
}

export function verifyBroadcastLeakSafe(frame: BroadcastFrame): BroadcastLeakReport {
  const leaked = detectPrivateFieldLeak(frame.snapshot);
  return {
    clean: leaked.length === 0,
    leakedFields: leaked,
  };
}
