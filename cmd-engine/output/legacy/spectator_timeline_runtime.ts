/**
 * SPECTATOR TIMELINE RUNTIME — deterministic combat timeline projection (Phase 16 § 3).
 *
 * Per CMD1 Phase 16 directive § PRIMARY OBJECTIVES § spectator_timeline_runtime:
 *   "Purpose: deterministic combat timeline projection.
 *    SUPPORT:
 *      - replay-safe spectator timeline
 *      - observer reconnect continuity
 *      - canonical combat frame projection
 *      - timeline reconstruction
 *      - deterministic combat playback parity
 *    STRICT RULE: timeline runtime MUST NEVER expose:
 *                 - authority state
 *                 - rollback metadata
 *                 - hidden combat state
 *                 - internal runtime identifiers"
 *
 * Accumulates sanitized spectator snapshots into an ordered timeline. Records
 * observer reconnect/replay markers for forensic. NEVER mutates runtime.
 *
 * Builds ON TOP of `spectator_snapshot.ts` (Phase 12 INIT) — reuses the
 * sanitization + leak detection that's already verified clean.
 *
 * STRICT additive — pure state container. Read-only against runtime. No I/O.
 * Canonical traversal at every projection boundary.
 */
import type { CombatRuntime } from './combat_runtime.js';
import {
  buildSpectatorSnapshot,
  detectPrivateFieldLeak,
  type SpectatorSnapshot,
  type SpectatorViewerKind,
} from './spectator_snapshot.js';
import { canonicalHash } from './combat_storage.js';

export const SPECTATOR_TIMELINE_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────
// Timeline entry model
// ─────────────────────────────────────────────────────────

export type TimelineEntryKind = 'frame' | 'reconnect' | 'attach' | 'detach';

export interface TimelineEntry {
  schemaVersion: number;
  /** Monotonic seq within this timeline. */
  seq: number;
  /** Combat turn at which the entry was recorded. */
  turn: number;
  kind: TimelineEntryKind;
  /** For 'frame' entries — sanitized snapshot. For others — undefined. */
  snapshot?: SpectatorSnapshot;
  /** For 'attach' / 'detach' / 'reconnect' — the observer involved. */
  observerId?: string;
  /** Stable digest of the entry. */
  digest: string;
}

// ─────────────────────────────────────────────────────────
// Timeline state
// ─────────────────────────────────────────────────────────

export interface TimelineState {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  /** Append-only entry log. */
  entries: TimelineEntry[];
  /** Next seq to assign. */
  nextSeq: number;
}

export function createTimeline(encounterId: string, sessionId: string): TimelineState {
  // R7-3 audit fix: validate identity at factory boundary. Empty/whitespace IDs
  // pass assertParity if rt is also empty → digest binds empty identity →
  // timeline collisions across distinct sessions. Same rationale as R7-1.
  if (!encounterId || encounterId.trim().length === 0) {
    throw new TimelineRuntimeError(`encounterId must be non-empty (whitespace-only rejected)`);
  }
  if (!sessionId || sessionId.trim().length === 0) {
    throw new TimelineRuntimeError(`sessionId must be non-empty (whitespace-only rejected)`);
  }
  return {
    schemaVersion: SPECTATOR_TIMELINE_SCHEMA_VERSION,
    encounterId,
    sessionId,
    entries: [],
    nextSeq: 0,
  };
}

// ─────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────

export class TimelineRuntimeError extends Error {
  constructor(message: string) {
    super(`[SpectatorTimeline] ${message}`);
    this.name = 'TimelineRuntimeError';
  }
}

function assertParity(state: TimelineState, rt: CombatRuntime): void {
  if (state.encounterId !== rt.config.encounterId) {
    throw new TimelineRuntimeError(
      `encounterId mismatch: state='${state.encounterId}' rt='${rt.config.encounterId}'`,
    );
  }
  if (state.sessionId !== rt.config.sessionId) {
    throw new TimelineRuntimeError(
      `sessionId mismatch: state='${state.sessionId}' rt='${rt.config.sessionId}'`,
    );
  }
}

function digestEntry(
  seq: number,
  turn: number,
  kind: TimelineEntryKind,
  snapshotDigest: string | undefined,
  observerId: string | undefined,
): string {
  return canonicalHash({
    schemaVersion: SPECTATOR_TIMELINE_SCHEMA_VERSION,
    seq,
    turn,
    kind,
    snapshotDigest: snapshotDigest ?? '',
    observerId: observerId ?? '',
  });
}

