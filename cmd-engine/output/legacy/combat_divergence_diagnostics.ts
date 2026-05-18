/**
 * COMBAT DIVERGENCE DIAGNOSTICS — unified replay-drift detector (Phase 12 ADVANCED).
 *
 * Per CMD1 1.docx Phase 12 ADVANCED § VII:
 *   "EXPAND combat forensic exports. SUPPORT:
 *      - replay-linked telemetry
 *      - deterministic append traces
 *      - rollback audit logs
 *      - orchestration forensic reports
 *      - combat divergence diagnostics
 *    RULE: forensic metadata MUST NOT affect replay determinism."
 *
 * Compares TWO CombatRuntime executions (same seed/config) and reports
 * the FIRST point of divergence:
 *
 *   1. Payload-level divergence — field name + expected/actual
 *   2. Spectator-snapshot divergence — viewer-safe digest mismatch
 *   3. Frame-level divergence — first turn whose checksum differs
 *   4. Event-level divergence — first seq whose (turn, kind, payload) differs
 *
 * Use case: cross-run replay verification, server-vs-client mirror,
 * pre-production "did refactor break determinism" gate.
 *
 * STRICT pure read — no mutation of either runtime. Same input → same report.
 */
import type { CombatRuntime } from './combat_runtime.js';
import {
  buildCombatPayload, hashPayload,
  comparePayloads, type CombatPayload,
} from './combat_payload_builder.js';
import {
  buildSpectatorSnapshot, compareSpectatorSnapshots,
} from './spectator_snapshot.js';
import type { ReplayFrame } from './replay_frame.js';
import type { StreamEvent } from './replay_event_stream.js';
import { canonicalJson } from './combat_storage.js';

export const DIAGNOSTICS_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────
// Divergence report shapes
// ─────────────────────────────────────────────────────────

export type DivergenceKind =
  | 'none'
  | 'payload_field'
  | 'spectator_digest'
  | 'frame_checksum'
  | 'frame_count'
  | 'event_payload'
  | 'event_count'
  | 'event_seq_mismatch';

