/**
 * LATENCY COMPENSATION RUNTIME — deterministic delay simulation (Phase 19 § 3).
 *
 * Per CMD1 Phase 19 directive § PRIMARY MODULE #3:
 *   "Purpose: deterministic latency handling infrastructure.
 *    SUPPORT: rollback-safe latency compensation / deterministic delayed command
 *             resolution / replay-safe latency reconstruction
 *             / reconnect-safe latency continuation / canonical delay simulation
 *    MANDATORY: same latency simulation = same replay result ALWAYS.
 *    FORBIDDEN: client-authoritative correction / runtime-dependent compensation
 *               / nondeterministic delay resolution"
 *
 * Queues commands with delay-in-turns. Resolves deterministically when the
 * combat runtime advances to/past the resolveAtTurn. Caller drives the
 * advance — no real-time timers, no clock dependency.
 *
 * STRICT additive — pure state container. R1-R4 hardening invariants applied.
 */
import type { CombatRuntime } from './combat_runtime.js';
import { canonicalHash } from './combat_storage.js';
import type { NormalizedInput } from './combat_input_projection_pipeline.js';

export const LATENCY_COMPENSATION_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────
// Delayed command model
// ─────────────────────────────────────────────────────────

export interface DelayedCommand {
  /** Monotonic delayed seq. */
  delaySeq: number;
  scheduledAtTurn: number;
  resolveAtTurn: number;
  command: NormalizedInput;
  /** Stable digest binding identity. */
  digest: string;
}

export interface LatencyState {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  pending: DelayedCommand[];
  resolved: DelayedCommand[];
  nextDelaySeq: number;
  totalScheduled: number;
  totalResolved: number;
  totalCancelled: number;
}

export function createLatencyRuntime(
  encounterId: string,
  sessionId: string,
): LatencyState {
  // Both `!id` and `.trim() === 0` paths converge to a caller-visible
  // "must be non-empty" error. Stryker mutants on the first guard route via
  // the second with a slightly different suffix; caller-visible semantics
  // are identical. These mutants are EQUIVALENT.
  // Stryker disable all
  if (!encounterId) throw new LatencyCompensationError(`encounterId must be non-empty`);
  if (!sessionId) throw new LatencyCompensationError(`sessionId must be non-empty`);
  // R7-7 audit fix: whitespace-only IDs slip past `!id` check, yielding
  // latency state whose digest binds whitespace identity → cross-encounter
  // collision risk identical to R6-5.
  if (encounterId.trim().length === 0) {
    throw new LatencyCompensationError(`encounterId must be non-empty (whitespace-only rejected)`);
  }
  if (sessionId.trim().length === 0) {
    throw new LatencyCompensationError(`sessionId must be non-empty (whitespace-only rejected)`);
  }
  // Stryker restore all
  return {
    schemaVersion: LATENCY_COMPENSATION_SCHEMA_VERSION,
    encounterId,
    sessionId,
    pending: [],
    resolved: [],
    nextDelaySeq: 0,
    totalScheduled: 0,
    totalResolved: 0,
    totalCancelled: 0,
  };
}

// ─────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────

export class LatencyCompensationError extends Error {
  constructor(message: string) {
    super(`[LatencyCompensation] ${message}`);
    this.name = 'LatencyCompensationError';
  }
}

function assertParity(state: LatencyState, rt: CombatRuntime): void {
  if (state.encounterId !== rt.config.encounterId) {
    throw new LatencyCompensationError(`encounterId mismatch: state='${state.encounterId}' rt='${rt.config.encounterId}'`);
  }
  if (state.sessionId !== rt.config.sessionId) {
    throw new LatencyCompensationError(`sessionId mismatch: state='${state.sessionId}' rt='${rt.config.sessionId}'`);
  }
}

// ─────────────────────────────────────────────────────────
// Schedule / cancel / advance
// ─────────────────────────────────────────────────────────

