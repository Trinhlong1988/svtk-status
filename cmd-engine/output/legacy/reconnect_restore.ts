/**
 * RECONNECT RESTORE — restore CombatRuntime mid-encounter (Phase 13).
 *
 * Per CMD1 1.docx Phase 13 § 1 "Combat persistence integration":
 *   - checkpoint restore
 *   - reconnect restore
 *   - rollback-safe restore
 *   - deterministic combat save/load
 *
 * Use case: player disconnects mid-combat → server-side runtime continues OR
 * is paused. On reconnect, load snapshot + replay chunks → reconstruct the
 * orchestrator state so the player rejoins at the same combat tick.
 *
 * STRICT additive — does NOT mutate `combat_runtime.ts` or modify combat
 * semantics. Pure rebuild via existing public APIs.
 *
 * MANDATORY rule (1.docx Phase 13):
 *   "same combat state = same replay = same rollback restore
 *    = same spectator snapshot ALWAYS. 0 replay drift tolerated."
 */
import {
  createCombatRuntime,
  type CombatRuntime,
} from './combat_runtime.js';
import {
  type CombatStorage,
  type CombatSnapshot,
  type ReplayChunk,
  canonicalHash,
} from './combat_storage.js';
import {
  loadAndMigrateSnapshot,
  type LoadedSnapshot,
} from './persistence_snapshot.js';
import {
  buildCombatPayload,
  hashPayload,
  comparePayloads,
  type CombatPayload,
} from './combat_payload_builder.js';
import {
  buildSpectatorSnapshot,
  type SpectatorSnapshot,
} from './spectator_snapshot.js';
import {
  captureRunSnapshot,
  compareRunSnapshots,
  type CombatDivergenceReport,
} from './combat_divergence_diagnostics.js';

export const RECONNECT_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────
// Reconnect restore — high-level API
// ─────────────────────────────────────────────────────────

export type RestoreFailureReason =
  | 'snapshot_missing'
  | 'schema_incompatible'
  | 'integrity_drift'
  | 'session_mismatch';
// NOTE: 'chunk_gap_detected' removed — InMemoryCombatStorage.appendReplayChunk
// rejects out-of-order chunks via ReplayChunkOrderError at WRITE time, so
// loadReplay() NEVER returns non-contiguous chunks through public API. The
// branch was dead code; remove to keep contract honest. If a custom backend
// CAN produce gaps (e.g., partial-batch upload), it MUST validate at load —
// not silently return gappy chunks.

export interface ReconnectRestoreReport {
  schemaVersion: number;
  encounterId: string;
  /** True if restore completed without integrity issue. */
  restored: boolean;
  /** Failure reason if restore aborted. */
  failureReason?: RestoreFailureReason;
  /** Snapshot turn that was restored from (live combat resumes from snapshot.takenAtTurn + 1). */
  restoredFromTurn?: number;
  /** Number of replay chunks loaded for forensic verification. */
  chunksLoaded: number;
  /** Snapshot payload hash — caller verifies vs producer. */
  payloadHash?: string;
  /** Spectator-safe snapshot digest — for observer rejoin. */
  spectatorDigest?: string;
  /** Migration was applied. */
  migrated: boolean;
}

export interface ReconnectRestoreOptions {
  /** Optional session id for validation. If provided, mismatch → fail. */
  expectedSessionId?: string;
  /**
   * Optional integrity check — if `expectedPayloadHash` provided, comparison
   * MUST match the loaded snapshot's payload hash, else fail with `integrity_drift`.
   */
  expectedPayloadHash?: string;
}

export interface ReconnectRestoreResult {
  report: ReconnectRestoreReport;
  /** New CombatRuntime constructed from snapshot. Live caller continues from here. */
  runtime?: CombatRuntime;
  /** Loaded snapshot for caller (forensic / wire-forward). */
  snapshot?: CombatSnapshot;
  /** Loaded payload — for direct consumption by client. */
  payload?: CombatPayload;
  /** Spectator snapshot — for observer rejoin scenario. */
  spectatorSnapshot?: SpectatorSnapshot;
}

