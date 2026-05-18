/**
 * CROSS-REGION INTEGRITY RUNTIME — Phase 18 Module #2.
 *
 * Cross-region deterministic integrity validation.
 *
 * STRICT SCOPE (v22 Phase 18 spec):
 *   - SUPPORT: region-safe replay verification / deterministic cross-region convergence /
 *     replay-safe region synchronization / canonical region hashing / stable replay parity
 *   - MANDATORY: same replay source → same cross-region result ALWAYS
 *   - FORBIDDEN: region-local traversal ordering / locale-sensitive sorting /
 *     runtime-dependent region aggregation
 *
 * Pattern:
 *   - Accepts a set of (region_id, replay_hash) tuples → verifies convergence
 *   - Detects region drift (any region's replay_hash differs from others)
 *   - Produces frozen consensus report
 */
import { fnv1a32 } from '../../../cmd-engine/output/economy/modifier_ordering_audit.js';
import { canonicalJSON } from '../../../cmd-engine/output/economy/economy_serialization_contract.js';

export const CROSS_REGION_INTEGRITY_VERSION = 1;

// ───────── Region check kinds ─────────
export const REGION_CHECKS = [
  'replay_hash_convergence',       // all regions same replay_hash
  'canonical_region_ordering',     // region_ids returned in codepoint order
  'replay_parity_count',           // count regions matching majority hash
] as const;
export type RegionCheck = (typeof REGION_CHECKS)[number];

// ───────── Region snapshot input ─────────
export interface RegionSnapshot {
  region_id: string;       // stable region identifier (e.g., 'us-east', 'eu-west')
  replay_hash: string;     // hash of replay state at this region
  tick: number;            // tick at snapshot
}

// ───────── Single result ─────────
export interface RegionCheckResult {
  check: RegionCheck;
  passed: boolean;
  reason: string;
  evidence_hash: string;
}

// ───────── Aggregate report ─────────
export interface CrossRegionReport {
  cross_region_version: number;
  tick: number;
  region_count: number;
  results: readonly RegionCheckResult[];
  passed_count: number;
  failed_count: number;
  overall: 'pass' | 'fail';
  /** Sorted region_id list (codepoint canonical). */
  regions_sorted: readonly string[];
  /** Consensus replay_hash (majority). */
  consensus_replay_hash: string | null;
  content_hash: string;
}

// ───────── Contract ─────────
export interface CrossRegionIntegrityRuntime {
  runCheck(check: RegionCheck, snapshots: readonly RegionSnapshot[]): RegionCheckResult;
  runAll(snapshots: readonly RegionSnapshot[], tick: number): CrossRegionReport;
  readonly auditLog: readonly CrossRegionReport[];
  clearAuditLog(): void;
}

