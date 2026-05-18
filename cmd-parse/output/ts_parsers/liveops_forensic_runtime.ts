/**
 * LIVE-OPS FORENSIC RUNTIME — CMD4 Phase 16 Module 3.
 *
 * Top-level READ-ONLY production live-ops forensic toolkit. Combines
 * archive integrity, replay divergence tracing, distributed diagnostics,
 * and structured audit graphs for operational incident investigation.
 *
 * Brief v16 §M3 responsibilities:
 *   1. replay divergence tracing (graph + chain)
 *   2. distributed replay diagnostics
 *   3. archive corruption tracing (deep verify)
 *   4. regression incident reconstruction (per-label deep dive)
 *   5. deterministic replay audit graphs (nodes + edges, lex-canonical)
 *
 * STRICT RULE (brief v16 §M3):
 *   READ-ONLY ONLY.
 * FORBIDDEN:
 *   replay mutation
 *   authority injection
 *   runtime override
 *   forensic replay rewrite
 *
 * Encapsulation: archive held via ES `#archive` private field — engine-
 * enforced (no `(runtime as any).archive` runtime escape).
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence.
 *
 * Ownership: tooling/forensic layer (brief v16 §III).
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';
import {
  ImmutableSnapshotArchive,
  verifyArchiveSnapshot,
  type ArchiveEntry,
  type ArchiveVerifyResult,
} from './immutable_snapshot_archive.js';
import {
  auditArchiveReplayChain,
  diffArchiveSnapshots,
  type ArchiveChainAuditReport,
} from './automated_replay_regression_runtime.js';
import type { DriftReport, DriftDivergence } from './replay_drift_monitor.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const LIVEOPS_FORENSIC_RUNTIME_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface AuditGraphNode {
  readonly ordinal: number;
  readonly label: string;
  readonly artifact_hash: string;
  readonly verify_ok: boolean;
  readonly hash_validation_ok: boolean;
}

export interface AuditGraphEdge {
  readonly from_label: string;
  readonly to_label: string;
  readonly drift_count: number;
  /** Lex-sorted fingerprints of divergences on this edge. */
  readonly drift_fingerprints: readonly string[];
}

export interface AuditGraphReport {
  readonly runtime_version: number;
  readonly trace_kind: 'audit_graph';
  /** Lex-sorted by label. */
  readonly nodes: readonly AuditGraphNode[];
  /** Lex-sorted by (from_label, to_label). */
  readonly edges: readonly AuditGraphEdge[];
  readonly all_nodes_ok: boolean;
  readonly deterministic_hash: string;
}

export interface ReplayDivergenceTraceReport {
  readonly runtime_version: number;
  readonly trace_kind: 'replay_divergence_trace';
  readonly base_label: string;
  readonly base_found: boolean;
  /** Drift report base vs each other archive entry (excluding base itself).
   *  Frozen, lex-sorted by candidate label. */
  readonly pairwise_drifts: readonly {
    readonly candidate_label: string;
    readonly drift_hash: string;
    readonly drift_count: number;
    readonly ok: boolean;
  }[];
  readonly deterministic_hash: string;
}

export interface ArchiveCorruptionTraceReport {
  readonly runtime_version: number;
  readonly trace_kind: 'archive_corruption_trace';
  readonly archive_verify: ArchiveVerifyResult;
  /** Re-verify per-entry: any with verify_ok=false / hash_validation_ok=false. */
  readonly bad_entries: readonly { readonly ordinal: number; readonly label: string }[];
  readonly deterministic_hash: string;
}

export interface IncidentReconstructionReport {
  readonly runtime_version: number;
  readonly trace_kind: 'incident_reconstruction';
  readonly label: string;
  readonly entry_found: boolean;
  readonly artifact_hash: string | null;
  /** Drift between this entry and EVERY other archive entry (lex-sorted by other label). */
  readonly drifts: readonly {
    readonly other_label: string;
    readonly drift_hash: string;
    readonly drift_count: number;
    readonly ok: boolean;
  }[];
  readonly chain_audit_hash: string;
  readonly deterministic_hash: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers — direct codepoint compare
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

function fingerprintsOf(drift: DriftReport): readonly string[] {
  const fps = drift.divergences.map((d: DriftDivergence) => d.fingerprint);
  fps.sort(lexCompare);
  return Object.freeze(fps);
}

// ═══════════════════════════════════════════════════════════════════════════
// LiveOpsForensicRuntime — READ-ONLY top-level forensic runtime
// ═══════════════════════════════════════════════════════════════════════════

export class LiveOpsForensicRuntime {
  /**
   * ES private field — engine-enforced READ-ONLY closure of the archive.
   * Cannot be reached via `(runtime as any).#archive`.
   */
  readonly #archive: ImmutableSnapshotArchive;

  constructor(archive: ImmutableSnapshotArchive) {
    this.#archive = archive;
  }

  get archiveSize(): number {
    return this.#archive.size;
  }