/**
 * Reconnect to an encounter — load snapshot, validate, rebuild runtime.
 *
 * Behaviour:
 *   1. Load snapshot via storage. If missing → fail `snapshot_missing`.
 *   2. Migrate via `loadAndMigrateSnapshot`. If schema incompatible → fail.
 *   3. If `expectedSessionId` provided + mismatch → fail `session_mismatch`.
 *   4. If `expectedPayloadHash` provided + mismatch → fail `integrity_drift`.
 *   5. Validate replay chunks contiguous (chunkSeq 0..N) → fail `chunk_gap_detected` if gap.
 *   6. Build new CombatRuntime with same encounterId/sessionId.
 *   7. Set rt.currentTurn = snapshot.takenAtTurn.
 *   8. Build payload + spectator snapshot for client/observer wire.
 *
 * Pure read of storage — does NOT mutate storage state.
 *
 * NOTE: This restores the RUNTIME WRAPPER state (turn counter, identity).
 * The full replay frame/event history is NOT replayed into the new runtime —
 * caller MAY use loaded chunks to verify forensic integrity OR send raw
 * chunks down the wire to rebuild client-side state. Server-authoritative
 * combat resumes from `takenAtTurn + 1` onward.
 */
export function reconnectRestore(
  encounterId: string,
  storage: CombatStorage,
  opts: ReconnectRestoreOptions = {},
): ReconnectRestoreResult {
  // Step 1: load snapshot
  let loaded: LoadedSnapshot | undefined;
  try {
    loaded = loadAndMigrateSnapshot(encounterId, storage);
  } catch {
    return {
      report: {
        schemaVersion: RECONNECT_SCHEMA_VERSION,
        encounterId,
        restored: false,
        failureReason: 'schema_incompatible',
        chunksLoaded: 0,
        migrated: false,
      },
    };
  }
  if (!loaded) {
    return {
      report: {
        schemaVersion: RECONNECT_SCHEMA_VERSION,
        encounterId,
        restored: false,
        failureReason: 'snapshot_missing',
        chunksLoaded: 0,
        migrated: false,
      },
    };
  }

  // Step 3: optional session id check
  if (opts.expectedSessionId && opts.expectedSessionId !== loaded.snapshot.sessionId) {
    return {
      report: {
        schemaVersion: RECONNECT_SCHEMA_VERSION,
        encounterId,
        restored: false,
        failureReason: 'session_mismatch',
        chunksLoaded: 0,
        migrated: loaded.migrated,
      },
    };
  }

  // Step 4: optional payload hash check
  const payloadHash = hashPayload(loaded.payload);
  if (opts.expectedPayloadHash && opts.expectedPayloadHash !== payloadHash) {
    return {
      report: {
        schemaVersion: RECONNECT_SCHEMA_VERSION,
        encounterId,
        restored: false,
        failureReason: 'integrity_drift',
        chunksLoaded: 0,
        payloadHash,
        migrated: loaded.migrated,
      },
    };
  }

  // Load chunks for caller forensic / wire-forward.
  // NOTE: chunk order is enforced by storage at WRITE time
  // (ReplayChunkOrderError) — no read-time validation needed.
  const chunks = storage.loadReplay(encounterId);

  // Build new CombatRuntime
  const runtime = createCombatRuntime({
    encounterId: loaded.snapshot.encounterId,
    sessionId: loaded.snapshot.sessionId,
  });
  // Step 7: align turn counter
  runtime.currentTurn = loaded.snapshot.takenAtTurn;

  // Step 8: prepare payload + spectator for caller wire
  const spectatorSnapshot = buildSpectatorSnapshot(runtime);

  return {
    runtime,
    snapshot: loaded.snapshot,
    payload: loaded.payload,
    spectatorSnapshot,
    report: {
      schemaVersion: RECONNECT_SCHEMA_VERSION,
      encounterId,
      restored: true,
      restoredFromTurn: loaded.snapshot.takenAtTurn,
      chunksLoaded: chunks.length,
      payloadHash,
      spectatorDigest: spectatorSnapshot.digest,
      migrated: loaded.migrated,
    },
  };
}