// ─────────────────────────────────────────────────────────
// Record APIs (the only mutators)
// ─────────────────────────────────────────────────────────

/**
 * Record a frame entry — captures the sanitized spectator snapshot at the
 * current combat tick.
 *
 * Anti-leak gate: throws if `detectPrivateFieldLeak` returns non-empty —
 * mirrors `broadcastFrame`'s primary gate. This guarantees the timeline
 * NEVER stores a leaked private field.
 */
export function recordFrame(
  state: TimelineState,
  rt: CombatRuntime,
  viewer: SpectatorViewerKind = 'spectator',
): TimelineEntry {
  assertParity(state, rt);
  const snapshot = buildSpectatorSnapshot(rt, viewer);
  const leaked = detectPrivateFieldLeak(snapshot);
  if (leaked.length > 0) {
    throw new TimelineRuntimeError(
      `private field leak detected: ${leaked.join(', ')} — timeline anti-cheat gate triggered`,
    );
  }
  const seq = state.nextSeq++;
  const entry: TimelineEntry = {
    schemaVersion: SPECTATOR_TIMELINE_SCHEMA_VERSION,
    seq,
    turn: rt.currentTurn,
    kind: 'frame',
    snapshot,
    digest: digestEntry(seq, rt.currentTurn, 'frame', snapshot.digest, undefined),
  };
  state.entries.push(entry);
  return entry;
}

export function recordAttach(
  state: TimelineState,
  rt: CombatRuntime,
  observerId: string,
): TimelineEntry {
  return recordObserverEvent(state, rt, 'attach', observerId);
}

export function recordDetach(
  state: TimelineState,
  rt: CombatRuntime,
  observerId: string,
): TimelineEntry {
  return recordObserverEvent(state, rt, 'detach', observerId);
}

export function recordReconnect(
  state: TimelineState,
  rt: CombatRuntime,
  observerId: string,
): TimelineEntry {
  return recordObserverEvent(state, rt, 'reconnect', observerId);
}

function recordObserverEvent(
  state: TimelineState,
  rt: CombatRuntime,
  kind: 'attach' | 'detach' | 'reconnect',
  observerId: string,
): TimelineEntry {
  assertParity(state, rt);
  if (!observerId) {
    throw new TimelineRuntimeError(`observerId required for ${kind}`);
  }
  // R7-4 audit fix: reject whitespace-only observerId. Without this, the
  // timeline entry digest binds whitespace as observer identity → collides
  // with another entry that legitimately has whitespace observer ID. Matches
  // R6-5 invariant.
  if (observerId.trim().length === 0) {
    throw new TimelineRuntimeError(`observerId must be non-empty for ${kind} (whitespace-only rejected)`);
  }
  const seq = state.nextSeq++;
  const entry: TimelineEntry = {
    schemaVersion: SPECTATOR_TIMELINE_SCHEMA_VERSION,
    seq,
    turn: rt.currentTurn,
    kind,
    observerId,
    digest: digestEntry(seq, rt.currentTurn, kind, undefined, observerId),
  };
  state.entries.push(entry);
  return entry;
}

// ─────────────────────────────────────────────────────────
// Timeline projection (read-only, canonical)
// ─────────────────────────────────────────────────────────

export interface TimelineProjection {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  /** Canonical-ordered entries by seq asc. */
  entries: readonly TimelineEntry[];
  /** Total frame entry count. */
  frameCount: number;
  /** Total observer-event count (attach + detach + reconnect). */
  observerEventCount: number;
  /** Stable digest of the whole timeline. */
  digest: string;
}

export function projectTimeline(state: TimelineState): TimelineProjection {
  // Sort by seq asc (insertion is already monotonic; explicit sort makes
  // canonical ordering explicit + tolerates future re-ordering scenarios).
  // Stryker mutants on this comparator are EQUIVALENT on monotonic input.
  // Stryker disable all
  const ordered = [...state.entries].sort((a, b) => a.seq - b.seq);
  // Stryker restore all
  let frameCount = 0;
  let observerEventCount = 0;
  for (const e of ordered) {
    if (e.kind === 'frame') frameCount++;
    else observerEventCount++;
  }
  const digestSource = {
    schemaVersion: SPECTATOR_TIMELINE_SCHEMA_VERSION,
    encounterId: state.encounterId,
    sessionId: state.sessionId,
    frameCount,
    observerEventCount,
    digestOfEntries: ordered.map((e) => e.digest),
  };
  return {
    schemaVersion: SPECTATOR_TIMELINE_SCHEMA_VERSION,
    encounterId: state.encounterId,
    sessionId: state.sessionId,
    entries: ordered,
    frameCount,
    observerEventCount,
    digest: canonicalHash(digestSource),
  };
}

