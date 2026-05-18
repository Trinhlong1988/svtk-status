/**
 * OPERATIONAL ABUSE RESILIENCE RUNTIME — CMD4 Phase 22 Module 3.
 *
 * Deterministic replay throttling + deduplication + bounded scheduling
 * for extreme operational abuse / flood scenarios. Pure read-only —
 * NEVER touches replay / archive / forensic state.
 *
 * Brief v22 §M3 responsibilities:
 *   1. deterministic replay throttling
 *   2. replay deduplication (by hash)
 *   3. bounded replay scheduling (max-per-window)
 *   4. replay amplification detection
 *   5. deterministic flood mitigation
 *   6. operational queue stabilization
 *
 * MANDATORY: same abuse pattern → same mitigation result ALWAYS.
 *
 * FORBIDDEN: runtime-dependent starvation or nondeterministic prioritization.
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence beyond append-only log.
 *
 * Ownership: tooling/liveops layer (brief v22 §III).
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const OPERATIONAL_ABUSE_RESILIENCE_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface ReplayRequest {
  /** Logical clock ordinal (caller-managed monotonic INT). */
  readonly ordinal: number;
  /** Caller-supplied request identity hash (e.g. artifact deterministic_hash). */
  readonly request_hash: string;
  /** Caller-supplied source identifier (e.g. region or worker). */
  readonly source_id: string;
}

export const DECISION_KIND = Object.freeze({
  ACCEPTED: 'accepted',
  REJECTED_DUPLICATE: 'rejected_duplicate',
  REJECTED_THROTTLED: 'rejected_throttled',
  REJECTED_AMPLIFICATION: 'rejected_amplification',
} as const);
export type DecisionKind = (typeof DECISION_KIND)[keyof typeof DECISION_KIND];

export interface ReplayDecision {
  readonly ordinal: number;
  readonly request_hash: string;
  readonly source_id: string;
  readonly decision: DecisionKind;
}

export interface AbuseResilienceReport {
  readonly runtime_version: number;
  readonly total_requests: number;
  readonly accepted_count: number;
  readonly rejected_duplicate_count: number;
  readonly rejected_throttled_count: number;
  readonly rejected_amplification_count: number;
  /** Lex-sorted by (source_id, ordinal). */
  readonly decisions: readonly ReplayDecision[];
  readonly deterministic_hash: string;
}

export interface AbuseResilienceConfig {
  /** Max accepted requests per source within a sliding ordinal window. */
  readonly throttle_per_source: number;
  /** Sliding ordinal window size for throttle. */
  readonly throttle_window_size: number;
  /**
   * Max repeated identical (request_hash) acceptances per source —
   * detects replay amplification (same artifact resubmitted N times).
   */
  readonly amplification_per_source_per_hash: number;
}

