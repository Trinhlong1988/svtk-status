/**
 * REPLAY COMPACTION — large raid memory hygiene (Phase 6 FP follow-on).
 *
 * Problem (CMD1.docx Phase 6 FP § XII PERFORMANCE HARDENING):
 *   In large raid (40v40 / 200+ entities / 120+ AoE / 80 companions / 30+ turn):
 *     - Frame log: 30 turn × ~150 events/turn ≈ 4500 events
 *     - Event log per turn: damage spam (hundreds of small damage events)
 *     - Snapshot per turn carries threatSnapshot[] + statusDeltas[] + damageEvents[]
 *
 *   Naive append-only stream → unbounded memory, slow to serialize for save.
 *
 * Solution: **lossless compaction** (default) + **lossy compaction** (opt-in).
 *
 *   Lossless ops:
 *     - Coalesce damage events: (source, target, skill) same-turn duplicates →
 *       single event with summed amount + occurrence count.
 *     - Drop status_tick events where no observable side-effect on threat /
 *       hp / status state changed (caller signals via `payload.noop=true`).
 *     - Deduplicate identical RNG traces.
 *
 *   Lossy ops (opt-in via CompactionPolicy.lossy=true):
 *     - Drop status_tick events entirely (preserve frames + status_apply only).
 *     - Threat snapshot top-N truncation per frame.
 *     - Drop damage events older than N turns (keep only frames).
 *
 * Determinism: lossless compaction NEVER changes replay determinism — it only
 * reorganizes / coalesces events that have no causal effect downstream.
 * Lossy compaction reduces forensic fidelity but preserves frame-level rollback.
 *
 * Compaction is invoked PERIODICALLY by caller (vd every N turn or when memory
 * threshold exceeded). Never automatically — caller owns the policy.
 */
import type {
  ReplayEventStream, StreamEvent, StreamEventKind,
} from './replay_event_stream.js';
import type { ReplayFrame } from './replay_frame.js';

// ─────────────────────────────────────────────────────────
// Policy
// ─────────────────────────────────────────────────────────

export interface CompactionPolicy {
  /** Enable lossy ops (default false — only lossless). */
  lossy: boolean;
  /** Keep last N turn of events fully — older turns subject to lossy ops. */
  forensicWindowTurns: number;
  /** Top-N threat entries to keep per frame snapshot (lossy mode). */
  threatTopN: number;
  /** Drop status_tick events older than forensic window (lossy mode). */
  dropOldStatusTicks: boolean;
  /** Drop damage events older than forensic window (lossy mode). */
  dropOldDamageEvents: boolean;
}

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  lossy: false,
  forensicWindowTurns: 10,
  threatTopN: 8,
  dropOldStatusTicks: false,
  dropOldDamageEvents: false,
};

// ─────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────

export interface CompactionReport {
  /** Total events before. */
  beforeEvents: number;
  /** Total events after (post-compaction). */
  afterEvents: number;
  /** Bytes saved estimate (events removed × avg byte). */
  estimatedBytesSaved: number;
  /** Per-kind breakdown of removed/coalesced events. */
  removedByKind: Readonly<Record<string, number>>;
  /** Damage events coalesced (N → 1). */
  damageCoalesced: number;
  /** RNG traces deduplicated. */
  rngTracesDeduped: number;
  /** Frames with truncated threatSnapshot (lossy). */
  framesThreatTruncated: number;
  /** Whether lossy mode was used. */
  lossy: boolean;
}

// ─────────────────────────────────────────────────────────
// Compaction entry point
// ─────────────────────────────────────────────────────────