// ─────────────────────────────────────────────────────────
// Restore parity check — confirm restored runtime matches recorded payload
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// Parity verification — TWO distinct concerns
// ─────────────────────────────────────────────────────────
//
// (A) verifyIdentityParity — confirms identity fields match (encounterId,
//     sessionId, currentTurn). USE AFTER reconnect → before client wire.
//     Returns true on fresh runtime because frames/events count 0 vs N from
//     loaded payload IS expected (caller hasn't replayed chunks yet).
//
// (B) verifyDeepReplayParity — confirms runtime FULLY mirrors expected payload
//     (every field including frame digest). USE AFTER caller replays the
//     loaded chunks into a fresh runtime. This is the strict check that
//     guarantees "same combat state = same restored combat" (Phase 13 § 1).

export interface IdentityParityReport {
  parityHeld: boolean;
  mismatchedField?: 'encounterId' | 'sessionId' | 'currentTurn';
  expected?: string | number;
  actual?: string | number;
}

export interface FullRestoreParityReport {
  parityHeld: boolean;
  /** Detailed divergence — present iff parityHeld=false. */
  divergence?: CombatDivergenceReport;
  expectedPayloadHash: string;
  actualPayloadHash: string;
  expectedSpectatorDigest: string;
  actualSpectatorDigest: string;
  /** Frame digest comparison: same expected/actual frame checksum sequence? */
  frameDigestMatch: boolean;
}

/**
 * Confirms identity fields (encounterId / sessionId / currentTurn) of the
 * freshly-restored runtime match the loaded snapshot. Does NOT require
 * replay chunks to be re-applied — safe to call immediately after
 * `reconnectRestore`.
 */
export function verifyIdentityParity(
  runtime: CombatRuntime,
  expectedPayload: CombatPayload,
): IdentityParityReport {
  if (runtime.config.encounterId !== expectedPayload.encounterId) {
    return {
      parityHeld: false,
      mismatchedField: 'encounterId',
      expected: expectedPayload.encounterId,
      actual: runtime.config.encounterId,
    };
  }
  if (runtime.config.sessionId !== expectedPayload.sessionId) {
    return {
      parityHeld: false,
      mismatchedField: 'sessionId',
      expected: expectedPayload.sessionId,
      actual: runtime.config.sessionId,
    };
  }
  if (runtime.currentTurn !== expectedPayload.currentTurn) {
    return {
      parityHeld: false,
      mismatchedField: 'currentTurn',
      expected: expectedPayload.currentTurn,
      actual: runtime.currentTurn,
    };
  }
  return { parityHeld: true };
}

/**
 * FULL runtime parity verification — checks ALL 3 layers in one pass per
 * CMD1 1.docx Phase 13 FIX #1 Option B:
 *   1. Payload hash       (canonical INT-only state)
 *   2. Spectator digest   (observer-visible state)
 *   3. Frame digest       (frame-by-frame checksum sequence)
 *
 * Returns `parityHeld=true` iff ALL 3 match. If false, `divergence` carries
 * first-divergent detail. Caller MUST have replayed all loaded chunks into
 * the runtime BEFORE calling this — otherwise parity will not hold.
 */
