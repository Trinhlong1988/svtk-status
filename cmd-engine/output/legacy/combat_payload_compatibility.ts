/**
 * COMBAT PAYLOAD COMPATIBILITY — payload version discipline (Phase 14 hardening § 3).
 *
 * Per Phase 14 hardening review CRITICAL ISSUE #3:
 *   "introduce STRICT payload version discipline.
 *    REQUIRED:
 *      - payload schema version field
 *      - compatibility validator
 *      - canonical payload migration path
 *      - replay-safe payload verification
 *    VERIFY: cross-version payload handling remains deterministic-safe."
 *
 * Thin compatibility layer ON TOP of `combat_payload_builder.ts` (Phase 12 INIT).
 * Does NOT redesign the payload — wraps it with version gates + migration
 * scaffolding so future protocol evolution cannot silently break:
 *   - reconnect restore
 *   - replay continuation
 *   - spectator sync
 *
 * Currently only v1 is defined. Migration scaffolding throws when asked to
 * migrate between non-existent versions; tests verify the gate fires
 * correctly. When v2 ships, register migrators here.
 *
 * STRICT additive — no mutation of CombatPayload, no I/O.
 */
import {
  COMBAT_PAYLOAD_SCHEMA_VERSION,
  comparePayloads,
  type CombatPayload,
  type PayloadDivergence,
} from './combat_payload_builder.js';

export const COMBAT_PAYLOAD_COMPATIBILITY_SCHEMA_VERSION = 1;

/** Lowest payload schema version this runtime can read (accept or migrate). */
export const MIN_SUPPORTED_PAYLOAD_VERSION = 1;
/** Highest payload schema version this runtime can read. */
export const MAX_SUPPORTED_PAYLOAD_VERSION = 1;
/** Native version this runtime produces. */
export const NATIVE_PAYLOAD_VERSION = COMBAT_PAYLOAD_SCHEMA_VERSION;

// ─────────────────────────────────────────────────────────
// Error class
// ─────────────────────────────────────────────────────────

export class PayloadCompatibilityError extends Error {
  constructor(message: string) {
    super(`[PayloadCompat] ${message}`);
    this.name = 'PayloadCompatibilityError';
  }
}

// ─────────────────────────────────────────────────────────
// Compatibility report
// ─────────────────────────────────────────────────────────

export type CompatibilityAction = 'accept' | 'migrate' | 'reject';

export type CompatibilityReason =
  | 'native_version'
  | 'within_supported_range'
  | 'unsupported_below_min'
  | 'unsupported_above_max'
  | 'migration_required';

export interface CompatibilityReport {
  payloadVersion: number;
  runtimeVersion: number;
  minSupported: number;
  maxSupported: number;
  action: CompatibilityAction;
  reason: CompatibilityReason;
  /** If action === 'migrate', the migration plan. */
  migrationFrom?: number;
  migrationTo?: number;
}

/**
 * Decide what to do with an incoming payload based on its schema version.
 *
 * Decision matrix:
 *   - payload.schemaVersion < MIN → reject (unsupported_below_min)
 *   - payload.schemaVersion > MAX → reject (unsupported_above_max)
 *   - payload.schemaVersion === NATIVE → accept (native_version)
 *   - MIN ≤ payload.schemaVersion < NATIVE → migrate (migration_required)
 *   - NATIVE < payload.schemaVersion ≤ MAX → accept (within_supported_range)
 *
 * Determinism: same payload → same report ALWAYS.
 */
