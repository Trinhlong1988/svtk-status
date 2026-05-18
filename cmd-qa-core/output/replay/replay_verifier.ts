/**
 * R68.2 Replay Verifier — SVTK Foundation v2.8.0
 *
 * Async background job that re-runs a completed battle journal and compares
 * per-checkpoint checksums against the original. Mismatch → divergence flag
 * + forensic dump (R68.3) + anti-cheat hook (R68.5).
 *
 * This module is a PURE verifier: it does not actually re-execute combat
 * (that's cmd-engine's domain). It accepts two sequences of checksums:
 *   - `original`: from the live battle (server-authoritative).
 *   - `replayed`: from re-running the journal with same seed (cmd-engine).
 * and reports the FIRST divergence (or none).
 */

import type { StateChecksum } from './state_checksum.js';

export interface ReplayVerifyParams {
  battleId: string;
  original: StateChecksum[];
  replayed: StateChecksum[];
}

export type ReplayVerifyResult =
  | { match: true; checkpointsCompared: number }
  | {
      match: false;
      divergenceTick: number;
      originalHash: string;
      replayedHash: string;
      checkpointsCompared: number;
    };

/**
 * Compare two checkpoint sequences. Returns the first tick where checksums
 * diverge. `checkpointsCompared` counts checkpoints inspected up to (and
 * including) the divergence — for forensic context.
 *
 * Audit bugs fixed:
 *   #41 — match by TICK, not by array index (scrambled order no longer
 *         produces false divergence at index-1).
 *   #50 — verifier rejects when `method` field differs between sequences
 *         (e.g., one sha256_canonical_v1 vs other md5_legacy) so an
 *         algorithm switch can't false-positive match by coincidence.
 *   #48 — duplicate ticks in either sequence rejected as malformed.
 */
export function verifyReplay(p: ReplayVerifyParams): ReplayVerifyResult {
  if (typeof p.battleId !== 'string' || p.battleId.length === 0) {
    throw new TypeError('verifyReplay: battleId must be non-empty string');
  }
  if (!Array.isArray(p.original) || !Array.isArray(p.replayed)) {
    throw new TypeError('verifyReplay: original and replayed must be arrays');
  }

  // Build tick→checksum maps. Reject duplicate ticks (bug#48).
  const origByTick = buildMap(p.original, 'original');
  const replayByTick = buildMap(p.replayed, 'replayed');

  // Verify method consistency across all checksums (bug#50).
  const methods = new Set<string>();
  for (const c of p.original) methods.add(c.method);
  for (const c of p.replayed) methods.add(c.method);
  if (methods.size > 1) {
    return {
      match: false,
      divergenceTick: -1,
      originalHash: '<method_mismatch>',
      replayedHash: Array.from(methods).join(','),
      checkpointsCompared: 0,
    };
  }

  // Union of ticks, iterated ascending — find first divergent tick.
  const allTicks = new Set<number>();
  for (const c of p.original) allTicks.add(c.tick);
  for (const c of p.replayed) allTicks.add(c.tick);
  const sortedTicks = [...allTicks].sort((a, b) => a - b);

  let compared = 0;
  for (const tick of sortedTicks) {
    const o = origByTick.get(tick);
    const r = replayByTick.get(tick);
    if (!o || !r) {
      // Missing in one side → divergence at this tick.
      return {
        match: false,
        divergenceTick: tick,
        originalHash: o ? o.hash : '<missing>',
        replayedHash: r ? r.hash : '<missing>',
        checkpointsCompared: compared,
      };
    }
    if (o.hash !== r.hash) {
      return {
        match: false,
        divergenceTick: tick,
        originalHash: o.hash,
        replayedHash: r.hash,
        checkpointsCompared: compared + 1,
      };
    }
    compared += 1;
  }
  return { match: true, checkpointsCompared: compared };
}

function buildMap(
  arr: ReadonlyArray<{ tick: number; hash: string; method: string }>,
  label: string,
): Map<number, { tick: number; hash: string; method: string }> {
  const map = new Map<number, { tick: number; hash: string; method: string }>();
  for (const c of arr) {
    if (map.has(c.tick)) {
      throw new RangeError(`verifyReplay: ${label} has duplicate tick ${c.tick}`);
    }
    map.set(c.tick, c);
  }
  return map;
}