  // ════ Query #1: audit graph ═══════════════════════════════════════════

  /**
   * Build a deterministic replay audit graph from the archive:
   *   - Nodes = archive entries (one per label)
   *   - Edges = consecutive-entry drift (one edge per (prev,curr) pair)
   *
   * Pure — same archive state → same graph bytes ALWAYS.
   */
  buildAuditGraph(): AuditGraphReport {
    const chainAudit: ArchiveChainAuditReport = auditArchiveReplayChain(this.#archive);
    const entries = this.#archive.allEntries();

    // Nodes — sorted lex by label
    const nodes: AuditGraphNode[] = chainAudit.per_entry.map((e) => ({
      ordinal: e.ordinal,
      label: e.label,
      artifact_hash:
        // Look up artifact_hash from archive (chainAudit doesn't carry it)
        this.#archive.lookupByLabel(e.label)!.artifact.deterministic_hash,
      verify_ok: e.verify_ok,
      hash_validation_ok: e.hash_validation_ok,
    }));
    nodes.sort((a, b) => lexCompare(a.label, b.label));
    const frozenNodes = Object.freeze(nodes.map((n) => Object.freeze(n)));

    // Edges — per consecutive pair (prev→curr in ordinal order)
    const edges: AuditGraphEdge[] = [];
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1]!;
      const curr = entries[i]!;
      const drift = diffArchiveSnapshots(this.#archive, prev.label, curr.label);
      edges.push({
        from_label: prev.label,
        to_label: curr.label,
        drift_count: drift.divergences.length,
        drift_fingerprints: fingerprintsOf(drift),
      });
    }
    edges.sort((a, b) => {
      const fc = lexCompare(a.from_label, b.from_label);
      if (fc !== 0) return fc;
      return lexCompare(a.to_label, b.to_label);
    });
    const frozenEdges = Object.freeze(edges.map((e) => Object.freeze(e)));

    const allNodesOk = frozenNodes.every((n) => n.verify_ok && n.hash_validation_ok);

    const canonical = canonicalSerialize({
      runtime_version: LIVEOPS_FORENSIC_RUNTIME_VERSION,
      trace_kind: 'audit_graph',
      nodes: frozenNodes.map((n) => ({
        ordinal: n.ordinal,
        label: n.label,
        artifact_hash: n.artifact_hash,
        verify_ok: n.verify_ok,
        hash_validation_ok: n.hash_validation_ok,
      })),
      edges: frozenEdges.map((e) => ({
        from_label: e.from_label,
        to_label: e.to_label,
        drift_count: e.drift_count,
        drift_fingerprints: e.drift_fingerprints,
      })),
      all_nodes_ok: allNodesOk,
    });

    return Object.freeze({
      runtime_version: LIVEOPS_FORENSIC_RUNTIME_VERSION,
      trace_kind: 'audit_graph' as const,
      nodes: frozenNodes,
      edges: frozenEdges,
      all_nodes_ok: allNodesOk,
      deterministic_hash: fnv1a32(canonical),
    });
  }

  // ════ Query #2: replay divergence trace ════════════════════════════════

