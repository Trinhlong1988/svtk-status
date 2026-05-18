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
 * NaN / +Infinity / -Infinity are not expected in ReplayFrame (zod-validated),
 * but we encode them as distinct sentinel strings so forensic divergence is
 * preserved (R68 invariant: state delta must produce distinct hash). Previous
 * behavior collapsed all three to `null`, hiding adversarial payloads.
 *
 * Functions → null (not serialisable anyway).
 */
export const CANON_SENTINEL_NAN = '__SVTK_NaN__';
export const CANON_SENTINEL_POS_INF = '__SVTK_+Infinity__';
export const CANON_SENTINEL_NEG_INF = '__SVTK_-Infinity__';
export const CANON_SENTINEL_BIGINT_PREFIX = '__SVTK_BigInt:';
export const CANON_SENTINEL_SYMBOL_PREFIX = '__SVTK_Symbol:';
export const CANON_SENTINEL_UNDEFINED = '__SVTK_undefined__';
/** Sentinel for protocol-reserved keys (__proto__, constructor) so payload is preserved. */
export const CANON_KEY_PROTO = '__SVTK_KEY_proto__';
export const CANON_KEY_CONSTRUCTOR = '__SVTK_KEY_constructor__';
/** Sentinel emitted when a circular reference is detected during walk. */
export const CANON_SENTINEL_CIRCULAR = '__SVTK_CIRCULAR__';
/** Sentinels for built-in container types — JSON.stringify would otherwise flatten them to {}. */
export const CANON_TAG_DATE = '__SVTK_Date__';
export const CANON_TAG_MAP = '__SVTK_Map__';
export const CANON_TAG_SET = '__SVTK_Set__';
/** Sentinel for arrays carrying non-index own properties (otherwise dropped by JSON.stringify). */
export const CANON_TAG_ARRAY_WITH_META = '__SVTK_ArrayMeta__';
/** Sentinel emitted when a property getter throws during walk (prevents R68 DoS). */
export const CANON_SENTINEL_GETTER_THREW = '__SVTK_GETTER_THREW__';
/** Prefix for symbol-keyed properties (Object.keys would otherwise skip them, hiding payload). */
export const CANON_KEY_SYMBOL_PREFIX = '__SVTK_SYM_KEY:';

// Use Map (not object literal) — assigning `__proto__` as a key in object
// literal syntax sets the prototype of the literal itself instead of creating
// an own property, which would defeat the rename pass.
const RESERVED_KEY_MAP = new Map<string, string>([
  ['__proto__', CANON_KEY_PROTO],
  ['constructor', CANON_KEY_CONSTRUCTOR],
]);

export function canonicalize(value: unknown): string {
  // Pre-walk converts exotic types JSON.stringify can't handle (bigint),
  // silently drops (Symbol values, undefined), or mishandles (__proto__ key
  // sets prototype instead of own-property). Also NFC-normalises strings and
  // breaks **true** circular references with a sentinel (without false-flagging
  // legitimately shared DAG subtrees, which is why we use a path-set, not a
  // visited-set: nodes are removed when we finish walking them).
  const prepared = prepareForJson(value, new WeakSet());
  return JSON.stringify(prepared, canonicalReplacer);
}

