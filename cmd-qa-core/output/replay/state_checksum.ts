/**
 * R68.1 State Checksum — SVTK Foundation v2.8.0
 *
 * Deterministic checksum over battle state for replay verification.
 * Uses canonical JSON (recursive sorted keys, same algorithm class as
 * packet_envelope) then SHA-256.
 *
 * Compatibility: state values MUST be JSON-serializable plain data
 * (no Date / Map / Set / Symbol / BigInt / NaN / Infinity / functions).
 * canonicalJson throws if unsupported types found — caller must serialize
 * via toJSON() upstream.
 *
 * Foundation R68.1: checksum every 100 ticks (10s at 100ms tick rate).
 */

import { createHash } from 'node:crypto';

export const CHECKSUM_METHOD = 'sha256_canonical_v1';
export const DEFAULT_CHECKPOINT_INTERVAL_TICKS = 100;

export interface StateChecksum {
  tick: number;
  hash: string;
  method: typeof CHECKSUM_METHOD;
}

export interface BattleStateSnapshot {
  /** Server-authoritative tick number (R67). */
  tick: number;
  /** Plain-data state — units, HP, mana, statuses, RNG state. */
  state: unknown;
}

/**
 * Compute checksum of a single state snapshot.
 * Deterministic across Node x64 / ARM / Unity Mono (no float in canonical hash).
 */
export function computeStateChecksum(snapshot: BattleStateSnapshot): StateChecksum {
  if (typeof snapshot.tick !== 'number' || !Number.isInteger(snapshot.tick) || snapshot.tick < 0) {
    throw new RangeError(`computeStateChecksum: tick must be non-negative integer (got ${snapshot.tick})`);
  }
  const canonical = canonicalJson(snapshot.state, 0);
  const hash = createHash('sha256').update(canonical).digest('hex');
  return { tick: snapshot.tick, hash, method: CHECKSUM_METHOD };
}

/**
 * Generate per-checkpoint checksums from a journal of snapshots.
 * Foundation R68.1: every CHECKPOINT_INTERVAL_TICKS (default 100).
 */
export function generateCheckpoints(
  snapshots: BattleStateSnapshot[],
  intervalTicks: number = DEFAULT_CHECKPOINT_INTERVAL_TICKS,
): StateChecksum[] {
  if (!Number.isInteger(intervalTicks) || intervalTicks < 1) {
    throw new RangeError(
      `generateCheckpoints: intervalTicks must be positive integer (got ${intervalTicks})`,
    );
  }
  const checkpoints: StateChecksum[] = [];
  for (const snap of snapshots) {
    if (snap.tick % intervalTicks === 0) {
      checkpoints.push(computeStateChecksum(snap));
    }
  }
  return checkpoints;
}

const MAX_CANONICAL_DEPTH = 64;

function canonicalJson(value: unknown, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new RangeError(`state_checksum canonicalJson: depth exceeds ${MAX_CANONICAL_DEPTH}`);
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`state_checksum: unsupported type ${typeof value}`);
  }
  if (typeof value === 'bigint') {
    throw new TypeError('state_checksum: BigInt not supported in state snapshot');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`state_checksum: non-finite number ${value} not supported`);
  }
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date || value instanceof Map || value instanceof Set || value instanceof RegExp) {
    throw new TypeError(`state_checksum: ${value.constructor.name} not supported`);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v, depth + 1)).join(',') + ']';
  }
  if (Object.getOwnPropertySymbols(value as object).length > 0) {
    throw new TypeError('state_checksum: Symbol-keyed properties not supported');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    throw new TypeError('state_checksum: only plain objects supported');
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => typeof v !== 'undefined')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    '{' +
    entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v, depth + 1)).join(',') +
    '}'
  );
}
