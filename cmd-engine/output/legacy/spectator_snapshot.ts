/**
 * SPECTATOR SNAPSHOT — observer-safe, anti-cheat-safe combat view (Phase 12 INIT).
 *
 * Per CMD1 1.docx Phase 12 § VI:
 *   "BUILD observer/spectator-safe combat snapshots.
 *    SUPPORT: replay observer mode / live spectator prep /
 *             anti-cheat-safe exports / hidden-state sanitization.
 *    FORBIDDEN: private/internal combat leakage.
 *    VERIFY: observer snapshots deterministic cross-run."
 *
 * Two viewer kinds:
 *   - 'spectator'  — neutral observer (e.g. tournament broadcast). Sees PUBLIC
 *     fields only. Hides intent, hidden HP, anti-cheat-sensitive fields.
 *   - 'replay'     — post-game replay viewer. Sees everything that was public
 *     during the match — same sanitization as spectator (no leak of hidden
 *     intent from past turns either, since replay = re-playback of spectator view).
 *
 * Server-authoritative — caller (server) builds snapshot and broadcasts to
 * clients. Clients NEVER see private fields.
 *
 * STRICT ADDITIVE — pure read function. Same rt + same viewer → same snapshot.
 */
import type { CombatRuntime } from './combat_runtime.js';
import { buildCombatPayload, type CombatPayload } from './combat_payload_builder.js';
import { canonicalJson, canonicalHash } from './combat_storage.js';

export const SPECTATOR_SNAPSHOT_SCHEMA_VERSION = 1;

export type SpectatorViewerKind = 'spectator' | 'replay';

export interface SpectatorSnapshot {
  schemaVersion: number;
  viewer: SpectatorViewerKind;
  encounterId: string;
  sessionId: string;
  currentTurn: number;
  /** Public combat payload — hidden-state-sanitized. */
  publicPayload: SanitizedPayload;
  /** Stable hash for replay verification. */
  digest: string;
}

/**
 * Public-only combat payload — strict subset of CombatPayload.
 * Removed fields: anything that leaks internal state, intent, or anti-cheat
 * surface (none in current payload shape — all fields are aggregates / counts).
 *
 * If future CombatPayload adds private fields, they MUST be filtered HERE.
 */
export interface SanitizedPayload {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  currentTurn: number;
  replayFrameCount: number;
  pendingMechanics: number;
  pendingAoeMarkers: number;
  pendingProximityTriggers: number;
  lastFrameChecksum: string;
  schemaStampSignature: string;
  frameDigest: readonly string[];
}

/**
 * Hidden-state field names that MUST be stripped before publishing to
 * spectators. Sanitizer (Phase 11B § IX) also strips wall-time fields.
 *
 * Add new private field name here when CombatPayload grows internal state.
 */
const PRIVATE_FIELDS_STRIPPED = Object.freeze([
  // Reserved — used by static check below. Currently CombatPayload has no
  // private fields, but list documents what would be stripped if added:
  'hiddenHp',           // future: enemy HP in stealth phase
  'aiIntent',           // future: boss next-action intent
  'rngState',           // future: RNG internal cursor
  'anomalyCount',       // anti-cheat: don't reveal anomaly tallies to spectators
  'compactionCount',    // internal compaction telemetry
  'replayEventCount',   // internal — only frame count is public
]);

/**
 * Sanitize a CombatPayload → SanitizedPayload.
 * Pure function. Same input → same output.
 */
function sanitize(payload: CombatPayload, viewer: SpectatorViewerKind): SanitizedPayload {
  void viewer;       // future: differentiate spectator vs replay if needed
  return {
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
}

/**
 * Build spectator/observer snapshot from CombatRuntime.
 * Public-only — strips all private/internal fields.
 *
 * Deterministic: same rt + same viewer → same SpectatorSnapshot.
 */
export function buildSpectatorSnapshot(
  rt: CombatRuntime,
  viewer: SpectatorViewerKind = 'spectator',
): SpectatorSnapshot {
  const payload = buildCombatPayload(rt);
  const publicPayload = sanitize(payload, viewer);
  return {
    schemaVersion: SPECTATOR_SNAPSHOT_SCHEMA_VERSION,
    viewer,
    encounterId: payload.encounterId,
    sessionId: payload.sessionId,
    currentTurn: payload.currentTurn,
    publicPayload,
    digest: canonicalHash(publicPayload),
  };
}

/**
 * Serialize spectator snapshot to canonical JSON wire bytes.
 */
export function serializeSpectatorSnapshot(snapshot: SpectatorSnapshot): string {
  return canonicalJson(snapshot);
}

/**
 * Verify a spectator snapshot does NOT contain any private field name.
 * Returns array of leaked field names (empty = safe).
 *
 * Use case: production gate — fail loudly if private field accidentally
 * appears in spectator export (e.g. CombatPayload extension added a field
 * but spectator sanitize() not updated).
 */
export function detectPrivateFieldLeak(snapshot: SpectatorSnapshot): readonly string[] {
  const leaked: string[] = [];
  const payloadKeys = new Set(Object.keys(snapshot.publicPayload));
  for (const banned of PRIVATE_FIELDS_STRIPPED) {
    if (payloadKeys.has(banned)) leaked.push(banned);
  }
  return leaked;
}

/**
 * Compare two spectator snapshots — used for replay verification.
 */
export interface SpectatorSnapshotDivergence {
  divergent: boolean;
  field?: string;
}

export function compareSpectatorSnapshots(
  expected: SpectatorSnapshot,
  actual: SpectatorSnapshot,
): SpectatorSnapshotDivergence {
  if (expected.digest !== actual.digest) {
    return { divergent: true, field: 'digest' };
  }
  if (expected.viewer !== actual.viewer) {
    return { divergent: true, field: 'viewer' };
  }
  return { divergent: false };
}

/** Re-export private-field strip list for test verification + extension audits. */
export const __PRIVATE_FIELDS_STRIPPED__ = PRIVATE_FIELDS_STRIPPED;