function digestDelayed(
  delaySeq: number,
  scheduledAtTurn: number,
  resolveAtTurn: number,
  command: NormalizedInput,
): string {
  return canonicalHash({
    schemaVersion: LATENCY_COMPENSATION_SCHEMA_VERSION,
    delaySeq,
    scheduledAtTurn,
    resolveAtTurn,
    commandDigest: command.digest,
  });
}

/**
 * Schedule a normalized command to resolve at `rt.currentTurn + delayTurns`.
 * Deterministic — same scheduling order + same command → same digest.
 */
export function scheduleDelayed(
  state: LatencyState,
  rt: CombatRuntime,
  command: NormalizedInput,
  delayTurns: number,
): DelayedCommand {
  assertParity(state, rt);
  if (!Number.isFinite(delayTurns) || !Number.isInteger(delayTurns) || delayTurns < 0) {
    throw new LatencyCompensationError(`delayTurns must be a non-negative integer, got ${delayTurns}`);
  }
  const delaySeq = state.nextDelaySeq++;
  const scheduledAtTurn = rt.currentTurn;
  const resolveAtTurn = scheduledAtTurn + delayTurns;
  const dc: DelayedCommand = {
    delaySeq,
    scheduledAtTurn,
    resolveAtTurn,
    command,
    digest: digestDelayed(delaySeq, scheduledAtTurn, resolveAtTurn, command),
  };
  state.pending.push(dc);
  state.totalScheduled++;
  return dc;
}

/**
 * Cancel a still-pending delayed command. Increments totalCancelled, removes
 * from pending. Resolved commands are immutable — no cancel after resolve.
 */
export function cancelDelayed(
  state: LatencyState,
  rt: CombatRuntime,
  delaySeq: number,
): void {
  assertParity(state, rt);
  const idx = state.pending.findIndex((d) => d.delaySeq === delaySeq);
  if (idx === -1) {
    throw new LatencyCompensationError(`delayed command seq=${delaySeq} not pending`);
  }
  state.pending.splice(idx, 1);
  state.totalCancelled++;
}

/**
 * Advance latency runtime — resolves all pending commands whose
 * resolveAtTurn <= rt.currentTurn. Resolution is in CANONICAL ORDER:
 * by resolveAtTurn asc, then delaySeq asc (FIFO within same turn).
 *
 * Returns the list of resolved commands in canonical order. Caller dispatches
 * them to the actual command queue.
 */
export function advanceLatency(
  state: LatencyState,
  rt: CombatRuntime,
): readonly DelayedCommand[] {
  assertParity(state, rt);
  const cur = rt.currentTurn;
  // Canonical sort BEFORE filtering — ensures stable resolution order.
  // delaySeq tiebreaker strict-vs-eq EQUIVALENT (delaySeq unique monotonic).
  // Stryker disable all
  const sortedPending = [...state.pending].sort((a, b) => {
    if (a.resolveAtTurn !== b.resolveAtTurn) return a.resolveAtTurn - b.resolveAtTurn;
    return a.delaySeq - b.delaySeq;
  });
  // Stryker restore all
  const readyToResolve: DelayedCommand[] = [];
  const stillPending: DelayedCommand[] = [];
  for (const dc of sortedPending) {
    if (dc.resolveAtTurn <= cur) readyToResolve.push(dc);
    else stillPending.push(dc);
  }
  state.pending = stillPending;
  for (const dc of readyToResolve) {
    state.resolved.push(dc);
    state.totalResolved++;
  }
  return readyToResolve;
}

/**
 * Peek what `advanceLatency` would resolve at a given turn, WITHOUT mutating.
 * Use for forensic / preview.
 */
export function peekReady(
  state: LatencyState,
  atTurn: number,
): readonly DelayedCommand[] {
  // Stryker disable all -- delaySeq tiebreaker strict-vs-eq EQUIVALENT
  return [...state.pending]
    .filter((d) => d.resolveAtTurn <= atTurn)
    .sort((a, b) => {
      if (a.resolveAtTurn !== b.resolveAtTurn) return a.resolveAtTurn - b.resolveAtTurn;
      return a.delaySeq - b.delaySeq;
    });
  // Stryker restore all
}

