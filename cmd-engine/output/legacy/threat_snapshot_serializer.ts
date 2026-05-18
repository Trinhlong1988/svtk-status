/**
 * THREAT SNAPSHOT SERIALIZER — full deterministic (FIX PHASE 4 #2 CRITICAL).
 *
 * Versioned JSON serialization cho:
 *   - encounter recovery (server crash → restore)
 *   - reconnect (player rejoin mid-combat)
 *   - rollback replay (Module 9 future)
 *   - debugging (export/import threat state)
 *
 * Schema versioned: bump THREAT_SNAPSHOT_SCHEMA_VERSION khi shape changes.
 * Validate on restore — reject incompatible.
 */
import type { EncounterSnapshot } from './encounter_manager.js';
import { EncounterManager } from './encounter_manager.js';
import { currentClock, type DeterministicClock } from './deterministic_clock.js';

export const THREAT_SNAPSHOT_SCHEMA_VERSION = 1;

export interface SerializedThreatSnapshot {
  schemaVersion: number;
  /** Encounter id. */
  encounterId: string;
  /** ISO timestamp at snapshot time (informational only — replay uses turn). */
  takenAt: string;
  /** Source — for debugging trace. */
  source: 'periodic' | 'reconnect' | 'wipe' | 'rollback' | 'replay' | 'shutdown';
  /** Full encounter snapshot. */
  snapshot: EncounterSnapshot;
}

export class ThreatSnapshotIncompatibleError extends Error {
  constructor(
    public readonly recordedVersion: number,
    public readonly currentVersion: number,
  ) {
    super(`[ThreatSnapshot] schema version mismatch: recorded=${recordedVersion} current=${currentVersion}`);
    this.name = 'ThreatSnapshotIncompatibleError';
  }
}

/**
 * Serialize encounter manager → portable JSON.
 *
 * Deterministic: snapshot inner sorted by attackerId; lists sorted lex.
 * INT-safe: no Date.now in payload (caller-provided timestamp string).
 */
export function serializeEncounter(
  manager: EncounterManager,
  source: SerializedThreatSnapshot['source'] = 'periodic',
  takenAt?: string,
  clock?: DeterministicClock,
): SerializedThreatSnapshot {
  const resolvedTakenAt = takenAt ?? (clock ?? currentClock()).nowIso();
  return {
    schemaVersion: THREAT_SNAPSHOT_SCHEMA_VERSION,
    encounterId: manager.encounterId,
    takenAt: resolvedTakenAt,
    source,
    snapshot: manager.snapshot(),
  };
}

/**
 * Deserialize JSON → EncounterManager. Throws on schema mismatch.
 */
export function deserializeEncounter(json: SerializedThreatSnapshot): EncounterManager {
  if (json.schemaVersion !== THREAT_SNAPSHOT_SCHEMA_VERSION) {
    throw new ThreatSnapshotIncompatibleError(json.schemaVersion, THREAT_SNAPSHOT_SCHEMA_VERSION);
  }
  return EncounterManager.fromSnapshot(json.snapshot);
}

/**
 * Verify roundtrip — caller test invariant. Returns true if deserialize → serialize
 * produces identical content (mod takenAt/source).
 */
export function verifyRoundtripDeterminism(snap: SerializedThreatSnapshot): boolean {
  const restored = deserializeEncounter(snap);
  const reSnap = serializeEncounter(restored, snap.source, snap.takenAt);
  return JSON.stringify(stripVolatile(snap)) === JSON.stringify(stripVolatile(reSnap));
}

/** Strip volatile fields for comparison. */
function stripVolatile(snap: SerializedThreatSnapshot): unknown {
  return {
    schemaVersion: snap.schemaVersion,
    encounterId: snap.encounterId,
    snapshot: snap.snapshot,
  };
}

/**
 * Compute snapshot byte size — telemetry budget watchdog.
 */
export function snapshotByteSize(snap: SerializedThreatSnapshot): number {
  return Buffer.byteLength(JSON.stringify(snap), 'utf8');
}
