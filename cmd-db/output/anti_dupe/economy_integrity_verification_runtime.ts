/**
 * ECONOMY INTEGRITY VERIFICATION RUNTIME — Phase 15 #1.
 *
 * Continuous deterministic economy verification runtime.
 *
 * STRICT SCOPE (v18 Phase 15 spec):
 *   - SUPPORT: replay-safe economy verification / persistence parity / reconnect-safe snapshot /
 *     deterministic restore verification / replay continuation validation
 *   - MANDATORY: same economy state = same verification result ALWAYS
 *   - VERIFICATION layer ONLY — không build runtime mới
 *
 * Pattern:
 *   - Receive inputs (snapshots, lifecycle log) + frozen economy state references
 *   - Run verification checks → return VerificationReport (frozen, deterministic content_hash)
 *   - Telemetry log separate from verification result (never affects content_hash)
 *
 * Lock policy:
 *   - economy/* + economy_integration/* FROZEN — wrap, không modify
 *   - Use existing helpers: persistence_runtime_bridge, snapshot_exporter, fnv1a32, canonicalJSON
 */
import type {
  EconomyPersistenceRuntimeBridge,
  PersistenceLifecycleEntry,
} from './economy_persistence_runtime_bridge.js';
import type { InventorySnapshot } from '../economy/inventory_snapshot_schema.js';
import { serializeInventorySnapshot, canonicalJSON } from '../economy/economy_serialization_contract.js';
import { fnv1a32 } from '../economy/modifier_ordering_audit.js';

export const ECONOMY_INTEGRITY_VERIFICATION_VERSION = 1;

// ───────── Verification kinds ─────────
export const INTEGRITY_CHECK_KINDS = [
  'persistence_parity',           // save+load yields byte-identical snapshot
  'reconnect_restore_parity',     // restore after reconnect = original
  'snapshot_canonical_stability', // re-serialize 10x → 1 hash
  'replay_continuation_chain',    // checkpoint A → checkpoint B → restore B = same as A+B
  'lifecycle_hash_consistency',   // lifecycle log hashes deterministic
] as const;
export type IntegrityCheckKind = (typeof INTEGRITY_CHECK_KINDS)[number];

// ───────── Single check result ─────────
export interface IntegrityCheckResult {
  kind: IntegrityCheckKind;
  passed: boolean;
  /** Reason if fail (empty if pass). */
  reason: string;
  /** Player scope (null = system-wide). */
  player_id: string | null;
  /** Tick of verification. */
  tick: number;
  /** Deterministic evidence hash. */
  evidence_hash: string;
}

// ───────── Verification report ─────────
export interface IntegrityVerificationReport {
  verification_version: number;
  tick: number;
  checks: readonly IntegrityCheckResult[];
  passed_count: number;
  failed_count: number;
  overall: 'pass' | 'fail';
  /** Deterministic content hash (FNV-1a). */
  content_hash: string;
}

// ───────── Runtime contract ─────────
export interface EconomyIntegrityVerificationRuntime {
  /** Run a single integrity check. */
  runCheck(kind: IntegrityCheckKind, params: VerificationParams): IntegrityCheckResult;

  /** Run all check kinds + aggregate to report. */
  runAll(params: VerificationParams): IntegrityVerificationReport;

  /**
   * Verify replay continuation: state at tick T1 + apply ops → state at T2.
   * Then save/restore T1 → re-apply ops → must match T2 byte-identical.
   */
  verifyReplayContinuation(input: ReplayContinuationInput): IntegrityCheckResult;

  /** Audit log (frozen snapshot). */
  readonly auditLog: readonly IntegrityVerificationReport[];
  clearAuditLog(): void;
}

export interface VerificationParams {
  bridge: EconomyPersistenceRuntimeBridge;
  snapshot: InventorySnapshot;
  tick: number;
}

export interface ReplayContinuationInput {
  bridge: EconomyPersistenceRuntimeBridge;
  initial_snapshot: InventorySnapshot;
  apply_op: (snap: InventorySnapshot) => InventorySnapshot;  // pure transform
  tick_start: number;
  tick_end: number;
}