export function verifyPayloadCompatibility(payload: CombatPayload): CompatibilityReport {
  const v = payload.schemaVersion;
  const base = {
    payloadVersion: v,
    runtimeVersion: NATIVE_PAYLOAD_VERSION,
    minSupported: MIN_SUPPORTED_PAYLOAD_VERSION,
    maxSupported: MAX_SUPPORTED_PAYLOAD_VERSION,
  };
  if (v < MIN_SUPPORTED_PAYLOAD_VERSION) {
    return { ...base, action: 'reject', reason: 'unsupported_below_min' };
  }
  if (v > MAX_SUPPORTED_PAYLOAD_VERSION) {
    return { ...base, action: 'reject', reason: 'unsupported_above_max' };
  }
  if (v === NATIVE_PAYLOAD_VERSION) {
    return { ...base, action: 'accept', reason: 'native_version' };
  }
  if (v < NATIVE_PAYLOAD_VERSION) {
    return {
      ...base,
      action: 'migrate',
      reason: 'migration_required',
      migrationFrom: v,
      migrationTo: NATIVE_PAYLOAD_VERSION,
    };
  }
  // v > NATIVE && v ≤ MAX: future-compatible payload, accept as-is
  return { ...base, action: 'accept', reason: 'within_supported_range' };
}

// ─────────────────────────────────────────────────────────
// Migration scaffolding
// ─────────────────────────────────────────────────────────

export interface MigrationResult {
  migrated: boolean;
  payload?: CombatPayload;
  reason?:
    | 'no_op_already_native'
    | 'no_migrator_registered'
    | 'downgrade_forbidden'
    | 'unsupported_version'
    | 'unsupported_source_version';
}

/**
 * Per-step migrator: payload at version N → payload at version N+1.
 * Returns the migrated payload OR throws if the input is malformed.
 *
 * Registered by version pair (from→to). Currently no migrators exist because
 * only v1 is defined. When v2 is introduced, register a v1→v2 migrator here.
 */
export type PayloadMigrator = (payload: CombatPayload) => CombatPayload;

const MIGRATORS: ReadonlyMap<string, PayloadMigrator> = new Map();

/** Compose a multi-step migration path (e.g. v1 → v2 → v3). */
function migrationPath(from: number, to: number): readonly PayloadMigrator[] {
  const path: PayloadMigrator[] = [];
  for (let v = from; v < to; v++) {
    const step = MIGRATORS.get(`${v}->${v + 1}`);
    if (!step) return [];
    path.push(step);
  }
  return path;
}

/**
 * Migrate a payload to a target schema version.
 *
 * Rules:
 *   - target === payload.schemaVersion → no_op (already native to that version)
 *   - target < payload.schemaVersion → downgrade_forbidden (replay-safety)
 *   - target > MAX or < MIN → unsupported_version
 *   - missing migrator step → no_migrator_registered
 *
 * NEVER mutates the input payload. Returns a new object.
 */
export function migratePayload(
  payload: CombatPayload,
  targetVersion: number,
): MigrationResult {
  // R3-5 audit fix: source version range gate. Without this, a v0 payload would
  // fall through to `migrationPath(0, 1)` returning empty → `no_migrator_registered`,
  // which is technically true but semantically misleading. Explicit reason
  // helps caller distinguish "below floor" from "migrator missing".
  if (
    payload.schemaVersion < MIN_SUPPORTED_PAYLOAD_VERSION ||
    payload.schemaVersion > MAX_SUPPORTED_PAYLOAD_VERSION
  ) {
    return { migrated: false, reason: 'unsupported_source_version' };
  }
  if (targetVersion === payload.schemaVersion) {
    return { migrated: false, payload, reason: 'no_op_already_native' };
  }
  if (targetVersion < payload.schemaVersion) {
    return { migrated: false, reason: 'downgrade_forbidden' };
  }
  if (
    targetVersion < MIN_SUPPORTED_PAYLOAD_VERSION ||
    targetVersion > MAX_SUPPORTED_PAYLOAD_VERSION
  ) {
    return { migrated: false, reason: 'unsupported_version' };
  }
  const path = migrationPath(payload.schemaVersion, targetVersion);
  if (path.length === 0) {
    return { migrated: false, reason: 'no_migrator_registered' };
  }
  let cur = payload;
  for (const step of path) {
    cur = step(cur);
  }
  return { migrated: true, payload: cur };
}

// ─────────────────────────────────────────────────────────
// Replay-safe payload verification
// ─────────────────────────────────────────────────────────

