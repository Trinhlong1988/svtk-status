/**
 * PERSISTENCE SNAPSHOT — combat snapshot save/load via abstract storage (Phase 12 INIT).
 *
 * Per CMD1 1.docx Phase 12 § X:
 *   "PREPARE combat persistence integration.
 *    SUPPORT: combat snapshot save/load /
 *             replay-safe restore /
 *             deterministic recovery checkpoints /
 *             migration-safe combat snapshots.
 *    MANDATORY: same snapshot = same restore ALWAYS."
 *
 * + § VII rollback-safe recovery:
 *   "MANDATORY: same rollback state = same restored combat ALWAYS."
 *
 * Combat runtime does NOT know whether storage is memory/disk/DB.
 * This module orchestrates save/load via injected `CombatStorage`.
 *
 * STRICT ADDITIVE — pure read of CombatRuntime, pure write to CombatStorage.
 *
 * Schema migrations: caller registers `SnapshotMigration` per (from, to) version
 * pair. `loadAndMigrate` walks chain until current version reached.
 */
import type { CombatRuntime } from './combat_runtime.js';
import {
  buildCombatPayload,
  type CombatPayload,
  COMBAT_PAYLOAD_SCHEMA_VERSION,
} from './combat_payload_builder.js';
import {
  type CombatStorage,
  type CombatSnapshot,
  type ReplayChunk,
  STORAGE_SCHEMA_VERSION,
  CombatStorageSchemaError,
} from './combat_storage.js';
import type { ReplayFrame } from './replay_frame.js';
import type { StreamEvent } from './replay_event_stream.js';

// ─────────────────────────────────────────────────────────
// Save snapshot
// ─────────────────────────────────────────────────────────

/**
 * Capture a CombatSnapshot from live runtime and persist via storage.
 * Returns the snapshot for caller introspection (hash / wire forwarding).
 *
 * Deterministic: same rt state → same snapshot bytes.
 */
export function saveSnapshot(rt: CombatRuntime, storage: CombatStorage): CombatSnapshot {
  const payload = buildCombatPayload(rt);
  const snapshot: CombatSnapshot = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    encounterId: rt.config.encounterId,
    sessionId: rt.config.sessionId,
    takenAtTurn: rt.currentTurn,
    payload: payload as unknown as Readonly<Record<string, unknown>>,
  };
  storage.saveSnapshot(snapshot);
  return snapshot;
}

// ─────────────────────────────────────────────────────────
// Load snapshot
// ─────────────────────────────────────────────────────────

export interface LoadedSnapshot {
  snapshot: CombatSnapshot;
  payload: CombatPayload;
  /** True if a migration was applied to reach current schema version. */
  migrated: boolean;
}

/**
 * Load snapshot + migrate to current schema version if applicable.
 * Throws `CombatStorageSchemaError` if no migration path exists.
 */
export function loadAndMigrateSnapshot(
  encounterId: string,
  storage: CombatStorage,
  migrations: SnapshotMigrationRegistry = defaultMigrationRegistry,
): LoadedSnapshot | undefined {
  const raw = storage.loadSnapshot(encounterId);
  if (!raw) return undefined;
  const migrated = migrations.migrate(raw);
  const payload = migrated.snapshot.payload as unknown as CombatPayload;
  // Validate payload schema version matches current
  if (payload.schemaVersion !== COMBAT_PAYLOAD_SCHEMA_VERSION) {
    throw new CombatStorageSchemaError(
      payload.schemaVersion,
      COMBAT_PAYLOAD_SCHEMA_VERSION,
    );
  }
  return {
    snapshot: migrated.snapshot,
    payload,
    migrated: migrated.appliedSteps > 0,
  };
}

// ─────────────────────────────────────────────────────────
// Append + load replay chunks (incremental persistence)
// ─────────────────────────────────────────────────────────

export interface ReplayChunkInput {
  encounterId: string;
  sessionId: string;
  chunkSeq: number;
  turnFrom: number;
  turnTo: number;
  frames: readonly ReplayFrame[];
  events: readonly StreamEvent[];
}

/**
 * Build + append a replay chunk to storage. Chunks MUST be appended in
 * ascending `chunkSeq` order — storage rejects out-of-order.
 */
export function appendReplayChunk(
  storage: CombatStorage,
  input: ReplayChunkInput,
): ReplayChunk {
  const chunk: ReplayChunk = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    encounterId: input.encounterId,
    sessionId: input.sessionId,
    chunkSeq: input.chunkSeq,
    turnFrom: input.turnFrom,
    turnTo: input.turnTo,
    frames: input.frames,
    events: input.events,
  };
  storage.appendReplayChunk(chunk);
  return chunk;
}