export const DEFAULT_RESILIENCE_CONFIG: AbuseResilienceConfig = Object.freeze({
  throttle_per_source: 100,
  throttle_window_size: 1000,
  amplification_per_source_per_hash: 5,
});

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function lexCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function intCompare(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// OperationalAbuseResilienceRuntime — append-only request log with decisions
// ═══════════════════════════════════════════════════════════════════════════

export class OperationalAbuseResilienceRuntime {
  private readonly decisions: ReplayDecision[] = [];
  /** Per-source: ordered list of ordinals already ACCEPTED (for throttle window). */
  private readonly acceptedOrdinals = new Map<string, number[]>();
  /** Per-source per-hash: count of ACCEPTED requests with that hash (for amplification). */
  private readonly amplificationCount = new Map<string, Map<string, number>>();
  /** Per-source: set of request_hashes already SEEN (for duplicate). */
  private readonly seenHashes = new Map<string, Set<string>>();
  private lastOrdinal: number | null = null;
  private readonly config: AbuseResilienceConfig;

  constructor(config: AbuseResilienceConfig = DEFAULT_RESILIENCE_CONFIG) {
    if (!Number.isSafeInteger(config.throttle_per_source) || config.throttle_per_source <= 0) {
      throw new Error(
        'operational_abuse_resilience_runtime: throttle_per_source must be positive safe integer',
      );
    }
    if (!Number.isSafeInteger(config.throttle_window_size) || config.throttle_window_size <= 0) {
      throw new Error(
        'operational_abuse_resilience_runtime: throttle_window_size must be positive safe integer',
      );
    }
    if (
      !Number.isSafeInteger(config.amplification_per_source_per_hash) ||
      config.amplification_per_source_per_hash <= 0
    ) {
      throw new Error(
        'operational_abuse_resilience_runtime: amplification_per_source_per_hash must be positive safe integer',
      );
    }
    this.config = config;
  }

  /**
   * Submit a replay request. Returns the deterministic decision.
   * Ordinal MUST be strictly monotonic across all requests (caller log).
   */
  submitRequest(req: ReplayRequest): DecisionKind {
    if (!Number.isSafeInteger(req.ordinal)) {
      throw new Error(
        `operational_abuse_resilience_runtime: ordinal must be safe integer, got ${String(req.ordinal)}`,
      );
    }
    if (this.lastOrdinal !== null && req.ordinal <= this.lastOrdinal) {
      throw new Error(
        `operational_abuse_resilience_runtime: ordinal must be strictly monotonic (last=${String(this.lastOrdinal)}, got=${String(req.ordinal)})`,
      );
    }
    if (typeof req.source_id !== 'string' || req.source_id.length === 0) {
      throw new Error('operational_abuse_resilience_runtime: source_id must be non-empty string');
    }
    if (typeof req.request_hash !== 'string' || req.request_hash.length === 0) {
      throw new Error('operational_abuse_resilience_runtime: request_hash must be non-empty string');
    }

    this.lastOrdinal = req.ordinal;

    // Decision pipeline (deterministic, ordered):
    // 1. Duplicate check — has this (source_id, request_hash) been seen?
    let seenSet = this.seenHashes.get(req.source_id);
    if (seenSet === undefined) {
      seenSet = new Set();
      this.seenHashes.set(req.source_id, seenSet);
    }
    if (seenSet.has(req.request_hash)) {
      this.decisions.push(
        Object.freeze({
          ordinal: req.ordinal,
          request_hash: req.request_hash,
          source_id: req.source_id,
          decision: DECISION_KIND.REJECTED_DUPLICATE,
        }),
      );
      return DECISION_KIND.REJECTED_DUPLICATE;
    }

    // 2. Amplification check — how many times has this source been accepted with this hash?
    // (Strictly, with the duplicate check above this should always be 0, but the structure
    //  is in place for future tuning when duplicates may be allowed with limits.)
    let perHashMap = this.amplificationCount.get(req.source_id);
    if (perHashMap === undefined) {
      perHashMap = new Map();
      this.amplificationCount.set(req.source_id, perHashMap);
    }
    const ampCount = perHashMap.get(req.request_hash) ?? 0;
    if (ampCount >= this.config.amplification_per_source_per_hash) {
      this.decisions.push(
        Object.freeze({
          ordinal: req.ordinal,
          request_hash: req.request_hash,
          source_id: req.source_id,
          decision: DECISION_KIND.REJECTED_AMPLIFICATION,
        }),
      );
      return DECISION_KIND.REJECTED_AMPLIFICATION;
    }

    // 3. Throttle check — how many accepted in the most recent sliding window?
    let acceptedList = this.acceptedOrdinals.get(req.source_id);
    if (acceptedList === undefined) {
      acceptedList = [];
      this.acceptedOrdinals.set(req.source_id, acceptedList);
    }
    // Prune accepted entries outside the window [req.ordinal - throttle_window_size + 1, req.ordinal].
    const windowStart = req.ordinal - this.config.throttle_window_size + 1;
    while (acceptedList.length > 0 && acceptedList[0]! < windowStart) {
      acceptedList.shift();
    }
    if (acceptedList.length >= this.config.throttle_per_source) {
      this.decisions.push(
        Object.freeze({
          ordinal: req.ordinal,
          request_hash: req.request_hash,
          source_id: req.source_id,
          decision: DECISION_KIND.REJECTED_THROTTLED,
        }),
      );
      return DECISION_KIND.REJECTED_THROTTLED;
    }

    // 4. Accepted — record state
    seenSet.add(req.request_hash);
    perHashMap.set(req.request_hash, ampCount + 1);
    acceptedList.push(req.ordinal);
    this.decisions.push(
      Object.freeze({
        ordinal: req.ordinal,
        request_hash: req.request_hash,
        source_id: req.source_id,
        decision: DECISION_KIND.ACCEPTED,
      }),
    );
    return DECISION_KIND.ACCEPTED;
  }

  get size(): number {
    return this.decisions.length;
  }

  /**
   * Aggregate the full decision log into a deterministic report.
   * Decisions are lex-sorted by (source_id, ordinal) for canonical output.
   *
   * Pure — same submission sequence → same report bytes ALWAYS.
   */
  exportReport(): AbuseResilienceReport {
    let accepted = 0;
    let dup = 0;
    let throttled = 0;
    let amp = 0;
    for (const d of this.decisions) {
      if (d.decision === DECISION_KIND.ACCEPTED) accepted++;
      else if (d.decision === DECISION_KIND.REJECTED_DUPLICATE) dup++;
      else if (d.decision === DECISION_KIND.REJECTED_THROTTLED) throttled++;
      else if (d.decision === DECISION_KIND.REJECTED_AMPLIFICATION) amp++;
    }

    const sorted = [...this.decisions].sort((a, b) => {
      const sc = lexCompare(a.source_id, b.source_id);
      if (sc !== 0) return sc;
      return intCompare(a.ordinal, b.ordinal);
    });
    const frozen = Object.freeze(sorted.map((d) => d));

    const canonical = canonicalSerialize({
      runtime_version: OPERATIONAL_ABUSE_RESILIENCE_VERSION,
      total_requests: this.decisions.length,
      accepted_count: accepted,
      rejected_duplicate_count: dup,
      rejected_throttled_count: throttled,
      rejected_amplification_count: amp,
      decisions: frozen.map((d) => [d.ordinal, d.request_hash, d.source_id, d.decision]),
    });

    return Object.freeze({
      runtime_version: OPERATIONAL_ABUSE_RESILIENCE_VERSION,
      total_requests: this.decisions.length,
      accepted_count: accepted,
      rejected_duplicate_count: dup,
      rejected_throttled_count: throttled,
      rejected_amplification_count: amp,
      decisions: frozen,
      deterministic_hash: fnv1a32(canonical),
    });
  }
}
