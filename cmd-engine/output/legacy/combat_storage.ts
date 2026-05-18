/**
 * COMBAT STORAGE — abstract persistence interface (Phase 12 INIT).
 *
 * Per CMD1 1.docx Phase 12 DECISION 2 (p3): caller injects backend.
 * Combat runtime MUST NOT know whether storage is memory / file / DB / cloud.
 *
 * Storage adapter layer is the ONLY layer that knows persistence backend.
 * This preserves clean MMORPG infrastructure boundaries.
 *
 * MANDATORY RULES:
 *   - deterministic contracts
 *   - canonical-serialization-safe
 *   - migration-safe (schema versioned)
 *   - backend-agnostic
 *   - no hardcoded filesystem dependency
 *   - no async timing dependency in replay path (SYNC interface)
 *
 * FORBIDDEN:
 *   - real DB integration (caller adapts to their DB)
 *   - filesystem-heavy orchestration in this layer
 *   - async pipelines
 *
 * Default impl: `InMemoryCombatStorage` — for test + dev. Production caller
 * implements `CombatStorage` interface with their own backend (file/DB/cloud).
 */

import type { ReplayFrame } from './replay_frame.js';
import type { StreamEvent } from './replay_event_stream.js';

// ─────────────────────────────────────────────────────────
// Combat snapshot — canonical serialization shape
// ─────────────────────────────────────────────────────────

/**
 * Versioned envelope for all persisted combat data. Bump
 * `STORAGE_SCHEMA_VERSION` when changing serialization shape.
 */
export const STORAGE_SCHEMA_VERSION = 1;

export interface CombatSnapshot {
  /** Storage schema version — caller validates on load. */
  schemaVersion: number;
  /** Encounter identity. */
  encounterId: string;
  sessionId: string;
  /** Turn at which snapshot was taken. */
  takenAtTurn: number;
  /** Canonical payload — INT-only, stable field ordering. Opaque to storage. */
  payload: Readonly<Record<string, unknown>>;
}

/**
 * Replay chunk — append-only block of frames + events.
 * Multiple chunks per encounter form the full replay log.
 */
export interface ReplayChunk {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  /** Chunk sequence number (0, 1, 2, ...) — caller appends in order. */
  chunkSeq: number;
  /** First / last turn covered by this chunk (inclusive). */
  turnFrom: number;
  turnTo: number;
  frames: readonly ReplayFrame[];
  events: readonly StreamEvent[];
}

// ─────────────────────────────────────────────────────────
// Abstract Storage contract
// ─────────────────────────────────────────────────────────

/**
 * Pure deterministic, sync storage interface. No Promise, no timing dependency,
 * no runtime mutation. Caller may wrap async backends behind sync facade or
 * provide their own async variant for non-replay paths.
 */
export interface CombatStorage {
  /** Persist a snapshot. Overwrites previous snapshot for same encounterId. */
  saveSnapshot(snapshot: CombatSnapshot): void;

  /** Load snapshot for encounterId. Returns undefined if none. */
  loadSnapshot(encounterId: string): CombatSnapshot | undefined;

  /**
   * Append a replay chunk. Chunks MUST arrive in ascending `chunkSeq`. Storage
   * MUST reject out-of-order chunks (throws `ReplayChunkOrderError`).
   */
  appendReplayChunk(chunk: ReplayChunk): void;

  /** Load ALL replay chunks for encounterId, in chunkSeq order. */
  loadReplay(encounterId: string): readonly ReplayChunk[];

  /** Optional — list known encounter IDs (test/diagnostic). */
  listEncounters?(): readonly string[];

  /** Optional — clear all data (test teardown). NEVER production. */
  clearAll?(): void;
}

// ─────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────

export class CombatStorageSchemaError extends Error {
  constructor(
    public readonly recordedVersion: number,
    public readonly currentVersion: number,
  ) {
    super(
      `[CombatStorage] schema version mismatch: recorded=${recordedVersion} current=${currentVersion}`,
    );
    this.name = 'CombatStorageSchemaError';
  }
}

export class ReplayChunkOrderError extends Error {
  constructor(
    public readonly encounterId: string,
    public readonly expectedSeq: number,
    public readonly receivedSeq: number,
  ) {
    super(
      `[CombatStorage] replay chunk out of order for ${encounterId}: expected=${expectedSeq} received=${receivedSeq}`,
    );
    this.name = 'ReplayChunkOrderError';
  }
}

// ─────────────────────────────────────────────────────────
// InMemoryCombatStorage — default impl for test + dev
// ─────────────────────────────────────────────────────────

export class InMemoryCombatStorage implements CombatStorage {
  private snapshots = new Map<string, CombatSnapshot>();
  private chunks = new Map<string, ReplayChunk[]>();

  saveSnapshot(snapshot: CombatSnapshot): void {
    this.snapshots.set(snapshot.encounterId, snapshot);
  }

  loadSnapshot(encounterId: string): CombatSnapshot | undefined {
    return this.snapshots.get(encounterId);
  }

  appendReplayChunk(chunk: ReplayChunk): void {
    const list = this.chunks.get(chunk.encounterId) ?? [];
    const expectedSeq = list.length;
    if (chunk.chunkSeq !== expectedSeq) {
      throw new ReplayChunkOrderError(chunk.encounterId, expectedSeq, chunk.chunkSeq);
    }
    list.push(chunk);
    this.chunks.set(chunk.encounterId, list);
  }

  loadReplay(encounterId: string): readonly ReplayChunk[] {
    return this.chunks.get(encounterId) ?? [];
  }

  listEncounters(): readonly string[] {
    const ids = new Set<string>();
    for (const id of this.snapshots.keys()) ids.add(id);
    for (const id of this.chunks.keys()) ids.add(id);
    return [...ids].sort();          // canonical ordering — deterministic
  }

  clearAll(): void {
    this.snapshots.clear();
    this.chunks.clear();
  }

  // Diagnostic accessors
  snapshotCount(): number { return this.snapshots.size; }
  chunkCount(encounterId: string): number { return this.chunks.get(encounterId)?.length ?? 0; }
}

// ─────────────────────────────────────────────────────────
// Canonical JSON serialization helper
// ─────────────────────────────────────────────────────────

/**
 * Serialize value to JSON with CANONICAL key ordering.
 * Same input → same string ALWAYS. Used for hashing / wire / persistence.
 *
 * NOTE: Date / Map / Set / Symbol / BigInt are NOT supported in payloads —
 * callers must convert to INT / string / array / plain object before serializing.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();       // deterministic order
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ':' + canonicalJson(obj[k]));
  }
  return '{' + parts.join(',') + '}';
}

/**
 * FNV-1a hash of canonical JSON — stable cross-platform fingerprint.
 * Replay determinism check: same value → same hash ALWAYS.
 */
export function canonicalHash(value: unknown): string {
  const s = canonicalJson(value);
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