export function compactReplayStream(
  stream: ReplayEventStream,
  policy: CompactionPolicy = DEFAULT_COMPACTION_POLICY,
): CompactionReport {
  const beforeEvents = stream.events.length;
  const removedByKind: Record<string, number> = {};
  const incRemoved = (k: string, n: number = 1): void => {
    removedByKind[k] = (removedByKind[k] ?? 0) + n;
  };

  // ── Lossless: coalesce damage events ──
  const coalesceResult = coalesceDamageEvents(stream.events);
  stream.events = coalesceResult.events;

  // ── Lossless: drop noop status_tick events ──
  const tickDrop = dropNoopStatusTicks(stream.events);
  stream.events = tickDrop.events;
  incRemoved('status_tick', tickDrop.dropped);

  // ── Lossy ops ──
  let framesThreatTruncated = 0;
  if (policy.lossy) {
    const lastFrameTurn = stream.lastFrameTurn;
    const oldThreshold = lastFrameTurn - policy.forensicWindowTurns;

    if (policy.dropOldDamageEvents && oldThreshold > 0) {
      const dropDamage = dropOldEventsOfKind(stream.events, 'damage', oldThreshold);
      stream.events = dropDamage.events;
      incRemoved('damage', dropDamage.dropped);
    }
    if (policy.dropOldStatusTicks && oldThreshold > 0) {
      const dropTicks = dropOldEventsOfKind(stream.events, 'status_tick', oldThreshold);
      stream.events = dropTicks.events;
      incRemoved('status_tick', dropTicks.dropped);
    }
    // Threat snapshot top-N truncation per frame
    for (const f of stream.frames) {
      if (f.threatSnapshot.length > policy.threatTopN) {
        const trimmed = sortedTopN(f.threatSnapshot, policy.threatTopN);
        // Mutate in place — frame is owned by stream
        (f as ReplayFrame).threatSnapshot = trimmed;
        framesThreatTruncated += 1;
      }
    }
  }

  // ── Lossless: dedupe identical RNG traces (per turn) ──
  const rngDedup = dedupeRngTraces(stream.events);
  stream.events = rngDedup.events;

  const afterEvents = stream.events.length;
  return {
    beforeEvents,
    afterEvents,
    estimatedBytesSaved: estimateBytes(beforeEvents - afterEvents),
    removedByKind,
    damageCoalesced: coalesceResult.coalesced,
    rngTracesDeduped: rngDedup.dropped,
    framesThreatTruncated,
    lossy: policy.lossy,
  };
}

// ─────────────────────────────────────────────────────────
// Lossless: coalesce damage events
// ─────────────────────────────────────────────────────────

/**
 * Coalesce damage events with same (turn, sourceId, targetId, skillId).
 * Result: one event with `amount = sum`, `occurrences = count`.
 * Order preserved (first occurrence's seq retained).
 */
function coalesceDamageEvents(events: readonly StreamEvent[]): {
  events: StreamEvent[];
  coalesced: number;
} {
  const out: StreamEvent[] = [];
  // groupKey → index in `out`
  const groupIdx = new Map<string, number>();
  let coalesced = 0;

  for (const ev of events) {
    if (ev.kind !== 'damage') {
      out.push(ev);
      continue;
    }
    const p = ev.payload;
    const source = String(p['sourceId'] ?? '');
    const target = String(p['targetId'] ?? '');
    const skill = String(p['skillId'] ?? '');
    const groupKey = `${ev.turn}::${source}::${target}::${skill}`;
    const prev = groupIdx.get(groupKey);
    if (prev !== undefined) {
      const existing = out[prev]!;
      const prevAmount = Number(existing.payload['amount'] ?? 0);
      const prevOcc = Number(existing.payload['occurrences'] ?? 1);
      const incomingAmount = Number(p['amount'] ?? 0);
      out[prev] = {
        ...existing,
        payload: {
          ...existing.payload,
          amount: prevAmount + incomingAmount,
          occurrences: prevOcc + 1,
        },
      };
      coalesced += 1;
    } else {
      groupIdx.set(groupKey, out.length);
      out.push(ev);
    }
  }
  return { events: out, coalesced };
}

// ─────────────────────────────────────────────────────────
// Lossless: drop noop status_tick events
// ─────────────────────────────────────────────────────────

