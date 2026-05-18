/**
 * REPLAY FRAMEWORK — replay-safe architecture (R2 + R6 Deterministic).
 *
 * Mỗi encounter:
 *   1. Record seed + actions sequence (input log)
 *   2. State diff per turn (snapshot for rollback)
 *   3. Event buffer (output log)
 *
 * Replay = re-run encounter từ seed + actions → MUST cùng kết quả.
 *
 * Dùng cho:
 *   - Bug reproduction (bug report kèm seed → debug)
 *   - Anti-cheat (server replay verify client claim)
 *   - Tournament PvP replay
 *   - Telemetry analytics
 */
import type { CombatEvent } from '../logic/event_bus.js';
import { currentClock } from '../logic/deterministic_clock.js';

/** Input action — player intent, server-validated. */
export interface PlayerAction {
  turn: number;
  actionIndex: number;
  playerId: string;
  type: 'cast_skill' | 'move' | 'use_item' | 'switch_target';
  payload: Record<string, unknown>;
}

/**
 * Replay schema version — shape của EncounterRecording. Bump khi đổi field shape.
 * (FIX #4 — REPLAY VERSIONING per SVTK.docx Phase 1 hardening.)
 */
export const REPLAY_SCHEMA_VERSION = 1;

/**
 * Event schema version — shape CombatEvent variants. Bump khi thêm/đổi event type field.
 */
export const EVENT_SCHEMA_VERSION = 1;

/** Encounter recording — full input + output trail. */
export interface EncounterRecording {
  schema_version: number;         // REPLAY_SCHEMA_VERSION at record time
  event_schema_version: number;   // EVENT_SCHEMA_VERSION at record time
  formula_version: number;        // FORMULA_VERSION at record time (from constants.ts)
  formula_signature_hash?: string; // FORMULA_SIGNATURE_HASH at record time (FIX #9 drift detect)
  encounterId: string;
  seed: string;
  startedAt: string;     // ISO timestamp
  endedAt?: string;
  participants: string[];   // playerIds + npcIds
  initialState: unknown;    // snapshot of all combat chars at turn 0
  actions: PlayerAction[];  // chronological input
  events: CombatEvent[];    // chronological output (event bus emissions)
  outcome?: 'victory' | 'wipe' | 'timeout' | 'flee';
}

/**
 * Compatibility check — caller decide if replay should run, migrate, or reject.
 *
 * Strict: all 3 versions match → safe replay.
 * Loose: schema versions match but formula_version differs → still possible
 * (replay produces different damage but events have same shape).
 */
export interface ReplayCompatibility {
  compatible: boolean;
  reason?:
    | 'replay_schema_mismatch'
    | 'event_schema_mismatch'
    | 'formula_version_mismatch'
    | 'formula_signature_drift';
  recordingVersion: { schema: number; event_schema: number; formula: number };
  currentVersion: { schema: number; event_schema: number; formula: number; formula_signature_hash?: string };
}

export function checkReplayCompatibility(
  recording: EncounterRecording,
  current: { schema: number; event_schema: number; formula: number; formula_signature_hash?: string },
): ReplayCompatibility {
  const recordingVersion = {
    schema: recording.schema_version,
    event_schema: recording.event_schema_version,
    formula: recording.formula_version,
  };
  if (recordingVersion.schema !== current.schema) {
    return { compatible: false, reason: 'replay_schema_mismatch', recordingVersion, currentVersion: current };
  }
  if (recordingVersion.event_schema !== current.event_schema) {
    return { compatible: false, reason: 'event_schema_mismatch', recordingVersion, currentVersion: current };
  }
  if (recordingVersion.formula !== current.formula) {
    return { compatible: false, reason: 'formula_version_mismatch', recordingVersion, currentVersion: current };
  }
  // Signature hash drift — silent constants change without FORMULA_VERSION bump
  if (
    recording.formula_signature_hash !== undefined &&
    current.formula_signature_hash !== undefined &&
    recording.formula_signature_hash !== current.formula_signature_hash
  ) {
    return { compatible: false, reason: 'formula_signature_drift', recordingVersion, currentVersion: current };
  }
  return { compatible: true, recordingVersion, currentVersion: current };
}

