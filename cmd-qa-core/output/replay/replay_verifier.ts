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
 * Both arrays must be sorted by tick ascending (caller responsibility).
 * Mismatched array lengths are themselves divergence at the last shared tick.
 */
export function verifyReplay(p: ReplayVerifyParams): ReplayVerifyResult {
  if (typeof p.battleId !== 'string' || p.battleId.length === 0) {
    throw new TypeError('verifyReplay: battleId must be non-empty string');
  }
  if (!Array.isArray(p.original) || !Array.isArray(p.replayed)) {
    throw new TypeError('verifyReplay: original and replayed must be arrays');
  }

  const shared = Math.min(p.original.length, p.replayed.length);
  for (let i = 0; i < shared; i++) {
    const o = p.original[i];
    const r = p.replayed[i];
    if (!o || !r) {
      throw new TypeError(`verifyReplay: missing checkpoint at index ${i}`);
    }
    if (o.tick !== r.tick) {
      // Tick-number desync at same index = structural divergence.
      return {
        match: false,
        divergenceTick: Math.min(o.tick, r.tick),
        originalHash: o.hash,
        replayedHash: r.hash,
        checkpointsCompared: i + 1,
      };
    }
    if (o.hash !== r.hash) {
      return {
        match: false,
        divergenceTick: o.tick,
        originalHash: o.hash,
        replayedHash: r.hash,
        checkpointsCompared: i + 1,
      };
    }
  }
  if (p.original.length !== p.replayed.length) {
    const longer = p.original.length > p.replayed.length ? p.original : p.replayed;
    const firstExtra = longer[shared];
    if (!firstExtra) {
      // Defensive — should not happen given shared = min(lengths).
      return { match: true, checkpointsCompared: shared };
    }
    return {
      match: false,
      divergenceTick: firstExtra.tick,
      originalHash: p.original.length > shared ? firstExtra.hash : '<missing>',
      replayedHash: p.replayed.length > shared ? firstExtra.hash : '<missing>',
      checkpointsCompared: shared,
    };
  }
  return { match: true, checkpointsCompared: shared };
}