export type ReplaySafeIssue =
  | 'missing_schema_version'
  | 'invalid_schema_version'
  | 'missing_encounter_id'
  | 'missing_session_id'
  | 'negative_turn'
  | 'negative_frame_count'
  | 'negative_event_count'
  | 'non_finite_numeric_field'
  | 'frame_digest_length_mismatch'
  | 'frame_digest_non_string';

export interface ReplaySafetyReport {
  safe: boolean;
  issues: readonly ReplaySafeIssue[];
}

/**
 * Verify that a candidate payload is structurally complete enough to feed
 * into replay continuation / reconnect restore without runtime panic.
 *
 * Checks the invariants that the payload-builder is expected to produce.
 * Catches truncated/corrupted payloads BEFORE they enter the replay pipe.
 */
export function verifyReplaySafePayload(payload: CombatPayload): ReplaySafetyReport {
  const issues: ReplaySafeIssue[] = [];
  if (typeof payload.schemaVersion !== 'number') issues.push('missing_schema_version');
  else if (!Number.isInteger(payload.schemaVersion) || payload.schemaVersion < 1) {
    issues.push('invalid_schema_version');
  }
  if (!payload.encounterId) issues.push('missing_encounter_id');
  if (!payload.sessionId) issues.push('missing_session_id');
  // R3-4 audit fix: NaN/Infinity slip past `< 0` checks (NaN < 0 is false).
  // Validate finite numbers FIRST so 'non_finite_numeric_field' fires instead of
  // a misleading clean pass.
  if (
    !Number.isFinite(payload.currentTurn) ||
    !Number.isFinite(payload.replayFrameCount) ||
    !Number.isFinite(payload.replayEventCount)
  ) {
    issues.push('non_finite_numeric_field');
  }
  if (payload.currentTurn < 0) issues.push('negative_turn');
  if (payload.replayFrameCount < 0) issues.push('negative_frame_count');
  if (payload.replayEventCount < 0) issues.push('negative_event_count');
  if (payload.frameDigest.length !== payload.replayFrameCount) {
    issues.push('frame_digest_length_mismatch');
  }
  for (const d of payload.frameDigest) {
    if (typeof d !== 'string') {
      issues.push('frame_digest_non_string');
      break;
    }
  }
  return { safe: issues.length === 0, issues };
}

// ─────────────────────────────────────────────────────────
// Cross-version parity
// ─────────────────────────────────────────────────────────

export interface CrossVersionParityReport {
  parityHeld: boolean;
  /** True if both payloads have versions within the supported range. */
  versionsCompatible: boolean;
  /** Higher of the two versions — the "merged" runtime version for comparison. */
  effectiveVersion: number;
  divergence?: PayloadDivergence;
}

/**
 * Compare two payloads that may originate from different schema versions.
 *
 * Steps:
 *   1. Verify both are within MIN..MAX range.
 *   2. Migrate the lower version forward to the higher (no-op if same).
 *   3. Compare via existing comparePayloads.
 *
 * Use case: server-vs-client cross-version replay verification, after server
 * has upgraded but client still ships old payload.
 */
export function compareCrossVersionPayloads(
  a: CombatPayload,
  b: CombatPayload,
): CrossVersionParityReport {
  const aReport = verifyPayloadCompatibility(a);
  const bReport = verifyPayloadCompatibility(b);
  if (aReport.action === 'reject' || bReport.action === 'reject') {
    return {
      parityHeld: false,
      versionsCompatible: false,
      effectiveVersion: Math.max(a.schemaVersion, b.schemaVersion),
    };
  }
  const target = Math.max(a.schemaVersion, b.schemaVersion);
  const aMig = a.schemaVersion === target ? a : migratePayload(a, target).payload;
  const bMig = b.schemaVersion === target ? b : migratePayload(b, target).payload;
  if (!aMig || !bMig) {
    return {
      parityHeld: false,
      versionsCompatible: false,
      effectiveVersion: target,
    };
  }
  const div = comparePayloads(aMig, bMig);
  return {
    parityHeld: !div.divergent,
    versionsCompatible: true,
    effectiveVersion: target,
    divergence: div.divergent ? div : undefined,
  };
}