  /**
   * Trace divergence: compare a chosen base entry against every other
   * archive entry. Useful to find which historical entries deviate from
   * a release baseline.
   *
   * Returns frozen report. base label unknown → `base_found=false` and
   * `pairwise_drifts=[]`. NEVER throws.
   */
  traceReplayDivergence(baseLabel: string): ReplayDivergenceTraceReport {
    const base = this.#archive.lookupByLabel(baseLabel);
    if (base === undefined) {
      const canonicalEmpty = canonicalSerialize({
        runtime_version: LIVEOPS_FORENSIC_RUNTIME_VERSION,
        trace_kind: 'replay_divergence_trace',
        base_label: baseLabel,
        base_found: false,
        pairwise_drifts: [],
      });
      return Object.freeze({
        runtime_version: LIVEOPS_FORENSIC_RUNTIME_VERSION,
        trace_kind: 'replay_divergence_trace' as const,
        base_label: baseLabel,
        base_found: false,
        pairwise_drifts: Object.freeze([]),
        deterministic_hash: fnv1a32(canonicalEmpty),
      });
    }

    const drifts: { candidate_label: string; drift_hash: string; drift_count: number; ok: boolean }[] = [];
    for (const e of this.#archive.allEntries()) {
      if (e.label === baseLabel) continue;
      const drift = diffArchiveSnapshots(this.#archive, baseLabel, e.label);
      drifts.push({
        candidate_label: e.label,
        drift_hash: drift.deterministic_hash,
        drift_count: drift.divergences.length,
        ok: drift.ok,
      });
    }
    drifts.sort((a, b) => lexCompare(a.candidate_label, b.candidate_label));
    const frozen = Object.freeze(drifts.map((d) => Object.freeze(d)));

    const canonical = canonicalSerialize({
      runtime_version: LIVEOPS_FORENSIC_RUNTIME_VERSION,
      trace_kind: 'replay_divergence_trace',
      base_label: baseLabel,
      base_found: true,
      pairwise_drifts: frozen.map((d) => ({
        candidate_label: d.candidate_label,
        drift_hash: d.drift_hash,
        drift_count: d.drift_count,
        ok: d.ok,
      })),
    });

    return Object.freeze({
      runtime_version: LIVEOPS_FORENSIC_RUNTIME_VERSION,
      trace_kind: 'replay_divergence_trace' as const,
      base_label: baseLabel,
      base_found: true,
      pairwise_drifts: frozen,
      deterministic_hash: fnv1a32(canonical),
    });
  }

  // ════ Query #3: archive corruption trace ═══════════════════════════════

  /**
   * Deep archive corruption trace: verify snapshot integrity + per-entry
   * verify + hash-validate; report any entries that fail.
   */
  traceArchiveCorruption(): ArchiveCorruptionTraceReport {
    const snapshot = this.#archive.exportSnapshot();
    const archiveVerify = verifyArchiveSnapshot(snapshot);
    const chainAudit = auditArchiveReplayChain(this.#archive);

    const bad: { ordinal: number; label: string }[] = chainAudit.per_entry
      .filter((e) => !e.verify_ok || !e.hash_validation_ok)
      .map((e) => ({ ordinal: e.ordinal, label: e.label }));
    bad.sort((a, b) => {
      const oc = intCompare(a.ordinal, b.ordinal);
      if (oc !== 0) return oc;
      return lexCompare(a.label, b.label);
    });
    const frozenBad = Object.freeze(bad.map((e) => Object.freeze(e)));

    const canonical = canonicalSerialize({
      runtime_version: LIVEOPS_FORENSIC_RUNTIME_VERSION,
      trace_kind: 'archive_corruption_trace',
      archive_verify_ok: archiveVerify.ok,
      archive_verify_version_match: archiveVerify.version_match,
      archive_verify_ordinal_monotonic: archiveVerify.ordinal_monotonic,
      archive_verify_labels_unique: archiveVerify.labels_unique,
      archive_verify_all_entry_hashes_valid: archiveVerify.all_entry_hashes_valid,
      archive_verify_index_recompute_match: archiveVerify.index_recompute_match,
      archive_verify_top_hash_recompute_match: archiveVerify.top_hash_recompute_match,
      bad_entries: frozenBad.map((e) => ({ ordinal: e.ordinal, label: e.label })),
    });

    return Object.freeze({
      runtime_version: LIVEOPS_FORENSIC_RUNTIME_VERSION,
      trace_kind: 'archive_corruption_trace' as const,
      archive_verify: archiveVerify,
      bad_entries: frozenBad,
      deterministic_hash: fnv1a32(canonical),
    });
  }

  // ════ Query #4: incident reconstruction ════════════════════════════════

  /**
   * Per-label deep dive: drift against every other entry + chain audit.
   * NEVER throws on unknown label.
   */
  reconstructIncident(label: string): IncidentReconstructionReport {
    const entry: ArchiveEntry | undefined = this.#archive.lookupByLabel(label);
    const chainAudit = auditArchiveReplayChain(this.#archive);

    const drifts: { other_label: string; drift_hash: string; drift_count: number; ok: boolean }[] = [];
    if (entry !== undefined) {
      for (const e of this.#archive.allEntries()) {
        if (e.label === label) continue;
        const drift = diffArchiveSnapshots(this.#archive, label, e.label);
        drifts.push({
          other_label: e.label,
          drift_hash: drift.deterministic_hash,
          drift_count: drift.divergences.length,
          ok: drift.ok,
        });
      }
      drifts.sort((a, b) => lexCompare(a.other_label, b.other_label));
    }
    const frozenDrifts = Object.freeze(drifts.map((d) => Object.freeze(d)));

    const canonical = canonicalSerialize({
      runtime_version: LIVEOPS_FORENSIC_RUNTIME_VERSION,
      trace_kind: 'incident_reconstruction',
      label,
      entry_found: entry !== undefined,
      artifact_hash: entry !== undefined ? entry.artifact.deterministic_hash : null,
      drifts: frozenDrifts.map((d) => ({
        other_label: d.other_label,
        drift_hash: d.drift_hash,
        drift_count: d.drift_count,
        ok: d.ok,
      })),
      chain_audit_hash: chainAudit.deterministic_hash,
    });

    return Object.freeze({
      runtime_version: LIVEOPS_FORENSIC_RUNTIME_VERSION,
      trace_kind: 'incident_reconstruction' as const,
      label,
      entry_found: entry !== undefined,
      artifact_hash: entry !== undefined ? entry.artifact.deterministic_hash : null,
      drifts: frozenDrifts,
      chain_audit_hash: chainAudit.deterministic_hash,
      deterministic_hash: fnv1a32(canonical),
    });
  }
}