// ───────── Utility ─────────
function cmpStr(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function validateTick(tick: number): void {
  if (!Number.isInteger(tick) || tick < 0) {
    throw new Error(`[EconomyIntegrityVerificationRuntime] tick must be non-negative integer (got ${tick})`);
  }
}

function makeCheckResult(
  kind: IntegrityCheckKind,
  passed: boolean,
  reason: string,
  player_id: string | null,
  tick: number,
  evidence: unknown,
): IntegrityCheckResult {
  return Object.freeze({
    kind,
    passed,
    reason: passed ? '' : reason,
    player_id,
    tick,
    evidence_hash: fnv1a32(canonicalJSON(evidence)),
  });
}

// ───────── Shared replay-continuation core (used by runReplayContinuationChain
// stub via identity op AND by verifyReplayContinuation public method) ─────────
function doReplayContinuation(input: ReplayContinuationInput): IntegrityCheckResult {
  validateTick(input.tick_start);
  validateTick(input.tick_end);
  if (input.tick_end <= input.tick_start) {
    throw new Error(`[EconomyIntegrityVerificationRuntime] tick_end must > tick_start`);
  }
  try {
    // Chain A: save initial → apply op locally (do NOT save evolved — would clobber
    // adapter latest pointer and break Chain B restore).
    input.bridge.saveInventory(input.initial_snapshot, input.tick_start);
    const evolvedA = input.apply_op(input.initial_snapshot);
    const expectedHash = fnv1a32(serializeInventorySnapshot(evolvedA));

    // Chain B: restore initial from save → re-apply op → compare.
    const restored = input.bridge.restoreOnReconnect(
      input.initial_snapshot.player_id, input.tick_start + 1,
    );
    if (!restored.snapshot) {
      return makeCheckResult('replay_continuation_chain', false,
        'cannot restore initial', input.initial_snapshot.player_id, input.tick_end,
        { phase: 'restore_initial' });
    }
    const evolvedB = input.apply_op(restored.snapshot);
    const actualHash = fnv1a32(serializeInventorySnapshot(evolvedB));

    const ok = expectedHash === actualHash;
    return makeCheckResult('replay_continuation_chain', ok,
      ok ? '' : 'replay chain hash drift',
      input.initial_snapshot.player_id, input.tick_end,
      { expectedHash, actualHash });
  } catch (e) {
    return makeCheckResult('replay_continuation_chain', false, `threw: ${(e as Error).message}`,
      input.initial_snapshot.player_id, input.tick_end, { error: true });
  }
}

// ───────── Factory ─────────
export function createEconomyIntegrityVerificationRuntime(): EconomyIntegrityVerificationRuntime {
  const auditLog: IntegrityVerificationReport[] = [];

  function runPersistenceParity(p: VerificationParams): IntegrityCheckResult {
    try {
      p.bridge.saveInventory(p.snapshot, p.tick);
      const loaded = p.bridge.loadInventory(p.snapshot.player_id, p.tick);
      if (!loaded.snapshot) {
        return makeCheckResult('persistence_parity', false, 'loaded snapshot null',
          p.snapshot.player_id, p.tick, { reason: 'null_load' });
      }
      const expected = serializeInventorySnapshot(p.snapshot);
      const actual = serializeInventorySnapshot(loaded.snapshot);
      const ok = expected === actual;
      return makeCheckResult('persistence_parity', ok,
        ok ? '' : 'save/load byte mismatch',
        p.snapshot.player_id, p.tick,
        { expected_hash: fnv1a32(expected), actual_hash: fnv1a32(actual) });
    } catch (e) {
      return makeCheckResult('persistence_parity', false, `threw: ${(e as Error).message}`,
        p.snapshot.player_id, p.tick, { error: true });
    }
  }

  function runReconnectRestoreParity(p: VerificationParams): IntegrityCheckResult {
    try {
      p.bridge.saveInventory(p.snapshot, p.tick);
      const restored = p.bridge.restoreOnReconnect(p.snapshot.player_id, p.tick + 100);
      if (!restored.snapshot) {
        return makeCheckResult('reconnect_restore_parity', false, 'restored snapshot null',
          p.snapshot.player_id, p.tick, { reason: 'null_restore' });
      }
      const expected = serializeInventorySnapshot(p.snapshot);
      const actual = serializeInventorySnapshot(restored.snapshot);
      const ok = expected === actual;
      return makeCheckResult('reconnect_restore_parity', ok,
        ok ? '' : 'reconnect byte mismatch',
        p.snapshot.player_id, p.tick,
        { lifecycle_status: restored.lifecycle.status });
    } catch (e) {
      return makeCheckResult('reconnect_restore_parity', false, `threw: ${(e as Error).message}`,
        p.snapshot.player_id, p.tick, { error: true });
    }
  }

  function runSnapshotCanonicalStability(p: VerificationParams): IntegrityCheckResult {
    try {
      const baseline = serializeInventorySnapshot(p.snapshot);
      for (let i = 0; i < 10; i++) {
        const re = serializeInventorySnapshot(p.snapshot);
        if (re !== baseline) {
          return makeCheckResult('snapshot_canonical_stability', false,
            `drift at iteration ${i}`, p.snapshot.player_id, p.tick,
            { iter: i });
        }
      }
      return makeCheckResult('snapshot_canonical_stability', true, '',
        p.snapshot.player_id, p.tick, { hash: fnv1a32(baseline) });
    } catch (e) {
      return makeCheckResult('snapshot_canonical_stability', false, `threw: ${(e as Error).message}`,
        p.snapshot.player_id, p.tick, { error: true });
    }
  }

  function runLifecycleHashConsistency(p: VerificationParams): IntegrityCheckResult {
    try {
      // Snapshot lifecycle log state, then write+read, then verify subsequent calls hash deterministically.
      p.bridge.saveInventory(p.snapshot, p.tick);
      const log1 = [...p.bridge.lifecycleLog].map(e => e.content_hash);
      // Re-save same → should be idempotent record_id, push 1 more lifecycle entry.
      p.bridge.saveInventory(p.snapshot, p.tick);
      const log2 = [...p.bridge.lifecycleLog].map(e => e.content_hash);
      // Latest 2 save entries should have IDENTICAL content_hash (same snapshot).
      const latest1 = log1[log1.length - 1];
      const latest2 = log2[log2.length - 1];
      const ok = latest1 === latest2;
      return makeCheckResult('lifecycle_hash_consistency', ok,
        ok ? '' : 'lifecycle hash drift on idempotent save',
        p.snapshot.player_id, p.tick,
        { latest1, latest2 });
    } catch (e) {
      return makeCheckResult('lifecycle_hash_consistency', false, `threw: ${(e as Error).message}`,
        p.snapshot.player_id, p.tick, { error: true });
    }
  }

  function runReplayContinuationChain(p: VerificationParams): IntegrityCheckResult {
    // B#3 fix: was a near-duplicate of persistence_parity (save + load + compare).
    // Now exercises the actual replay continuation chain using doReplayContinuation
    // with an identity apply_op. Caller wanting non-trivial op uses verifyReplayContinuation.
    return doReplayContinuation({
      bridge: p.bridge,
      initial_snapshot: p.snapshot,
      apply_op: (s) => s,  // identity — minimal replay-continuation smoke
      tick_start: p.tick,
      tick_end: p.tick + 1,
    });
  }

  function dispatchCheck(kind: IntegrityCheckKind, params: VerificationParams): IntegrityCheckResult {
    switch (kind) {
      case 'persistence_parity': return runPersistenceParity(params);
      case 'reconnect_restore_parity': return runReconnectRestoreParity(params);
      case 'snapshot_canonical_stability': return runSnapshotCanonicalStability(params);
      case 'lifecycle_hash_consistency': return runLifecycleHashConsistency(params);
      case 'replay_continuation_chain': return runReplayContinuationChain(params);
    }
  }

  return {
    runCheck(kind, params) {
      validateTick(params.tick);
      if (!INTEGRITY_CHECK_KINDS.includes(kind)) {
        throw new Error(`[EconomyIntegrityVerificationRuntime] invalid check kind: ${kind}`);
      }
      return dispatchCheck(kind, params);
    },

    runAll(params) {
      validateTick(params.tick);
      const results: IntegrityCheckResult[] = [];
      for (const kind of INTEGRITY_CHECK_KINDS) {
        results.push(dispatchCheck(kind, params));
      }
      // Sort by kind codepoint for canonical order.
      const sorted = Object.freeze(
        [...results]
          .sort((a, b) => cmpStr(a.kind, b.kind)),
      );
      const passed_count = sorted.filter(r => r.passed).length;
      const failed_count = sorted.length - passed_count;
      const overall: 'pass' | 'fail' = failed_count === 0 ? 'pass' : 'fail';

      const core = {
        verification_version: ECONOMY_INTEGRITY_VERIFICATION_VERSION,
        tick: params.tick,
        checks: sorted,
        passed_count,
        failed_count,
        overall,
      };
      const content_hash = fnv1a32(canonicalJSON(core as unknown));

      const report: IntegrityVerificationReport = Object.freeze({
        ...core, content_hash,
      });
      auditLog.push(report);
      return report;
    },

    verifyReplayContinuation(input) {
      // B#3 fix: delegate to shared doReplayContinuation core — single
      // source of truth for chain A vs chain B byte parity logic.
      return doReplayContinuation(input);
    },

    get auditLog() {
      return Object.freeze([...auditLog]);
    },

    clearAuditLog() {
      auditLog.length = 0;
    },
  };
}

// Re-export
export type { EconomyPersistenceRuntimeBridge, PersistenceLifecycleEntry };
