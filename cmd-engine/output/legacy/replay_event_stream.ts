/**
 * REPLAY EVENT STREAM — append-only event log per encounter (Phase 6).
 *
 * Two complementary append-only logs for rollback-safe replay:
 *
 *   1. Frame log     — one ReplayFrame per turn (turn-granular snapshot)
 *   2. Event log     — per-event records emitted during the turn (intra-turn order)
 *
 * Frames are the canonical replay unit (replay rewinds to turn boundaries).
 * Events are diagnostic / forensic (intra-turn ordering, RNG trace, mechanic timeline).
 *
 * Stream is append-only — no in-place mutation. Rollback truncates the tail.
 *
 * Deterministic: events stored in caller emit order. Frames sealed via finalizeFrame.
 *
 * Storage backend agnostic — caller may persist to disk / db / wire via `flush()`.
 */
import type { ReplayFrame } from './replay_frame.js';

export type StreamEventKind =
  | 'skill_cast'
  | 'damage'
  | 'heal'
  | 'status_apply'
  | 'status_remove'
  | 'status_tick'
  | 'boss_decision'
  | 'phase_transition'
  | 'mechanic_scheduled'
  | 'mechanic_resolved'
  | 'spatial_move'
  | 'spatial_knockback'
  | 'spatial_pull'
  | 'spatial_aoe_placed'
  | 'spatial_aoe_resolved'
  | 'proximity_triggered'
  | 'companion_swap'
  | 'companion_revive'
  | 'formation_reset'
  | 'rng_consumed'
  | 'wipe'
  | 'leash'
  | 'cinematic_lock_on'
  | 'cinematic_lock_off'
  | 'custom';

export interface StreamEvent {
  /** Monotonic id per stream — replay tiebreak. */
  seq: number;
  turn: number;
  kind: StreamEventKind;
  /** Compact payload — caller stamps minimal info needed for replay. */
  payload: Readonly<Record<string, unknown>>;
}

export interface ReplayEventStream {
  encounterId: string;
  sessionId: string;
  frames: ReplayFrame[];
  events: StreamEvent[];
  /** Monotonic event sequence. */
  nextEventSeq: number;
  /** Turn of last sealed frame. */
  lastFrameTurn: number;
  /** Schema version for forward-compat. */
  schemaVersion: number;
}

export function createReplayStream(encounterId: string, sessionId: string): ReplayEventStream {
  return {
    encounterId,
    sessionId,
    frames: [],
    events: [],
    nextEventSeq: 0,
    lastFrameTurn: -1,
    schemaVersion: 1,
  };
}

// ─────────────────────────────────────────────────────────
// Sanitizer pipeline (Phase 11B § IX)
// Each sanitizer is applied BEFORE appendEvent stores the payload.
// Use case: replay_payload_sanitizer.ts strips non-deterministic fields
// (timestamp/wall_time/process_pid/hostname/...) so replay drift is impossible.
// ─────────────────────────────────────────────────────────

export type ReplayPayloadSanitizer = (
  payload: Readonly<Record<string, unknown>>,
) => Readonly<Record<string, unknown>>;

interface SanitizerEntry {
  key: string;       // dedup key — same key = single registration
  fn: ReplayPayloadSanitizer;
}

const _sanitizers: SanitizerEntry[] = [];

/**
 * Register a sanitizer applied to every payload BEFORE it is appended.
 *
 * **Idempotent by `key`** (per CMD1 1.docx FINAL HARDENING § VIII):
 * - If a sanitizer with the same `key` is already installed, the existing
 *   uninstaller is returned. NO duplicate entry is added.
 * - Default key = `'__anonymous__' + counter` (unique per call) — preserves
 *   legacy non-idempotent behaviour when caller omits key.
 *
 * Returns an uninstaller — caller (orchestrator) MUST call it at encounter
 * teardown to avoid cross-encounter leakage.
 *
 * Per CMD1 PHASE 11B FINALIZATION § IX: "HOOK: replay_payload_sanitizer
 * BEFORE: replay append/write."
 */
let _anonCounter = 0;
export function installReplaySanitizer(
  fn: ReplayPayloadSanitizer,
  key?: string,
): () => void {
  const dedupKey = key ?? `__anonymous__${_anonCounter++}`;
  const existing = _sanitizers.find((s) => s.key === dedupKey);
  if (existing) {
    // Idempotent — return uninstaller for the EXISTING entry; do not push duplicate.
    return () => {
      const idx = _sanitizers.findIndex((s) => s.key === dedupKey);
      if (idx >= 0) _sanitizers.splice(idx, 1);
    };
  }
  _sanitizers.push({ key: dedupKey, fn });
  return () => {
    const idx = _sanitizers.findIndex((s) => s.key === dedupKey);
    if (idx >= 0) _sanitizers.splice(idx, 1);
  };
}

/** Read-only access to installed sanitizer count (test/diagnostic). */
export function installedSanitizerCount(): number {
  return _sanitizers.length;
}