function prepareForJson(val: unknown, path: WeakSet<object>): unknown {
  if (typeof val === 'bigint') {
    return `${CANON_SENTINEL_BIGINT_PREFIX}${val.toString()}__`;
  }
  if (typeof val === 'symbol') {
    return `${CANON_SENTINEL_SYMBOL_PREFIX}${val.description ?? ''}__`;
  }
  if (val === undefined) {
    return CANON_SENTINEL_UNDEFINED;
  }
  if (typeof val === 'string') {
    // NFC normalisation so equivalent unicode forms hash identically.
    return val.normalize('NFC');
  }
  if (val instanceof Date) {
    // JSON.stringify would call .toJSON() → ISO string, but only when reached
    // via a plain object's own value; Date wrapped in our null-proto object
    // and traversed by prepareForJson would otherwise emit {} (no own enum
    // keys). Tag explicitly so two distinct timestamps hash distinctly.
    return { [CANON_TAG_DATE]: val.getTime() };
  }
  if (val instanceof Map) {
    if (path.has(val)) return CANON_SENTINEL_CIRCULAR;
    path.add(val);
    // Sort entries by canonical-key string for determinism.
    const map_entries = Array.from(val.entries()).map(([k, v]) => [
      prepareForJson(k, path),
      prepareForJson(v, path),
    ]);
    map_entries.sort((a, b) => {
      const ka = JSON.stringify(a[0]);
      const kb = JSON.stringify(b[0]);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    path.delete(val);
    return { [CANON_TAG_MAP]: map_entries };
  }
  if (val instanceof Set) {
    if (path.has(val)) return CANON_SENTINEL_CIRCULAR;
    path.add(val);
    const set_items = Array.from(val).map((item) => prepareForJson(item, path));
    set_items.sort((a, b) => {
      const sa = JSON.stringify(a);
      const sb = JSON.stringify(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    path.delete(val);
    return { [CANON_TAG_SET]: set_items };
  }
  if (Array.isArray(val)) {
    if (path.has(val)) return CANON_SENTINEL_CIRCULAR;
    path.add(val);
    const arr_items = val.map((item) => prepareForJson(item, path));
    // Detect arrays with non-index own properties (e.g. `arr.metadata = ...`).
    // Plain JSON.stringify would silently drop those; we tag them so an
    // attacker can't hide payload by stashing it on an array.
    const extra_keys = Object.keys(val).filter((k) => !/^\d+$/.test(k));
    if (extra_keys.length === 0) {
      path.delete(val);
      return arr_items;
    }
    const meta_block: Record<string, unknown> = Object.create(null);
    for (const k of extra_keys) {
      const obj = val as unknown as Record<string, unknown>;
      const safe_key = RESERVED_KEY_MAP.get(k) ?? k;
      Object.defineProperty(meta_block, safe_key, {
        value: prepareForJson(obj[k], path),
        enumerable: true, configurable: true, writable: true,
      });
    }
    path.delete(val);
    return { [CANON_TAG_ARRAY_WITH_META]: { items: arr_items, meta: meta_block } };
  }
  if (val !== null && typeof val === 'object') {
    if (path.has(val)) return CANON_SENTINEL_CIRCULAR;
    path.add(val);
    // Build via Object.create(null) so assigning '__proto__' as a key cannot
    // mutate the prototype chain. We rename reserved keys to a sentinel so
    // the payload value is preserved in canonical output.
    const obj = val as Record<string, unknown>;
    const out: Record<string, unknown> = Object.create(null);
    const string_keys = Object.keys(obj);
    const symbol_keys = Object.getOwnPropertySymbols(obj).filter((s) =>
      Object.getOwnPropertyDescriptor(obj, s)?.enumerable === true,
    );
    for (const k of string_keys) {
      // Skip toJSON — JSON.stringify would otherwise call it on the prepared
      // object and let an attacker replace the entire serialised state.
      if (k === 'toJSON') continue;
      const safe_key = RESERVED_KEY_MAP.get(k) ?? k;
      // Wrap getter access — if a property getter throws, emit a sentinel so
      // R68 doesn't crash on adversarial input.
      let prepared_value: unknown;
      try {
        prepared_value = prepareForJson(obj[k], path);
      } catch {
        prepared_value = CANON_SENTINEL_GETTER_THREW;
      }
      Object.defineProperty(out, safe_key, {
        value: prepared_value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    // Symbol-keyed enumerable own properties — Object.keys() skips them, which
    // would let an attacker hide payload under a symbol key. Encode as
    // CANON_KEY_SYMBOL_PREFIX + description so the value enters the hash.
    for (const sym of symbol_keys) {
      const safe_key = `${CANON_KEY_SYMBOL_PREFIX}${sym.description ?? ''}__`;
      let prepared_value: unknown;
      try {
        prepared_value = prepareForJson((obj as unknown as Record<symbol, unknown>)[sym], path);
      } catch {
        prepared_value = CANON_SENTINEL_GETTER_THREW;
      }
      Object.defineProperty(out, safe_key, {
        value: prepared_value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    path.delete(val);
    return out;
  }
  return val;
}

function canonicalReplacer(_key: string, val: unknown): unknown {
  if (typeof val === 'number') {
    if (Number.isFinite(val)) return val;
    if (Number.isNaN(val)) return CANON_SENTINEL_NAN;
    return val > 0 ? CANON_SENTINEL_POS_INF : CANON_SENTINEL_NEG_INF;
  }
  if (typeof val === 'function') {
    return null;
  }
  if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    const sorted: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(obj).sort()) {
      Object.defineProperty(sorted, k, {
        value: obj[k],
        enumerable: true,
        configurable: true,
        writable: true,
      });
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
/**
 * Build a forensic dump centred on a turn — returns a DEFENSIVE deep clone +
 * deep-freeze, so cmd-qa-core / cmd-lead consumers can't accidentally rewrite
 * stream state through the dump.frame reference.
 */
export function forensicDump(
  stream: ReplayEventStream,
  divergence_turn: number,
  expected_checksum?: Sha256Hex,
): ForensicDump {
  const live_frame = stream.frames.find((f) => f.turn === divergence_turn);
  const live_in_turn = stream.events.filter((e) => e.turn === divergence_turn);
  const live_prev_turn = stream.events.filter((e) => e.turn === divergence_turn - 1);
  return Object.freeze({
    divergence_turn,
    frame: live_frame ? (deepFreeze(structuredClone(live_frame)) as ReplayFrame) : undefined,
    events_in_turn: Object.freeze(live_in_turn.map((e) => deepFreeze(structuredClone(e)) as StreamEvent)),
    events_prev_turn: Object.freeze(live_prev_turn.map((e) => deepFreeze(structuredClone(e)) as StreamEvent)),
    checksum_actual: live_frame ? checksumFrame(live_frame) : undefined,
    checksum_expected: expected_checksum,
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const k of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[k]);
  }
  return Object.freeze(value);
}
