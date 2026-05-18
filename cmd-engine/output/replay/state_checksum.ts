/**
 * STATE CHECKSUM (R68) — deterministic hash of combat state per N ticks.
 *
 * Foundation v2.8.0 R68: every replay stream MUST emit SHA-256 checkpoints
 * at fixed turn intervals (default N=10) so divergence between two reruns
 * (or server-vs-client) can be detected and forensically dumped.
 *
 * Strictly additive — does NOT modify replay_event_stream.ts. Caller wires
 * `checksumStream()` after `appendFrame()` calls.
 *
 * Determinism: canonical JSON encoding (sorted keys, no whitespace) feeds
 * Node's `crypto.createHash('sha256')`. Same frame → same hex digest, byte
 * for byte, across processes and OSes.
 *
 * Cross-CMD contract:
 *   - cmd-engine emits checkpoints into stream sidecar (this module).
 *   - cmd-qa-core compares server checkpoints vs client replay checkpoints.
 *   - cmd-lead receives forensic dump on divergence (alerts/<cmd>_*).
 */
import { createHash } from 'node:crypto';
import type {
  ReplayEventStream,
  StreamEvent,
} from '../legacy/replay_event_stream.js';
import type { ReplayFrame } from '../legacy/replay_frame.js';

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

/** SHA-256 hex digest (64 lowercase chars). */
export type Sha256Hex = string;

/** One checkpoint = snapshot of frame state at a sampled turn. */
export interface StateCheckpoint {
  readonly turn: number;
  readonly frame_id: string;
  readonly checksum: Sha256Hex;
  /** Running aggregate — sha256(prev_aggregate || checksum). Enables chain validation. */
  readonly aggregate: Sha256Hex;
}

/** Report from comparing two checkpoint chains. */
export interface DivergenceReport {
  readonly divergent: boolean;
  /** First turn where checksums differ (undefined if streams match within shared range). */
  readonly first_divergent_turn?: number;
  /** Side A checkpoint at first divergence (undefined if A shorter). */
  readonly a_at_divergence?: StateCheckpoint;
  /** Side B checkpoint at first divergence (undefined if B shorter). */
  readonly b_at_divergence?: StateCheckpoint;
  /** Both chains' aggregate digests at the last common turn. */
  readonly aggregate_a?: Sha256Hex;
  readonly aggregate_b?: Sha256Hex;
}

/** Forensic dump — events + frame around a divergence. */
export interface ForensicDump {
  readonly divergence_turn: number;
  readonly frame: ReplayFrame | undefined;
  readonly events_in_turn: readonly StreamEvent[];
  readonly events_prev_turn: readonly StreamEvent[];
  readonly checksum_actual: Sha256Hex | undefined;
  readonly checksum_expected: Sha256Hex | undefined;
}

// ─────────────────────────────────────────────────────────
// Canonical JSON
// ─────────────────────────────────────────────────────────

/**
 * Canonicalize a value for hashing: deep, key-sorted, whitespace-free JSON.
 * Arrays preserve order (semantic). Objects sort keys lexicographically.
 *
 * NaN / Infinity / functions are not expected in ReplayFrame (zod-validated),
 * but we treat them defensively: NaN/Inf → null, functions → null.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(value, canonicalReplacer);
}

function canonicalReplacer(_key: string, val: unknown): unknown {
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : null;
  }
  if (typeof val === 'function') {
    return null;
  }
  if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = obj[k];
    }
    return sorted;
  }
  return val;
}

// ─────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────

/** Pure SHA-256 of a canonical frame encoding. */
export function checksumFrame(frame: ReplayFrame): Sha256Hex {
  const canon = canonicalize(frame);
  return createHash('sha256').update(canon).digest('hex');
}

function chainAggregate(prev_aggregate: Sha256Hex, next_checksum: Sha256Hex): Sha256Hex {
  return createHash('sha256').update(prev_aggregate).update(next_checksum).digest('hex');
}

// ─────────────────────────────────────────────────────────
// Stream checkpoint emit
// ─────────────────────────────────────────────────────────