export interface CombatDivergenceReport {
  schemaVersion: number;
  divergent: boolean;
  kind: DivergenceKind;
  /** Encounter IDs of two runs being compared. */
  encounterA: string;
  encounterB: string;
  /** Stable summary string suitable for log/dashboard. */
  summary: string;
  /** Specific divergence details — keys depend on kind. */
  detail?: Readonly<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────
// Run-snapshot — frozen view of a runtime for comparison
// ─────────────────────────────────────────────────────────

export interface RunSnapshot {
  encounterId: string;
  payload: CombatPayload;
  payloadHash: string;
  spectatorDigest: string;
  frames: readonly ReplayFrame[];
  events: readonly StreamEvent[];
}

/**
 * Capture a frozen RunSnapshot from a runtime — read-only.
 * Same rt state → same RunSnapshot ALWAYS.
 */
export function captureRunSnapshot(rt: CombatRuntime): RunSnapshot {
  const payload = buildCombatPayload(rt);
  const spectator = buildSpectatorSnapshot(rt);
  return {
    encounterId: rt.config.encounterId,
    payload,
    payloadHash: hashPayload(payload),
    spectatorDigest: spectator.digest,
    frames: rt.replayStream.frames,
    events: rt.replayStream.events,
  };
}

// ─────────────────────────────────────────────────────────
// Comparator — first divergence wins
// ─────────────────────────────────────────────────────────

/**
 * Compare two run snapshots — returns first divergence point.
 *
 * Priority order (most aggregate → most granular):
 *   1. Payload-level (catches almost-all drift quickly via aggregate hash)
 *   2. Spectator digest (catches private-field-leak drift)
 *   3. Frame count + per-frame checksum
 *   4. Event count + per-event seq/turn/kind/payload
 *
 * If payload hashes match but per-frame checksums differ, that's an
 * **internal inconsistency** (payload digest aggregates from frames) and the
 * report kind = `frame_checksum`. Useful for catching future bugs in the
 * payload aggregator itself.
 */
export function compareRunSnapshots(
  a: RunSnapshot,
  b: RunSnapshot,
): CombatDivergenceReport {
  // 1. Payload-level comparison
  const payloadDiff = comparePayloads(a.payload, b.payload);
  if (payloadDiff.divergent) {
    return {
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      divergent: true,
      kind: 'payload_field',
      encounterA: a.encounterId,
      encounterB: b.encounterId,
      summary: `payload field '${payloadDiff.field}' differs: ${JSON.stringify(payloadDiff.expected)} vs ${JSON.stringify(payloadDiff.actual)}`,
      detail: { field: payloadDiff.field, expected: payloadDiff.expected, actual: payloadDiff.actual },
    };
  }

  // 2. Spectator digest comparison (catches sanitization-relevant drift)
  if (a.spectatorDigest !== b.spectatorDigest) {
    return {
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      divergent: true,
      kind: 'spectator_digest',
      encounterA: a.encounterId,
      encounterB: b.encounterId,
      summary: `spectator digest differs: ${a.spectatorDigest} vs ${b.spectatorDigest}`,
      detail: { expected: a.spectatorDigest, actual: b.spectatorDigest },
    };
  }

  // 3. Frame count + per-frame checksum
  if (a.frames.length !== b.frames.length) {
    return {
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      divergent: true,
      kind: 'frame_count',
      encounterA: a.encounterId,
      encounterB: b.encounterId,
      summary: `frame count differs: ${a.frames.length} vs ${b.frames.length}`,
      detail: { expected: a.frames.length, actual: b.frames.length },
    };
  }
  for (let i = 0; i < a.frames.length; i++) {
    if (a.frames[i]!.checksum !== b.frames[i]!.checksum) {
      return {
        schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
        divergent: true,
        kind: 'frame_checksum',
        encounterA: a.encounterId,
        encounterB: b.encounterId,
        summary: `frame[${i}] checksum differs at turn=${a.frames[i]!.turn}: ${a.frames[i]!.checksum} vs ${b.frames[i]!.checksum}`,
        detail: {
          frameIndex: i, turn: a.frames[i]!.turn,
          expected: a.frames[i]!.checksum, actual: b.frames[i]!.checksum,
        },
      };
    }
  }

  // 4. Event count + per-event details
  if (a.events.length !== b.events.length) {
    return {
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      divergent: true,
      kind: 'event_count',
      encounterA: a.encounterId,
      encounterB: b.encounterId,
      summary: `event count differs: ${a.events.length} vs ${b.events.length}`,
      detail: { expected: a.events.length, actual: b.events.length },
    };
  }
  for (let i = 0; i < a.events.length; i++) {
    const ea = a.events[i]!;
    const eb = b.events[i]!;
    if (ea.seq !== eb.seq) {
      return {
        schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
        divergent: true,
        kind: 'event_seq_mismatch',
        encounterA: a.encounterId,
        encounterB: b.encounterId,
        summary: `event[${i}] seq differs: ${ea.seq} vs ${eb.seq}`,
        detail: { eventIndex: i, expected: ea.seq, actual: eb.seq },
      };
    }
    if (ea.turn !== eb.turn || ea.kind !== eb.kind) {
      return {
        schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
        divergent: true,
        kind: 'event_payload',
        encounterA: a.encounterId,
        encounterB: b.encounterId,
        summary: `event[seq=${ea.seq}] (turn,kind) differs: (${ea.turn},${ea.kind}) vs (${eb.turn},${eb.kind})`,
        detail: {
          seq: ea.seq,
          expected: { turn: ea.turn, kind: ea.kind },
          actual: { turn: eb.turn, kind: eb.kind },
        },
      };
    }
    // Canonical-JSON compare payload for deep equality
    if (canonicalJson(ea.payload) !== canonicalJson(eb.payload)) {
      return {
        schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
        divergent: true,
        kind: 'event_payload',
        encounterA: a.encounterId,
        encounterB: b.encounterId,
        summary: `event[seq=${ea.seq}] payload differs`,
        detail: {
          seq: ea.seq,
          expectedJson: canonicalJson(ea.payload),
          actualJson: canonicalJson(eb.payload),
        },
      };
    }
  }

  return {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    divergent: false,
    kind: 'none',
    encounterA: a.encounterId,
    encounterB: b.encounterId,
    summary: 'no divergence detected',
  };
}

// ─────────────────────────────────────────────────────────
// Convenience: compare 2 live runtimes directly
// ─────────────────────────────────────────────────────────

export function compareRuntimes(a: CombatRuntime, b: CombatRuntime): CombatDivergenceReport {
  return compareRunSnapshots(captureRunSnapshot(a), captureRunSnapshot(b));
}

// ─────────────────────────────────────────────────────────
// Batch verifier — run scenario N times, assert all identical
// ─────────────────────────────────────────────────────────

export interface BatchVerifyReport {
  trials: number;
  identical: boolean;
  /** First diverging trial index (vs trial 0), if any. */
  firstDivergentTrial?: number;
  /** Divergence detail for the first failing trial. */
  divergence?: CombatDivergenceReport;
  /** All payload hashes — useful for log/dashboard. */
  hashes: readonly string[];
}

/**
 * Run scenario factory N times. Capture each run's RunSnapshot.
 * Assert all snapshots agree with trial 0 (deterministic property).
 *
 * Use case: orchestrated replay reproducibility, refactor regression gate.
 */
export function verifyBatchDeterminism(
  scenario: () => CombatRuntime,
  trials: number,
): BatchVerifyReport {
  if (trials < 2) throw new Error('[BatchVerify] requires at least 2 trials');
  const snapshots: RunSnapshot[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < trials; i++) {
    const rt = scenario();
    const snap = captureRunSnapshot(rt);
    snapshots.push(snap);
    hashes.push(snap.payloadHash);
  }
  const baseline = snapshots[0]!;
  for (let i = 1; i < snapshots.length; i++) {
    const cmp = compareRunSnapshots(baseline, snapshots[i]!);
    if (cmp.divergent) {
      return {
        trials, identical: false, firstDivergentTrial: i,
        divergence: cmp, hashes,
      };
    }
  }
  return { trials, identical: true, hashes };
}