/**
 * FIX #4 — ReplayMigrationRegistry.
 *
 * Register migration v(N) → v(N+1) at boot. `migrate(recording)` walks chain to current.
 * Replay-safe: migrate functions PURE — no I/O, no state.
 */
export type MigrationFn = (rec: EncounterRecording) => EncounterRecording;

export class ReplayMigrationRegistry {
  private migrations = new Map<number, MigrationFn>();

  /** Register migration from version N → N+1. */
  register(fromVersion: number, fn: MigrationFn): void {
    if (this.migrations.has(fromVersion)) {
      throw new Error(`MigrationRegistry: duplicate registration for v${fromVersion}→v${fromVersion + 1}`);
    }
    this.migrations.set(fromVersion, fn);
  }

  /** Migrate recording to targetVersion. Returns new recording (immutable input). */
  migrate(recording: EncounterRecording, targetVersion: number): EncounterRecording {
    let cur = recording;
    while (cur.schema_version < targetVersion) {
      const fn = this.migrations.get(cur.schema_version);
      if (!fn) {
        throw new Error(
          `MigrationRegistry: no migration from v${cur.schema_version} to v${cur.schema_version + 1}`,
        );
      }
      cur = fn(cur);
    }
    return cur;
  }

  /** Lists registered migrations as version pairs. */
  list(): Array<{ from: number; to: number }> {
    return [...this.migrations.keys()].sort((a, b) => a - b).map((from) => ({ from, to: from + 1 }));
  }
}

/**
 * Recorder — capture encounter to memory, persist khi end.
 */
export class EncounterRecorder {
  private recording: EncounterRecording;

  constructor(
    encounterId: string,
    seed: string,
    participants: string[],
    initialState: unknown,
    versions: { schema?: number; event_schema?: number; formula: number; formula_signature_hash?: string },
  ) {
    this.recording = {
      schema_version: versions.schema ?? REPLAY_SCHEMA_VERSION,
      event_schema_version: versions.event_schema ?? EVENT_SCHEMA_VERSION,
      formula_version: versions.formula,
      ...(versions.formula_signature_hash !== undefined && { formula_signature_hash: versions.formula_signature_hash }),
      encounterId,
      seed,
      startedAt: currentClock().nowIso(),
      participants,
      initialState: structuredClone(initialState),
      actions: [],
      events: [],
    };
  }

  recordAction(action: PlayerAction): void {
    this.recording.actions.push(action);
  }

  recordEvent(event: CombatEvent): void {
    this.recording.events.push(event);
  }

  end(outcome: EncounterRecording['outcome']): EncounterRecording {
    this.recording.endedAt = currentClock().nowIso();
    this.recording.outcome = outcome;
    return this.recording;
  }

  get(): Readonly<EncounterRecording> {
    return this.recording;
  }
}

/**
 * Replay engine — re-execute recording, compare event sequence.
 * Test usage: assert replay produces identical event sequence.
 */
export interface ReplayResult {
  match: boolean;
  divergedAtIndex?: number;
  expected?: CombatEvent;
  actual?: CombatEvent;
}

/**
 * Rollback recording to specific turn (≤ targetTurn) — strip subsequent actions + events.
 * Returns NEW recording (immutable input). State restoration cần caller re-run từ initialState.
 *
 * Use case: anti-cheat re-execute từ snapshot, undo bug-injected actions, debug step-back.
 */
export function rollbackToTurn(
  recording: EncounterRecording,
  targetTurn: number,
): EncounterRecording {
  return {
    ...recording,
    actions: recording.actions.filter((a) => a.turn <= targetTurn),
    events: recording.events.filter((e) => (e as { turn?: number }).turn === undefined || (e as { turn: number }).turn <= targetTurn),
    endedAt: undefined,
    outcome: undefined,
  };
}

export function compareEventSequences(
  expected: readonly CombatEvent[],
  actual: readonly CombatEvent[],
): ReplayResult {
  if (expected.length !== actual.length) {
    return {
      match: false,
      divergedAtIndex: Math.min(expected.length, actual.length),
    };
  }
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i];
    const a = actual[i];
    if (!e || !a) {
      return { match: false, divergedAtIndex: i };
    }
    if (JSON.stringify(e) !== JSON.stringify(a)) {
      return { match: false, divergedAtIndex: i, expected: e, actual: a };
    }
  }
  return { match: true };
}
