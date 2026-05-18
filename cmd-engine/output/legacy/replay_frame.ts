/**
 * REPLAY FRAME — per-turn replay record schema (Phase 6).
 *
 * One ReplayFrame per turn captures the deterministic state envelope needed to
 * audit / rewind / verify combat:
 *
 *   - frameId         (stable: encounterId + turn + sessionCounter)
 *   - turn
 *   - sessionId       (CMD1 FIX #3 — includes session counter)
 *   - bossPhase       (active phase id + transition this turn?)
 *   - bossDecision    (branch, target, skill, mechanics — from boss_ai_runtime)
 *   - statusDeltas    (status applied/removed this turn)
 *   - damageEvents    (skill cast outcomes)
 *   - threatSnapshot  (sortedByThreat top-N entries — bounded for size)
 *   - rngTrace        (substream consumption count — for audit)
 *
 * Replay invariant: SAME seed + SAME script version + SAME inputs →
 * IDENTICAL frame sequence. Verified by replay_aggregation_invariant tests.
 *
 * Schema versioned via REPLAY_FRAME_SCHEMA_VERSION (FIX #10 sibling).
 */
import { z } from 'zod';

export const REPLAY_FRAME_SCHEMA_VERSION = 1 as const;

// ─────────────────────────────────────────────────────────
// Sub-schemas
// ─────────────────────────────────────────────────────────

export const BossDecisionRecordSchema = z.object({
  branch: z.enum(['highest_threat', 'scripted_mechanic', 'random_eligible']),
  targetId: z.string().optional(),
  skillId: z.string().optional(),
  policyVia: z.string().optional(),
  phaseTransitioned: z.boolean(),
  currentPhaseId: z.string(),
  scheduledMechanicIds: z.array(z.string()).default([]),
  resolvedMechanicIds: z.array(z.string()).default([]),
});
export type BossDecisionRecord = z.infer<typeof BossDecisionRecordSchema>;

export const StatusDeltaRecordSchema = z.object({
  kind: z.enum(['applied', 'removed', 'tick', 'resisted', 'immune']),
  statusId: z.string(),
  targetId: z.string(),
  sourceId: z.string().optional(),
  stacks: z.number().int().nonnegative().optional(),
});
export type StatusDeltaRecord = z.infer<typeof StatusDeltaRecordSchema>;

export const DamageEventRecordSchema = z.object({
  kind: z.enum(['damage', 'heal', 'shield']),
  sourceId: z.string(),
  targetId: z.string(),
  skillId: z.string().optional(),
  amount: z.number().int(),
  crit: z.boolean().optional(),
  blocked: z.number().int().nonnegative().optional(),
});
export type DamageEventRecord = z.infer<typeof DamageEventRecordSchema>;

export const ThreatSnapshotEntrySchema = z.object({
  attackerId: z.string(),
  threat: z.number().int().nonnegative(),
});
export type ThreatSnapshotEntry = z.infer<typeof ThreatSnapshotEntrySchema>;

export const RngTraceSchema = z.object({
  /** Substream key. */
  key: z.string(),
  /** Total rolls consumed by this turn. */
  rollCount: z.number().int().nonnegative(),
});
export type RngTrace = z.infer<typeof RngTraceSchema>;

// ─────────────────────────────────────────────────────────
// ReplayFrame
// ─────────────────────────────────────────────────────────

export const ReplayFrameSchema = z.object({
  /** Stable frame id: `${sessionId}@f${turn}`. */
  frameId: z.string().min(1).max(128),
  schemaVersion: z.number().int().positive(),
  sessionId: z.string().min(1),
  encounterId: z.string().min(1),
  turn: z.number().int().nonnegative(),
  /** Boss AI decision this turn (optional — non-boss encounter has no boss decision). */
  bossDecision: BossDecisionRecordSchema.optional(),
  /** Status applies/removes ordered by emit sequence. */
  statusDeltas: z.array(StatusDeltaRecordSchema).default([]),
  /** Damage / heal / shield events. */
  damageEvents: z.array(DamageEventRecordSchema).default([]),
  /** Top-N threat snapshot (for audit). */
  threatSnapshot: z.array(ThreatSnapshotEntrySchema).default([]),
  /** RNG substream trace. */
  rngTraces: z.array(RngTraceSchema).default([]),
  /** Telemetry-only checksum (for fuzz/replay-divergence detection). */
  checksum: z.string().optional(),
});
export type ReplayFrame = z.infer<typeof ReplayFrameSchema>;

// ─────────────────────────────────────────────────────────
// Frame builder
// ─────────────────────────────────────────────────────────

export function makeFrameId(sessionId: string, turn: number): string {
  return `${sessionId}@f${turn}`;
}

export interface ReplayFrameBuilder {
  sessionId: string;
  encounterId: string;
  turn: number;
  bossDecision?: BossDecisionRecord;
  statusDeltas: StatusDeltaRecord[];
  damageEvents: DamageEventRecord[];
  threatSnapshot: ThreatSnapshotEntry[];
  rngTraces: RngTrace[];
}

export function newFrameBuilder(sessionId: string, encounterId: string, turn: number): ReplayFrameBuilder {
  return {
    sessionId,
    encounterId,
    turn,
    statusDeltas: [],
    damageEvents: [],
    threatSnapshot: [],
    rngTraces: [],
  };
}

export function finalizeFrame(b: ReplayFrameBuilder): ReplayFrame {
  return {
    frameId: makeFrameId(b.sessionId, b.turn),
    schemaVersion: REPLAY_FRAME_SCHEMA_VERSION,
    sessionId: b.sessionId,
    encounterId: b.encounterId,
    turn: b.turn,
    bossDecision: b.bossDecision,
    statusDeltas: [...b.statusDeltas],
    damageEvents: [...b.damageEvents],
    threatSnapshot: [...b.threatSnapshot],
    rngTraces: [...b.rngTraces],
    checksum: computeFrameChecksum(b),
  };
}

/**
 * Cheap deterministic checksum — replay divergence detector.
 * NOT cryptographic. Sufficient for frame-level audit.
 */
export function computeFrameChecksum(b: ReplayFrameBuilder): string {
  // FNV-1a 32-bit over canonical string serialization.
  // Stable: arrays serialized in input order (caller must push in event emit order).
  const parts: string[] = [
    `s=${b.sessionId}`,
    `t=${b.turn}`,
  ];
  if (b.bossDecision) {
    parts.push(
      `bd=${b.bossDecision.branch}|${b.bossDecision.targetId ?? '-'}|${b.bossDecision.skillId ?? '-'}|${b.bossDecision.currentPhaseId}|${b.bossDecision.phaseTransitioned ? 1 : 0}`,
    );
  }
  for (const s of b.statusDeltas) parts.push(`sd=${s.kind}|${s.statusId}|${s.targetId}`);
  for (const d of b.damageEvents) parts.push(`de=${d.kind}|${d.sourceId}|${d.targetId}|${d.amount}`);
  for (const th of b.threatSnapshot) parts.push(`th=${th.attackerId}|${th.threat}`);
  for (const r of b.rngTraces) parts.push(`rt=${r.key}|${r.rollCount}`);
  return fnv1a32(parts.join(';'));
}

function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
