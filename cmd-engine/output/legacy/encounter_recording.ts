/**
 * ENCOUNTER RECORDING — orchestration glue between combat engine and replay stream (Phase 6).
 *
 * Caller (encounter_manager) holds 1 EncounterRecorder per active encounter.
 * Per-turn flow:
 *
 *   1. recorder.beginTurn(turn)        — start new frame builder
 *   2. (combat engine emits via record* helpers throughout turn)
 *   3. recorder.endTurn()              — finalize frame + append to stream
 *
 * The recorder owns no game state — it only mirrors decisions / events into the
 * replay stream + frame log. Pure forwarding layer.
 *
 * Replay-safe: every record* helper is deterministic + side-effect-free except
 * for stream append.
 */
import type { BossDecision } from '../../../cmd-boss/output/legacy/boss_ai_runtime.js';
import type { PendingMechanic } from './mechanic_scheduler.js';
import type {
  ReplayFrame,
  ReplayFrameBuilder,
  BossDecisionRecord,
  StatusDeltaRecord,
  DamageEventRecord,
  ThreatSnapshotEntry,
  RngTrace,
} from './replay_frame.js';
import { newFrameBuilder, finalizeFrame } from './replay_frame.js';
import type { ReplayEventStream, StreamEventKind } from './replay_event_stream.js';
import { appendEvent, appendFrame } from './replay_event_stream.js';

// ─────────────────────────────────────────────────────────
// Recorder state
// ─────────────────────────────────────────────────────────

export interface EncounterRecorder {
  sessionId: string;
  encounterId: string;
  stream: ReplayEventStream;
  /** Current frame builder — null when no active turn. */
  current?: ReplayFrameBuilder;
}

export function createRecorder(stream: ReplayEventStream): EncounterRecorder {
  return {
    sessionId: stream.sessionId,
    encounterId: stream.encounterId,
    stream,
  };
}

// ─────────────────────────────────────────────────────────
// Turn boundary
// ─────────────────────────────────────────────────────────

export function beginTurn(rec: EncounterRecorder, turn: number): void {
  if (rec.current) {
    throw new Error(`[EncounterRecorder] beginTurn called with active builder turn=${rec.current.turn}`);
  }
  rec.current = newFrameBuilder(rec.sessionId, rec.encounterId, turn);
}

export function endTurn(rec: EncounterRecorder): ReplayFrame {
  if (!rec.current) {
    throw new Error(`[EncounterRecorder] endTurn called without active builder`);
  }
  const frame = finalizeFrame(rec.current);
  appendFrame(rec.stream, frame);
  rec.current = undefined;
  return frame;
}

// ─────────────────────────────────────────────────────────
// Record helpers — caller invokes during turn
// ─────────────────────────────────────────────────────────

export function recordBossDecision(rec: EncounterRecorder, decision: BossDecision): void {
  if (!rec.current) return;
  const record: BossDecisionRecord = {
    branch: decision.branch,
    targetId: decision.targetId,
    skillId: decision.skillId,
    policyVia: decision.policyVia,
    phaseTransitioned: decision.phaseTransitioned,
    currentPhaseId: decision.currentPhaseId,
    scheduledMechanicIds: decision.scheduledMechanics.map((m: PendingMechanic) => m.mechanicId),
    resolvedMechanicIds: decision.resolvedMechanics.map((m: PendingMechanic) => m.mechanicId),
  };
  rec.current.bossDecision = record;
  appendEvent(rec.stream, rec.current.turn, 'boss_decision', {
    branch: record.branch,
    targetId: record.targetId,
    skillId: record.skillId,
    policyVia: record.policyVia,
    currentPhaseId: record.currentPhaseId,
  });
  if (decision.phaseTransitioned) {
    appendEvent(rec.stream, rec.current.turn, 'phase_transition', {
      currentPhaseId: record.currentPhaseId,
    });
  }
  for (const m of decision.scheduledMechanics) {
    appendEvent(rec.stream, rec.current.turn, 'mechanic_scheduled', {
      mechanicId: m.mechanicId,
      resolveTurn: m.resolveTurn,
      telegraphed: m.telegraphed,
    });
  }
  for (const m of decision.resolvedMechanics) {
    appendEvent(rec.stream, rec.current.turn, 'mechanic_resolved', {
      mechanicId: m.mechanicId,
      scheduledAtTurn: m.scheduledAtTurn,
    });
  }
}

export function recordStatusDelta(rec: EncounterRecorder, delta: StatusDeltaRecord): void {
  if (!rec.current) return;
  rec.current.statusDeltas.push(delta);
  const kind: StreamEventKind =
    delta.kind === 'applied' ? 'status_apply' :
    delta.kind === 'removed' ? 'status_remove' :
    delta.kind === 'tick' ? 'status_tick' :
    'status_apply';
  appendEvent(rec.stream, rec.current.turn, kind, { ...delta });
}

export function recordDamageEvent(rec: EncounterRecorder, ev: DamageEventRecord): void {
  if (!rec.current) return;
  rec.current.damageEvents.push(ev);
  const kind: StreamEventKind = ev.kind === 'heal' ? 'heal' : 'damage';
  appendEvent(rec.stream, rec.current.turn, kind, { ...ev });
}

export function recordSkillCast(
  rec: EncounterRecorder,
  sourceId: string,
  targetId: string,
  skillId: string,
): void {
  if (!rec.current) return;
  appendEvent(rec.stream, rec.current.turn, 'skill_cast', { sourceId, targetId, skillId });
}

export function recordThreatSnapshot(
  rec: EncounterRecorder,
  entries: readonly ThreatSnapshotEntry[],
): void {
  if (!rec.current) return;
  rec.current.threatSnapshot = [...entries];
}

export function recordRngTrace(rec: EncounterRecorder, trace: RngTrace): void {
  if (!rec.current) return;
  const existing = rec.current.rngTraces.find((t) => t.key === trace.key);
  if (existing) {
    existing.rollCount = trace.rollCount;
  } else {
    rec.current.rngTraces.push({ ...trace });
  }
}

// ─────────────────────────────────────────────────────────
// Custom event passthrough
// ─────────────────────────────────────────────────────────

export function recordCustomEvent(
  rec: EncounterRecorder,
  kind: StreamEventKind,
  payload: Readonly<Record<string, unknown>>,
): void {
  if (!rec.current) return;
  appendEvent(rec.stream, rec.current.turn, kind, payload);
}
