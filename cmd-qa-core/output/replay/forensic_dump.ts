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
import { dirname, isAbsolute, normalize, sep } from 'node:path';
import type { ReplayVerifyResult } from './replay_verifier.js';

export const MAX_STATE_DUMP_BYTES = 10 * 1024 * 1024;

/** ISO-8601 timestamp regex (basic — allows Z or ±HH:MM offset). */
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

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
  // Audit bug#47: timestamp must be ISO-8601 to prevent downstream XSS /
  // injection when forensic JSON is rendered to dashboards.
  if (typeof p.timestamp !== 'string' || !ISO_8601_RE.test(p.timestamp)) {
    throw new TypeError(
      `writeForensicDump: timestamp must be ISO-8601 (got ${JSON.stringify(p.timestamp)})`,
    );
  }
  // Audit bug#43: outputPath must be absolute and not contain '..' segments
  // (path traversal). If null, no filesystem write happens (in-memory mode).
  if (p.outputPath !== null) {
    validateOutputPath(p.outputPath);
  }

  // Audit bug#44/#45/#46: safe serializer handles circular refs, BigInt,
  // NaN/Infinity, Date — instead of crashing or silently coercing to null.
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

function validateOutputPath(p: string): void {
  if (typeof p !== 'string' || p.length === 0) {
    throw new TypeError('forensic_dump.outputPath: must be non-empty string');
  }
  if (!isAbsolute(p)) {
    throw new RangeError(`forensic_dump.outputPath: must be absolute (got ${p})`);
  }
  // Reject null bytes (Win32 syscall would mis-truncate).
  if (p.includes('\0')) {
    throw new RangeError('forensic_dump.outputPath: null byte not allowed');
  }
  // Reject any '..' segment in the RAW path (path.join normalises them away,
  // but the intent is suspicious — bug#43 defense in depth).
  const rawSegments = p.split(/[\\/]/);
  for (const seg of rawSegments) {
    if (seg === '..') {
      throw new RangeError(`forensic_dump.outputPath: path traversal segment '..' in ${p}`);
    }
  }
  // Belt-and-suspenders: also check normalized form (handles repeated normalize cycles).
  const norm = normalize(p);
  for (const seg of norm.split(sep)) {
    if (seg === '..') {
      throw new RangeError(`forensic_dump.outputPath: path traversal after normalize in ${p}`);
    }
  }
}

/**
 * Safe serializer (audit bugs #44 / #45 / #46):
 *   - Circular refs become {__circular__: true} markers (no crash)
 *   - BigInt → {__bigint__: "<decimal string>"}
 *   - NaN / Infinity → {__non_finite__: "NaN"/"Infinity"/"-Infinity"}
 *   - Date → {__date__: "<iso>"}
 *   - Symbol / function values → {__unserializable__: "<type>"}
 *   - Then JSON.stringify; cap at MAX_STATE_DUMP_BYTES.
 */
function serializeWithCap(value: unknown): { value: unknown; truncated: boolean } {
  const safe = makeSafe(value, new WeakSet());
  const text = JSON.stringify(safe);
  if (typeof text === 'string' && Buffer.byteLength(text, 'utf8') > MAX_STATE_DUMP_BYTES) {
    const head = text.slice(0, 1024);
    return {
      value: {
        __truncated__: true,
        head_preview: head,
        original_bytes: Buffer.byteLength(text, 'utf8'),
      },
      truncated: true,
    };
  }
  return { value: safe, truncated: false };
}

function makeSafe(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'undefined') return null;
  if (t === 'function' || t === 'symbol') return { __unserializable__: t };
  if (t === 'bigint') return { __bigint__: (value as bigint).toString() };
  if (t === 'number') {
    const n = value as number;
    if (Number.isFinite(n)) return n;
    if (Number.isNaN(n)) return { __non_finite__: 'NaN' };
    if (n === Infinity) return { __non_finite__: 'Infinity' };
    return { __non_finite__: '-Infinity' };
  }
  if (t === 'string' || t === 'boolean') return value;
  // object branch
  if (value instanceof Date) return { __date__: value.toISOString() };
  if (value instanceof Map) {
    return { __map__: Array.from(value.entries()).map(([k, v]) => [makeSafe(k, seen), makeSafe(v, seen)]) };
  }
  if (value instanceof Set) {
    return { __set__: Array.from(value.values()).map((v) => makeSafe(v, seen)) };
  }
  if (value instanceof RegExp) return { __regex__: value.source, flags: value.flags };
  if (value instanceof Error) {
    return { __error__: { name: value.name, message: value.message, stack: value.stack ?? null } };
  }
  if (seen.has(value as object)) return { __circular__: true };
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => makeSafe(v, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = makeSafe(v, seen);
  }
  return out;
}