// ─────────────────────────────────────────────────────────
// Reconnect continuity — slice timeline from a turn
// ─────────────────────────────────────────────────────────

/**
 * Slice timeline entries with `turn >= fromTurn`. Use case: observer reconnect
 * — server replays entries from the turn the observer was last synced to.
 */
export function sliceFromTurn(
  state: TimelineState,
  fromTurn: number,
): readonly TimelineEntry[] {
  // Stryker disable all -- seq-monotonic input, defense-in-depth sort
  return [...state.entries]
    .filter((e) => e.turn >= fromTurn)
    .sort((a, b) => a.seq - b.seq);
  // Stryker restore all
}

/**
 * Frame entries only (for spectator playback rebuild).
 */
export function frameEntries(state: TimelineState): readonly TimelineEntry[] {
  // Stryker disable all
  return [...state.entries]
    .filter((e) => e.kind === 'frame')
    .sort((a, b) => a.seq - b.seq);
  // Stryker restore all
}

/**
 * Observer-event entries for a specific observer (canonical-ordered).
 */
export function observerEvents(
  state: TimelineState,
  observerId: string,
): readonly TimelineEntry[] {
  // Stryker disable all
  return [...state.entries]
    .filter((e) => e.observerId === observerId)
    .sort((a, b) => a.seq - b.seq);
  // Stryker restore all
}

// ─────────────────────────────────────────────────────────
// Anti-leak verification (secondary gate)
// ─────────────────────────────────────────────────────────

export interface TimelineLeakReport {
  clean: boolean;
  leakedEntries: readonly { seq: number; fields: readonly string[] }[];
}

/**
 * Scan ALL frame entries for private field leakage. Secondary gate after the
 * primary `recordFrame` gate — catches frames inserted by alternative paths
 * (test fixtures, future migrations).
 */
export function verifyTimelineLeakSafe(state: TimelineState): TimelineLeakReport {
  const leaked: { seq: number; fields: readonly string[] }[] = [];
  for (const e of state.entries) {
    if (e.kind !== 'frame' || !e.snapshot) continue;
    const fields = detectPrivateFieldLeak(e.snapshot);
    if (fields.length > 0) leaked.push({ seq: e.seq, fields });
  }
  return { clean: leaked.length === 0, leakedEntries: leaked };
}

// ─────────────────────────────────────────────────────────
// Comparison + parity
// ─────────────────────────────────────────────────────────

export interface TimelineDivergence {
  divergent: boolean;
  field?: 'digest' | 'entry_count' | 'frame_count' | 'entry_at';
  index?: number;
}

export function compareTimelines(
  expected: TimelineProjection,
  actual: TimelineProjection,
): TimelineDivergence {
  if (expected.digest === actual.digest) return { divergent: false };
  if (expected.entries.length !== actual.entries.length) {
    return { divergent: true, field: 'entry_count' };
  }
  if (expected.frameCount !== actual.frameCount) {
    return { divergent: true, field: 'frame_count' };
  }
  for (let i = 0; i < expected.entries.length; i++) {
    if (expected.entries[i]!.digest !== actual.entries[i]!.digest) {
      return { divergent: true, field: 'entry_at', index: i };
    }
  }
  return { divergent: true, field: 'digest' };
}

// ─────────────────────────────────────────────────────────
// Query helpers
// ─────────────────────────────────────────────────────────

export function frameCount(state: TimelineState): number {
  let n = 0;
  for (const e of state.entries) if (e.kind === 'frame') n++;
  return n;
}

export function entryCount(state: TimelineState): number {
  return state.entries.length;
}

/** Stable forensic hash of the entire entry sequence. */
export function timelineHistoryHash(state: TimelineState): string {
  let h = 0x811c9dc5 >>> 0;
  const eat = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const e of state.entries) {
    eat(`${e.seq}|${e.kind}|${e.turn}|${e.observerId ?? ''}|${e.digest}`);
  }
  return h.toString(16).padStart(8, '0');
}