/**
 * Build a chunk from runtime's replay stream.
 *
 * Two modes:
 *   - **Full** (default — `fromTurn` omitted): chunk contains ALL frames/events.
 *     Use case: one-shot whole-encounter persistence.
 *   - **Delta** (`fromTurn` provided): chunk contains ONLY frames/events with
 *     `turn ≥ fromTurn`. Use case: periodic checkpoint scheduler — each chunk
 *     captures the delta since last checkpoint, preventing quadratic growth.
 *
 * Caller is responsible for passing the correct `fromTurn` (= last checkpoint
 * turn + 1) so chunks tile the encounter without overlap or gap.
 *
 * Per CMD1 1.docx Phase 13 FIX #3 (delta checkpoint strategy):
 *   "checkpoint growth MUST scale linearly, NOT quadratically."
 */
export function snapshotReplayAsChunk(
  rt: CombatRuntime,
  chunkSeq: number,
  fromTurn?: number,
): ReplayChunkInput {
  const allFrames = rt.replayStream.frames;
  const allEvents = rt.replayStream.events;
  const frames = fromTurn === undefined
    ? allFrames
    : allFrames.filter((f) => f.turn >= fromTurn);
  const events = fromTurn === undefined
    ? allEvents
    : allEvents.filter((e) => e.turn >= fromTurn);
  return {
    encounterId: rt.config.encounterId,
    sessionId: rt.config.sessionId,
    chunkSeq,
    turnFrom: frames.length > 0 ? frames[0]!.turn : (fromTurn ?? 0),
    turnTo: frames.length > 0 ? frames[frames.length - 1]!.turn : (fromTurn ?? 0),
    frames,
    events,
  };
}

// ─────────────────────────────────────────────────────────
// Migration registry
// ─────────────────────────────────────────────────────────

export interface SnapshotMigration {
  fromVersion: number;
  toVersion: number;
  /** Pure function — takes raw snapshot, returns migrated. */
  migrate(input: CombatSnapshot): CombatSnapshot;
}

export class SnapshotMigrationRegistry {
  private byFrom = new Map<number, SnapshotMigration>();

  register(m: SnapshotMigration): void {
    if (this.byFrom.has(m.fromVersion)) {
      throw new Error(`[Migration] duplicate fromVersion=${m.fromVersion}`);
    }
    if (m.toVersion !== m.fromVersion + 1) {
      throw new Error(`[Migration] only adjacent versions supported (got ${m.fromVersion}→${m.toVersion})`);
    }
    this.byFrom.set(m.fromVersion, m);
  }

  /**
   * Walk migration chain from snapshot.schemaVersion → STORAGE_SCHEMA_VERSION.
   * Throws CombatStorageSchemaError if no path.
   */
  migrate(snapshot: CombatSnapshot): { snapshot: CombatSnapshot; appliedSteps: number } {
    let cur = snapshot;
    let steps = 0;
    while (cur.schemaVersion < STORAGE_SCHEMA_VERSION) {
      const m = this.byFrom.get(cur.schemaVersion);
      if (!m) {
        throw new CombatStorageSchemaError(cur.schemaVersion, STORAGE_SCHEMA_VERSION);
      }
      cur = m.migrate(cur);
      steps += 1;
      if (steps > 100) {
        throw new Error('[Migration] runaway migration chain (>100 steps)');
      }
    }
    if (cur.schemaVersion > STORAGE_SCHEMA_VERSION) {
      // Future version — server is older than recording → reject
      throw new CombatStorageSchemaError(cur.schemaVersion, STORAGE_SCHEMA_VERSION);
    }
    return { snapshot: cur, appliedSteps: steps };
  }

  /** Diagnostic: list registered pairs. */
  list(): readonly { from: number; to: number }[] {
    return [...this.byFrom.values()].map((m) => ({ from: m.fromVersion, to: m.toVersion }));
  }
}

/** Default registry — empty (no migration needed at v1). Caller may extend. */
export const defaultMigrationRegistry = new SnapshotMigrationRegistry();

// ─────────────────────────────────────────────────────────
// Rollback-safe recovery
// ─────────────────────────────────────────────────────────

export interface RecoveryReport {
  encounterId: string;
  snapshotFound: boolean;
  payloadDigest?: string;
  chunkCount: number;
  totalFrames: number;
  totalEvents: number;
}

/**
 * Snapshot all storage state for encounterId — used for rollback verification
 * (load original → compare to current → assert match).
 */
export function inspectRecovery(
  encounterId: string,
  storage: CombatStorage,
): RecoveryReport {
  const snapshot = storage.loadSnapshot(encounterId);
  const chunks = storage.loadReplay(encounterId);
  let totalFrames = 0, totalEvents = 0;
  for (const c of chunks) {
    totalFrames += c.frames.length;
    totalEvents += c.events.length;
  }
  return {
    encounterId,
    snapshotFound: snapshot !== undefined,
    chunkCount: chunks.length,
    totalFrames,
    totalEvents,
  };
}