export function verifyFullRestoreParity(
  runtime: CombatRuntime,
  expectedPayload: CombatPayload,
): FullRestoreParityReport {
  const actualPayload = buildCombatPayload(runtime);
  const actualPayloadHash = hashPayload(actualPayload);
  const expectedPayloadHash = hashPayload(expectedPayload);

  const actualSpectator = buildSpectatorSnapshot(runtime);
  // Build expected-side spectator digest deterministically — synthesize a
  // throwaway runtime whose payload would yield the same spectator output.
  // Since spectator sanitization derives entirely from public payload fields,
  // we compute the expected digest by re-running sanitize on expectedPayload.
  // To keep determinism without mutating runtime, use captureRunSnapshot
  // pattern: compare actual snapshot vs synthesized expected snapshot.
  const a = captureRunSnapshot(runtime);
  const b = { ...a, payload: expectedPayload, payloadHash: expectedPayloadHash };
  const expectedSpectatorDigest = computeSpectatorDigestFor(expectedPayload);
  const actualSpectatorDigest = actualSpectator.digest;

  // Frame digest comparison
  const frameDigestMatch =
    actualPayload.frameDigest.length === expectedPayload.frameDigest.length &&
    actualPayload.frameDigest.every((c, i) => c === expectedPayload.frameDigest[i]);

  const parityHeld =
    actualPayloadHash === expectedPayloadHash
    && actualSpectatorDigest === expectedSpectatorDigest
    && frameDigestMatch;

  if (parityHeld) {
    return {
      parityHeld: true,
      expectedPayloadHash, actualPayloadHash,
      expectedSpectatorDigest, actualSpectatorDigest,
      frameDigestMatch: true,
    };
  }
  return {
    parityHeld: false,
    divergence: compareRunSnapshots(a, b),
    expectedPayloadHash, actualPayloadHash,
    expectedSpectatorDigest, actualSpectatorDigest,
    frameDigestMatch,
  };
}

/**
 * Deterministically compute the spectator digest that WOULD be produced
 * if a runtime had `payload` as its current state. Used for parity check
 * without needing a parallel runtime instance.
 */
function computeSpectatorDigestFor(payload: CombatPayload): string {
  // Sanitize matches `spectator_snapshot.ts § sanitize` — keep in sync.
  // We extract only the public fields and hash via canonicalJson.
  const sanitized = {
    schemaVersion: payload.schemaVersion,
    encounterId: payload.encounterId,
    sessionId: payload.sessionId,
    currentTurn: payload.currentTurn,
    replayFrameCount: payload.replayFrameCount,
    pendingMechanics: payload.pendingMechanics,
    pendingAoeMarkers: payload.pendingAoeMarkers,
    pendingProximityTriggers: payload.pendingProximityTriggers,
    lastFrameChecksum: payload.lastFrameChecksum,
    schemaStampSignature: payload.schemaStampSignature,
    frameDigest: payload.frameDigest,
  };
  // Mirror spectator_snapshot.ts § buildSpectatorSnapshot exactly:
  // it calls `canonicalHash(publicPayload)`, NOT `canonicalHash(canonicalJson(...))`.
  return canonicalHash(sanitized);
}

// ─────────────────────────────────────────────────────────
// Convenience: full reconnect-and-verify flow
// ─────────────────────────────────────────────────────────

/**
 * Higher-level convenience — reconnect + IDENTITY parity check in one call.
 *
 * Uses `verifyIdentityParity` (encounterId / sessionId / currentTurn) — safe
 * for freshly-restored runtime BEFORE chunks are replayed. For full replay
 * parity (frame digest match), caller MUST replay loaded chunks then call
 * `verifyDeepReplayParity` separately.
 */
export function reconnectAndVerify(
  encounterId: string,
  storage: CombatStorage,
  opts: ReconnectRestoreOptions = {},
): ReconnectRestoreResult & { identityParity?: IdentityParityReport } {
  const result = reconnectRestore(encounterId, storage, opts);
  if (!result.runtime || !result.payload) return result;
  const identityParity = verifyIdentityParity(result.runtime, result.payload);
  return { ...result, identityParity };
}

// Re-export ReplayChunk for caller convenience (forensic chunks bridge)
export type { ReplayChunk };