export const DEFAULT_CHECKSUM_EVERY_N_TURNS = 10;

export interface ChecksumOptions {
  /** Sample interval (turn count). Default 10. Must be ≥ 1. */
  every_n_turns?: number;
  /** Optional initial aggregate seed. Default sha256(encounterId). */
  initial_aggregate?: Sha256Hex;
}

/**
 * Walk a stream's frames and emit checkpoints every N turns.
 *
 * - Turn 0 (if present) is always sampled.
 * - Last sealed frame is always sampled (so divergence at the tail is caught).
 * - Frames between sample points contribute to subsequent aggregates only.
 */
export function checksumStream(
  stream: ReplayEventStream,
  options: ChecksumOptions = {},
): readonly StateCheckpoint[] {
  const every = options.every_n_turns ?? DEFAULT_CHECKSUM_EVERY_N_TURNS;
  if (every < 1) {
    throw new RangeError(`every_n_turns must be ≥ 1, got ${every}`);
  }

  const seed_input = options.initial_aggregate ?? stream.encounterId;
  let aggregate: Sha256Hex = createHash('sha256').update(seed_input).digest('hex');

  const checkpoints: StateCheckpoint[] = [];
  const frames = stream.frames;
  const last_idx = frames.length - 1;

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame === undefined) continue;
    const is_sample = i === 0 || i === last_idx || frame.turn % every === 0;
    const checksum = checksumFrame(frame);
    aggregate = chainAggregate(aggregate, checksum);
    if (is_sample) {
      checkpoints.push({
        turn: frame.turn,
        frame_id: frame.frameId,
        checksum,
        aggregate,
      });
    }
  }
  return checkpoints;
}

// ─────────────────────────────────────────────────────────
// Compare two checkpoint chains
// ─────────────────────────────────────────────────────────

export function compareCheckpoints(
  a: readonly StateCheckpoint[],
  b: readonly StateCheckpoint[],
): DivergenceReport {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined || bi === undefined) continue;
    if (ai.turn !== bi.turn || ai.checksum !== bi.checksum) {
      return {
        divergent: true,
        first_divergent_turn: ai.turn,
        a_at_divergence: ai,
        b_at_divergence: bi,
        aggregate_a: i > 0 ? a[i - 1]?.aggregate : undefined,
        aggregate_b: i > 0 ? b[i - 1]?.aggregate : undefined,
      };
    }
  }
  if (a.length !== b.length) {
    const tail = a.length > b.length ? a : b;
    const at = tail[shared];
    return {
      divergent: true,
      first_divergent_turn: at?.turn,
      a_at_divergence: a[shared],
      b_at_divergence: b[shared],
      aggregate_a: shared > 0 ? a[shared - 1]?.aggregate : undefined,
      aggregate_b: shared > 0 ? b[shared - 1]?.aggregate : undefined,
    };
  }
  return { divergent: false };
}

// ─────────────────────────────────────────────────────────
// Forensic dump
// ─────────────────────────────────────────────────────────

/**
 * Build a forensic dump centred on a turn — includes the suspect frame,
 * all stream events in that turn, and the immediately preceding turn for
 * causal context.
 *
 * Caller pattern: when `compareCheckpoints()` reports `divergent`, push
 * `forensicDump(stream, report.first_divergent_turn)` into the alert payload
 * so cmd-qa-core has enough trace to triage.
 */
export function forensicDump(
  stream: ReplayEventStream,
  divergence_turn: number,
  expected_checksum?: Sha256Hex,
): ForensicDump {
  const frame = stream.frames.find((f) => f.turn === divergence_turn);
  const events_in_turn = stream.events.filter((e) => e.turn === divergence_turn);
  const events_prev_turn = stream.events.filter((e) => e.turn === divergence_turn - 1);
  return {
    divergence_turn,
    frame,
    events_in_turn,
    events_prev_turn,
    checksum_actual: frame ? checksumFrame(frame) : undefined,
    checksum_expected: expected_checksum,
  };
}