/** Read installed sanitizer keys (diagnostic). */
export function installedSanitizerKeys(): readonly string[] {
  return _sanitizers.map((s) => s.key);
}

/** Diagnostic: drop all installed sanitizers. Use in test teardown ONLY. */
export function clearReplaySanitizers(): void {
  _sanitizers.length = 0;
  _anonCounter = 0;
}

export function appendEvent(
  stream: ReplayEventStream,
  turn: number,
  kind: StreamEventKind,
  payload: Readonly<Record<string, unknown>> = {},
): StreamEvent {
  let cleaned: Readonly<Record<string, unknown>> = payload;
  for (const entry of _sanitizers) {
    cleaned = entry.fn(cleaned);
  }
  const ev: StreamEvent = {
    seq: stream.nextEventSeq++,
    turn,
    kind,
    payload: cleaned,
  };
  stream.events.push(ev);
  return ev;
}

export function appendFrame(stream: ReplayEventStream, frame: ReplayFrame): void {
  if (frame.turn <= stream.lastFrameTurn) {
    throw new Error(
      `[ReplayStream] frame turn ${frame.turn} not monotonic (last=${stream.lastFrameTurn})`,
    );
  }
  if (frame.sessionId !== stream.sessionId) {
    throw new Error(
      `[ReplayStream] frame sessionId '${frame.sessionId}' != stream sessionId '${stream.sessionId}'`,
    );
  }
  stream.frames.push(frame);
  stream.lastFrameTurn = frame.turn;
}

// ─────────────────────────────────────────────────────────
// Query helpers
// ─────────────────────────────────────────────────────────

export function eventsAtTurn(stream: ReplayEventStream, turn: number): readonly StreamEvent[] {
  return stream.events.filter((e) => e.turn === turn);
}

export function eventsOfKind(
  stream: ReplayEventStream,
  kind: StreamEventKind,
): readonly StreamEvent[] {
  return stream.events.filter((e) => e.kind === kind);
}

export function frameAtTurn(stream: ReplayEventStream, turn: number): ReplayFrame | undefined {
  return stream.frames.find((f) => f.turn === turn);
}

// ─────────────────────────────────────────────────────────
// Rollback — truncate tail (rollback-safe event stream)
// ─────────────────────────────────────────────────────────

/**
 * Truncate stream to last sealed frame at or before `targetTurn`.
 * Used by server rollback path.
 *
 * Drops:
 *   - all frames with turn > targetTurn
 *   - all events with turn > targetTurn
 *
 * Resets `lastFrameTurn` and event counter accordingly.
 */
export function rollbackTo(stream: ReplayEventStream, targetTurn: number): {
  framesDropped: number;
  eventsDropped: number;
} {
  const frameCutoff = stream.frames.findIndex((f) => f.turn > targetTurn);
  const eventCutoff = stream.events.findIndex((e) => e.turn > targetTurn);
  const framesDropped = frameCutoff >= 0 ? stream.frames.length - frameCutoff : 0;
  const eventsDropped = eventCutoff >= 0 ? stream.events.length - eventCutoff : 0;
  if (frameCutoff >= 0) stream.frames.length = frameCutoff;
  if (eventCutoff >= 0) stream.events.length = eventCutoff;
  // Recompute lastFrameTurn from remaining frames
  stream.lastFrameTurn = stream.frames.length > 0
    ? stream.frames[stream.frames.length - 1]!.turn
    : -1;
  // nextEventSeq must not regress for new events to remain monotonic in this stream.
  // Caller chose rollback semantics: keep counter advancing (audit trail) — events
  // appended after rollback have higher seq than dropped events.
  return { framesDropped, eventsDropped };
}

// ─────────────────────────────────────────────────────────
// Replay verification
// ─────────────────────────────────────────────────────────

export interface DivergenceReport {
  divergent: boolean;
  firstDivergentTurn?: number;
  expectedChecksum?: string;
  actualChecksum?: string;
}

/**
 * Compare two streams frame-by-frame. Returns divergence info.
 *
 * Use case: run replay deterministic check — re-execute encounter with same seed
 * and assert frames match expected stream.
 */
export function compareStreams(
  expected: ReplayEventStream,
  actual: ReplayEventStream,
): DivergenceReport {
  const minLen = Math.min(expected.frames.length, actual.frames.length);
  for (let i = 0; i < minLen; i++) {
    const e = expected.frames[i]!;
    const a = actual.frames[i]!;
    if (e.checksum !== a.checksum) {
      return {
        divergent: true,
        firstDivergentTurn: e.turn,
        expectedChecksum: e.checksum,
        actualChecksum: a.checksum,
      };
    }
  }
  if (expected.frames.length !== actual.frames.length) {
    return {
      divergent: true,
      firstDivergentTurn: minLen,
      expectedChecksum: expected.frames[minLen]?.checksum,
      actualChecksum: actual.frames[minLen]?.checksum,
    };
  }
  return { divergent: false };
}

export function totalEvents(stream: ReplayEventStream): number {
  return stream.events.length;
}

export function totalFrames(stream: ReplayEventStream): number {
  return stream.frames.length;
}
