/**
 * COMBAT PAYLOAD BUILDER — deterministic serializable combat snapshot (Phase 12 INIT).
 *
 * Per CMD1 1.docx Phase 12 § V:
 *   "PREPARE deterministic combat payload generation.
 *    DO NOT implement transport/network layer.
 *    ONLY prepare replay-safe combat payloads.
 *    RULES: deterministic ordering / stable payload structure / replay-safe
 *           serialization / canonical field ordering / INT-only combat payloads.
 *    VERIFY: same combat state = same payload ALWAYS."
 *
 * Input:  CombatRuntime (live state)
 * Output: CanonicalCombatPayload (JSON-safe, INT-only, canonical-ordered)
 *
 * Usage:
 *   ```
 *   const payload = buildCombatPayload(rt);
 *   const hash = canonicalHash(payload);   // wire-prep checksum
 *   const json = canonicalJson(payload);   // wire-prep bytes
 *   ```
 *
 * STRICT ADDITIVE — does NOT mutate runtime or modify combat semantics.
 * Pure read function. Same rt state → same payload ALWAYS.
 */
import type { CombatRuntime } from './combat_runtime.js';
import { canonicalHash, canonicalJson } from './combat_storage.js';

export const COMBAT_PAYLOAD_SCHEMA_VERSION = 1;

/** Canonical (wire-safe) combat payload. JSON-serializable, no Map / Set / Date / BigInt. */
export interface CombatPayload {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  currentTurn: number;
  /** Replay frame count at snapshot time (read-only). */
  replayFrameCount: number;
  /** Replay event count at snapshot time. */
  replayEventCount: number;
  /** Pending mechanic count (scheduler queue). */
  pendingMechanics: number;
  /** Pending AoE marker count. */
  pendingAoeMarkers: number;
  /** Pending proximity trigger count. */
  pendingProximityTriggers: number;
  /** Latest sealed frame checksum, or empty string if none. */
  lastFrameChecksum: string;
  /** Schema stamp signature (spatial + mechanic). */
  schemaStampSignature: string;
  /** Cumulative anomaly count. */
  anomalyCount: number;
  /** Cumulative compaction count. */
  compactionCount: number;
  /**
   * Frame digest — sequence of frame checksums (ascending turn order).
   * Lets the receiver verify frame-by-frame integrity without sending raw frames.
   */
  frameDigest: readonly string[];
}

/**
 * Build a CanonicalCombatPayload from live runtime. Pure read — does NOT mutate.
 *
 * Deterministic: same `rt` state → same payload (canonical field order +
 * INT-only counts + frame checksum digest from existing sealed frames).
 */
export function buildCombatPayload(rt: CombatRuntime): CombatPayload {
  const frames = rt.replayStream.frames;
  const last = frames.length > 0 ? frames[frames.length - 1]! : undefined;
  return {
    schemaVersion: COMBAT_PAYLOAD_SCHEMA_VERSION,
    encounterId: rt.config.encounterId,
    sessionId: rt.config.sessionId,
    currentTurn: rt.currentTurn,
    replayFrameCount: frames.length,
    replayEventCount: rt.replayStream.events.length,
    pendingMechanics: rt.scheduler.pending.size,
    pendingAoeMarkers: rt.aoeRegistry.markers.size,
    pendingProximityTriggers: rt.proximityRegistry.triggers.size,
    lastFrameChecksum: last?.checksum ?? '',
    schemaStampSignature: `${rt.schemaStamp.spatial.hash}:${rt.schemaStamp.mechanic.hash}`,
    anomalyCount: rt.telemetry.totalCount,
    compactionCount: rt.compactionHistory.length,
    frameDigest: frames.map((f) => f.checksum ?? ''),
  };
}

/**
 * Serialize payload to canonical JSON bytes (wire format).
 * Same payload → same bytes ALWAYS.
 */
export function serializePayload(payload: CombatPayload): string {
  return canonicalJson(payload);
}

/**
 * Hash payload — replay/wire integrity fingerprint.
 * Same payload → same hash ALWAYS (cross-platform FNV-1a).
 */
export function hashPayload(payload: CombatPayload): string {
  return canonicalHash(payload);
}

/**
 * Compare two payloads — returns divergence info.
 * Use case: client-server replay parity, sequential snapshot comparison.
 */
export interface PayloadDivergence {
  divergent: boolean;
  field?: string;
  expected?: unknown;
  actual?: unknown;
}

export function comparePayloads(
  expected: CombatPayload,
  actual: CombatPayload,
): PayloadDivergence {
  const keys: (keyof CombatPayload)[] = [
    'schemaVersion', 'encounterId', 'sessionId', 'currentTurn',
    'replayFrameCount', 'replayEventCount', 'pendingMechanics',
    'pendingAoeMarkers', 'pendingProximityTriggers', 'lastFrameChecksum',
    'schemaStampSignature', 'anomalyCount', 'compactionCount',
  ];
  for (const k of keys) {
    if (expected[k] !== actual[k]) {
      return { divergent: true, field: String(k), expected: expected[k], actual: actual[k] };
    }
  }
  // Compare frame digest length + values
  if (expected.frameDigest.length !== actual.frameDigest.length) {
    return {
      divergent: true, field: 'frameDigest.length',
      expected: expected.frameDigest.length, actual: actual.frameDigest.length,
    };
  }
  for (let i = 0; i < expected.frameDigest.length; i++) {
    if (expected.frameDigest[i] !== actual.frameDigest[i]) {
      return {
        divergent: true, field: `frameDigest[${i}]`,
        expected: expected.frameDigest[i], actual: actual.frameDigest[i],
      };
    }
  }
  return { divergent: false };
}