function dropNoopStatusTicks(events: readonly StreamEvent[]): {
  events: StreamEvent[];
  dropped: number;
} {
  const out: StreamEvent[] = [];
  let dropped = 0;
  for (const ev of events) {
    if (ev.kind === 'status_tick' && ev.payload['noop'] === true) {
      dropped += 1;
      continue;
    }
    out.push(ev);
  }
  return { events: out, dropped };
}

// ─────────────────────────────────────────────────────────
// Lossy: drop old events of kind
// ─────────────────────────────────────────────────────────

function dropOldEventsOfKind(
  events: readonly StreamEvent[],
  kind: StreamEventKind,
  beforeTurn: number,
): { events: StreamEvent[]; dropped: number } {
  const out: StreamEvent[] = [];
  let dropped = 0;
  for (const ev of events) {
    if (ev.kind === kind && ev.turn < beforeTurn) {
      dropped += 1;
      continue;
    }
    out.push(ev);
  }
  return { events: out, dropped };
}

// ─────────────────────────────────────────────────────────
// Lossless: dedupe identical RNG traces per turn
// ─────────────────────────────────────────────────────────

function dedupeRngTraces(events: readonly StreamEvent[]): {
  events: StreamEvent[];
  dropped: number;
} {
  const out: StreamEvent[] = [];
  // (turn, sub, rollCount) → first seen
  const seen = new Set<string>();
  let dropped = 0;
  for (const ev of events) {
    if (ev.kind !== 'rng_consumed') {
      out.push(ev);
      continue;
    }
    const key = `${ev.turn}::${ev.payload['key']}::${ev.payload['rollCount']}`;
    if (seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    out.push(ev);
  }
  return { events: out, dropped };
}

// ─────────────────────────────────────────────────────────
// Lossy: top-N threat snapshot
// ─────────────────────────────────────────────────────────

interface ThreatLike { attackerId: string; threat: number }

function sortedTopN<T extends ThreatLike>(entries: readonly T[], n: number): T[] {
  if (entries.length <= n) return entries.slice();
  const copy = entries.slice();
  copy.sort((a, b) => {
    if (a.threat !== b.threat) return b.threat - a.threat;
    if (a.attackerId < b.attackerId) return -1;
    if (a.attackerId > b.attackerId) return 1;
    return 0;
  });
  return copy.slice(0, n);
}

// ─────────────────────────────────────────────────────────
// Byte estimate
// ─────────────────────────────────────────────────────────

/** Rough estimate — 96 bytes per StreamEvent in V8 (object header + payload Map). */
const EVENT_BYTE_ESTIMATE = 96;

function estimateBytes(eventCount: number): number {
  return Math.max(0, eventCount) * EVENT_BYTE_ESTIMATE;
}

// ─────────────────────────────────────────────────────────
// Memory pressure check — convenience helper
// ─────────────────────────────────────────────────────────

export interface StreamMemoryStats {
  totalEvents: number;
  totalFrames: number;
  totalThreatSnapshotEntries: number;
  estimatedBytes: number;
}

export function streamMemoryStats(stream: ReplayEventStream): StreamMemoryStats {
  let threatSnapshotEntries = 0;
  for (const f of stream.frames) threatSnapshotEntries += f.threatSnapshot.length;
  return {
    totalEvents: stream.events.length,
    totalFrames: stream.frames.length,
    totalThreatSnapshotEntries: threatSnapshotEntries,
    // Frames carry damageEvents + statusDeltas too — rough estimate
    estimatedBytes: stream.events.length * EVENT_BYTE_ESTIMATE
      + stream.frames.length * 256
      + threatSnapshotEntries * 48,
  };
}

/** Should we compact? — simple memory-pressure trigger. */
export function shouldCompact(
  stats: StreamMemoryStats,
  thresholdBytes: number = 256 * 1024,
): boolean {
  return stats.estimatedBytes > thresholdBytes;
}
