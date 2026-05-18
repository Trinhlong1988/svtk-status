/**
 * R68.3 Forensic Dump — SVTK Foundation v2.8.0
 *
 * When verifyReplay() reports divergence (R68.2), write a forensic record
 * for offline analysis. Production target path per Foundation:
 *   cmd-lead/forensics/divergence-{battle_id}-{ts}.json
 *
 * Foundation R68.3 contents:
 *   - battle_id
 *   - divergence_tick
 *   - original_state_hash + replayed_state_hash
 *   - original_state_full + replayed_state_full (limit 10MB each)
 *   - rng_state_history
 *   - action_log
 *   - environment_info (foundation_version, runtime_version)
 *   - alert: HIGH severity to LEAD
 *
 * R68.3 Gap (admitted in Foundation): raid state may exceed 10MB. This
 * module sets the 10MB SOFT cap and emits a `truncated: true` flag if hit;
 * caller can opt-in to chunked dump (future svtk_runtime work).
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ReplayVerifyResult } from './replay_verifier.js';

export const MAX_STATE_DUMP_BYTES = 10 * 1024 * 1024;

export interface ForensicEnvironment {
  foundationVersion: string;
  runtimeVersion: string;
}

export interface ForensicDumpParams {
  battleId: string;
  verdict: ReplayVerifyResult & { match: false };
  originalStateFull: unknown;
  replayedStateFull: unknown;
  rngStateHistory?: unknown;
  actionLog?: unknown;
  environment: ForensicEnvironment;
  /** Absolute path or null to skip filesystem write (returns dump body only). */
  outputPath: string | null;
  /** Wall-clock ts for filename and metadata (audit log — R67.1 permits wall clock here). */
  timestamp: string;
}

export interface ForensicDumpResult {
  /** Serialized dump body (JSON). */
  body: string;
  /** Bytes written; equals body.length when output succeeds. */
  bytesWritten: number;
  /** True if either state was truncated due to MAX_STATE_DUMP_BYTES soft cap. */
  truncated: boolean;
  /** Path written, or null if outputPath was null. */
  writtenTo: string | null;
}

export function writeForensicDump(p: ForensicDumpParams): ForensicDumpResult {
  if (typeof p.battleId !== 'string' || p.battleId.length === 0) {
    throw new TypeError('writeForensicDump: battleId required');
  }
  if (p.verdict.match) {
    throw new TypeError('writeForensicDump: only call on divergence (verdict.match=false)');
  }

  const originalSerialized = serializeWithCap(p.originalStateFull);
  const replayedSerialized = serializeWithCap(p.replayedStateFull);
  const truncated = originalSerialized.truncated || replayedSerialized.truncated;

  const dump = {
    schema: 'svtk_forensic_dump_v1',
    battle_id: p.battleId,
    timestamp: p.timestamp,
    divergence_tick: p.verdict.divergenceTick,
    checkpoints_compared: p.verdict.checkpointsCompared,
    original_state_hash: p.verdict.originalHash,
    replayed_state_hash: p.verdict.replayedHash,
    original_state_full: originalSerialized.value,
    original_state_truncated: originalSerialized.truncated,
    replayed_state_full: replayedSerialized.value,
    replayed_state_truncated: replayedSerialized.truncated,
    rng_state_history: p.rngStateHistory ?? null,
    action_log: p.actionLog ?? null,
    environment: p.environment,
    alert: { severity: 'HIGH', recipient: 'cmd-lead', topic: 'replay_divergence' },
  };

  const body = JSON.stringify(dump, null, 2);

  let writtenTo: string | null = null;
  if (p.outputPath !== null) {
    const dir = dirname(p.outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(p.outputPath, body, { encoding: 'utf8' });
    writtenTo = p.outputPath;
  }

  return {
    body,
    bytesWritten: Buffer.byteLength(body, 'utf8'),
    truncated,
    writtenTo,
  };
}

function serializeWithCap(value: unknown): { value: unknown; truncated: boolean } {
  const text = JSON.stringify(value);
  if (typeof text === 'string' && Buffer.byteLength(text, 'utf8') > MAX_STATE_DUMP_BYTES) {
    // Replace with a marker; preserve a small head for grep-ability.
    const head = text.slice(0, 1024);
    return {
      value: { __truncated__: true, head_preview: head, original_bytes: Buffer.byteLength(text, 'utf8') },
      truncated: true,
    };
  }
  return { value, truncated: false };
}