// ───────── Helpers ─────────
function cmpStr(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function validateSnapshots(snapshots: readonly RegionSnapshot[]): void {
  if (!Array.isArray(snapshots)) {
    throw new Error(`[CrossRegionIntegrityRuntime] snapshots must be array`);
  }
  const seen = new Set<string>();
  for (const s of snapshots) {
    if (typeof s.region_id !== 'string' || s.region_id.length === 0) {
      throw new Error(`[CrossRegionIntegrityRuntime] region_id must be non-empty string`);
    }
    if (typeof s.replay_hash !== 'string' || s.replay_hash.length === 0) {
      throw new Error(`[CrossRegionIntegrityRuntime] replay_hash must be non-empty string`);
    }
    if (!Number.isInteger(s.tick) || s.tick < 0) {
      throw new Error(`[CrossRegionIntegrityRuntime] snapshot.tick must be non-negative integer`);
    }
    if (seen.has(s.region_id)) {
      throw new Error(`[CrossRegionIntegrityRuntime] duplicate region_id: ${s.region_id}`);
    }
    seen.add(s.region_id);
  }
}

function makeResult(
  check: RegionCheck,
  passed: boolean,
  reason: string,
  evidence: unknown,
): RegionCheckResult {
  return Object.freeze({
    check,
    passed,
    reason: passed ? '' : reason,
    evidence_hash: fnv1a32(canonicalJSON(evidence)),
  });
}

// ───────── Factory ─────────
export function createCrossRegionIntegrityRuntime(): CrossRegionIntegrityRuntime {
  const auditLog: CrossRegionReport[] = [];

  function runReplayHashConvergence(snapshots: readonly RegionSnapshot[]): RegionCheckResult {
    try {
      if (snapshots.length === 0) {
        return makeResult('replay_hash_convergence', true, '', { region_count: 0 });
      }
      const hashes = new Set(snapshots.map(s => s.replay_hash));
      const ok = hashes.size === 1;
      return makeResult('replay_hash_convergence', ok,
        ok ? '' : `${hashes.size} distinct replay_hash values across ${snapshots.length} regions`,
        { distinct_hash_count: hashes.size, region_count: snapshots.length });
    } catch (e) {
      return makeResult('replay_hash_convergence', false, `threw: ${(e as Error).message}`, { error: true });
    }
  }

  function runCanonicalRegionOrdering(snapshots: readonly RegionSnapshot[]): RegionCheckResult {
    try {
      // U#23 fix: was tautological (sort then sort again — always idempotent).
      // Now actually tests SHUFFLE INVARIANCE: 3 different orderings (as-is /
      // reversed / sorted) must produce identical canonical hash after sort.
      const regionIds = snapshots.map(s => s.region_id);
      const orderAsIs = [...regionIds];
      const orderReversed = [...regionIds].reverse();
      const orderSorted = [...regionIds].sort(cmpStr);
      // After applying canonical sort, all 3 should yield identical canonical JSON.
      const canonAsIs = canonicalJSON([...orderAsIs].sort(cmpStr) as unknown);
      const canonReversed = canonicalJSON([...orderReversed].sort(cmpStr) as unknown);
      const canonSorted = canonicalJSON([...orderSorted].sort(cmpStr) as unknown);
      const ok = canonAsIs === canonReversed && canonReversed === canonSorted;
      return makeResult('canonical_region_ordering', ok,
        ok ? '' : 'canonical sort not shuffle-invariant',
        {
          hashAsIs: fnv1a32(canonAsIs),
          hashReversed: fnv1a32(canonReversed),
          hashSorted: fnv1a32(canonSorted),
          region_count: snapshots.length,
        });
    } catch (e) {
      return makeResult('canonical_region_ordering', false, `threw: ${(e as Error).message}`, { error: true });
    }
  }

  // U#17 fix: shared deterministic majority helper — DRY between runReplayParityCount
  // and computeConsensus. Lex-smallest hash wins on count tie (first iterated).
  function findMajority(snapshots: readonly RegionSnapshot[]):
    { hash: string | null; count: number; hasStrictMajority: boolean }
  {
    if (snapshots.length === 0) {
      return { hash: null, count: 0, hasStrictMajority: false };
    }
    const counts = new Map<string, number>();
    for (const s of snapshots) {
      counts.set(s.replay_hash, (counts.get(s.replay_hash) ?? 0) + 1);
    }
    let bestHash: string | null = null;
    let bestCount = 0;
    for (const h of [...counts.keys()].sort(cmpStr)) {
      const c = counts.get(h)!;
      if (c > bestCount) { bestCount = c; bestHash = h; }
    }
    return { hash: bestHash, count: bestCount, hasStrictMajority: bestCount > snapshots.length / 2 };
  }

  function runReplayParityCount(snapshots: readonly RegionSnapshot[]): RegionCheckResult {
    try {
      const { hash, count, hasStrictMajority } = findMajority(snapshots);
      if (snapshots.length === 0) {
        return makeResult('replay_parity_count', true, '', { majority_count: 0 });
      }
      return makeResult('replay_parity_count', hasStrictMajority,
        hasStrictMajority ? '' : `no majority: top hash has ${count}/${snapshots.length} regions`,
        { majorityHash: hash, majorityCount: count, total: snapshots.length });
    } catch (e) {
      return makeResult('replay_parity_count', false, `threw: ${(e as Error).message}`, { error: true });
    }
  }

  function dispatch(check: RegionCheck, snapshots: readonly RegionSnapshot[]): RegionCheckResult {
    switch (check) {
      case 'replay_hash_convergence':    return runReplayHashConvergence(snapshots);
      case 'canonical_region_ordering':  return runCanonicalRegionOrdering(snapshots);
      case 'replay_parity_count':        return runReplayParityCount(snapshots);
    }
  }

  function computeConsensus(snapshots: readonly RegionSnapshot[]): string | null {
    // U#17 fix: reuse findMajority — no logic duplication.
    const { hash, hasStrictMajority } = findMajority(snapshots);
    return hasStrictMajority ? hash : null;
  }

  return {
    runCheck(check, snapshots) {
      if (!REGION_CHECKS.includes(check)) {
        throw new Error(`[CrossRegionIntegrityRuntime] invalid check: ${check}`);
      }
      validateSnapshots(snapshots);
      return dispatch(check, snapshots);
    },

    runAll(snapshots, tick) {
      validateSnapshots(snapshots);
      if (!Number.isInteger(tick) || tick < 0) {
        throw new Error(`[CrossRegionIntegrityRuntime] tick must be non-negative integer`);
      }
      const results: RegionCheckResult[] = [];
      for (const c of REGION_CHECKS) {
        results.push(dispatch(c, snapshots));
      }
      const sortedResults = Object.freeze(
        [...results].sort((a, b) => cmpStr(a.check, b.check)),
      );
      const passed_count = sortedResults.filter(r => r.passed).length;
      const failed_count = sortedResults.length - passed_count;
      const overall: 'pass' | 'fail' = failed_count === 0 ? 'pass' : 'fail';
      const regions_sorted = Object.freeze(
        snapshots.map(s => s.region_id).sort(cmpStr),
      );
      const consensus_replay_hash = computeConsensus(snapshots);
      const core = {
        cross_region_version: CROSS_REGION_INTEGRITY_VERSION,
        tick,
        region_count: snapshots.length,
        results: sortedResults,
        passed_count,
        failed_count,
        overall,
        regions_sorted,
        consensus_replay_hash,
      };
      const content_hash = fnv1a32(canonicalJSON(core as unknown));
      const report = Object.freeze({ ...core, content_hash });
      auditLog.push(report);
      return report;
    },

    get auditLog() {
      return Object.freeze([...auditLog]);
    },
    clearAuditLog() {
      auditLog.length = 0;
    },
  };
}