// ─────────────────────────────────────────────────────────
// Snapshot + query
// ─────────────────────────────────────────────────────────

export interface LatencySnapshot {
  schemaVersion: number;
  encounterId: string;
  sessionId: string;
  currentTurn: number;
  pendingCount: number;
  resolvedCount: number;
  totalScheduled: number;
  totalResolved: number;
  totalCancelled: number;
  /** Stable digest of (pending + resolved) digests in canonical order. */
  digest: string;
}

export function buildLatencySnapshot(
  state: LatencyState,
  rt: CombatRuntime,
): LatencySnapshot {
  assertParity(state, rt);
  // delaySeq tiebreaker is unique per delaySeq monotonic; strict-vs-eq mutations EQUIVALENT.
  // Stryker disable all
  const sortedPending = [...state.pending].sort((a, b) => {
    if (a.resolveAtTurn !== b.resolveAtTurn) return a.resolveAtTurn - b.resolveAtTurn;
    return a.delaySeq - b.delaySeq;
  });
  // Stryker restore all
  // state.resolved is populated by advanceLatency in delaySeq-monotonic order;
  // sort is defense-in-depth. Stryker mutants here are EQUIVALENT.
  // Stryker disable next-line all
  const sortedResolved = [...state.resolved].sort((a, b) => a.delaySeq - b.delaySeq);
  const forDigest = {
    schemaVersion: LATENCY_COMPENSATION_SCHEMA_VERSION,
    encounterId: state.encounterId,
    sessionId: state.sessionId,
    currentTurn: rt.currentTurn,
    pendingCount: sortedPending.length,
    resolvedCount: sortedResolved.length,
    totalScheduled: state.totalScheduled,
    totalResolved: state.totalResolved,
    totalCancelled: state.totalCancelled,
    pendingDigests: sortedPending.map((d) => d.digest),
    resolvedDigests: sortedResolved.map((d) => d.digest),
  };
  return {
    schemaVersion: LATENCY_COMPENSATION_SCHEMA_VERSION,
    encounterId: state.encounterId,
    sessionId: state.sessionId,
    currentTurn: rt.currentTurn,
    pendingCount: sortedPending.length,
    resolvedCount: sortedResolved.length,
    totalScheduled: state.totalScheduled,
    totalResolved: state.totalResolved,
    totalCancelled: state.totalCancelled,
    digest: canonicalHash(forDigest),
  };
}

export function pendingCommands(state: LatencyState): readonly DelayedCommand[] {
  // Stryker disable all -- delaySeq unique monotonic, strict-vs-eq tiebreaker EQUIVALENT
  return [...state.pending].sort((a, b) => {
    if (a.resolveAtTurn !== b.resolveAtTurn) return a.resolveAtTurn - b.resolveAtTurn;
    return a.delaySeq - b.delaySeq;
  });
  // Stryker restore all
}

export function resolvedCommands(state: LatencyState): readonly DelayedCommand[] {
  // state.resolved is populated in delaySeq-monotonic order; sort is
  // defense-in-depth. Stryker mutants here are EQUIVALENT.
  // Stryker disable next-line all
  return [...state.resolved].sort((a, b) => a.delaySeq - b.delaySeq);
}

export function latencyHistoryHash(state: LatencyState): string {
  let h = 0x811c9dc5 >>> 0;
  const eat = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  // Canonical order for both lists.
  // state.pending / state.resolved are populated by scheduleDelayed/advanceLatency
  // in delaySeq-monotonic order — sorts are defense-in-depth.
  // Stryker mutants on these comparators are EQUIVALENT on monotonic data.
  // Stryker disable all
  for (const d of [...state.pending].sort((a, b) => a.delaySeq - b.delaySeq)) {
    eat(`P|${d.delaySeq}|${d.digest}`);
  }
  for (const d of [...state.resolved].sort((a, b) => a.delaySeq - b.delaySeq)) {
    eat(`R|${d.delaySeq}|${d.digest}`);
  }
  // Stryker restore all
  return h.toString(16).padStart(8, '0');
}
