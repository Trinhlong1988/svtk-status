/**
 * FORENSIC RECONSTRUCTION RUNTIME — CMD4 Phase 17 Module 3.
 *
 * Production live MMO forensic reconstruction with **replay
 * replayability tracing** — a Phase 17 addition that verifies a
 * historical artifact re-runs `verifyExportArtifact` +
 * `validateSerializationHashes` identically across N invocations.
 *
 * Brief v17 §M3 responsibilities:
 *   1. replay divergence tracing (composes Phase 16 M3 + Phase 15 M2)
 *   2. distributed validation diagnostics
 *   3. archive corruption reconstruction
 *   4. regression incident replay tracing
 *   5. deterministic replay audit graphs
 *   6. **replay replayability tracing (NEW Phase 17)**
 *
 * STRICT RULE (brief v17 §M3):
 *   READ-ONLY ONLY.
 * FORBIDDEN:
 *   replay mutation
 *   authority injection
 *   runtime override
 *   forensic replay rewriting
 *
 * Encapsulation: archive held via ES `#archive` private field — engine-
 * enforced read-only.
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence.
 *
 * Ownership: tooling/forensic layer (brief v17 §III).
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';
import { verifyExportArtifact } from './deterministic_export_pipeline.js';
import { validateSerializationHashes } from './serialization_hash_validator.js';
import {
  ImmutableSnapshotArchive,
  type ArchiveEntry,
} from './immutable_snapshot_archive.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const FORENSIC_RECONSTRUCTION_RUNTIME_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface ReplayRerunResult {
  readonly rerun_index: number;
  readonly verify_ok: boolean;
  readonly hash_validation_ok: boolean;
  readonly hash_validation_hash: string;
}

export interface ReplayReplayabilityTrace {
  readonly runtime_version: number;
  readonly trace_kind: 'replay_replayability';
  readonly label: string;
  readonly entry_found: boolean;
  readonly artifact_hash: string | null;
  readonly rerun_count: number;
  readonly reruns: readonly ReplayRerunResult[];
  /** True iff all reruns produced identical (verify_ok, hash_validation_hash) tuples. */
  readonly all_reruns_identical: boolean;
  readonly deterministic_hash: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// ForensicReconstructionRuntime — READ-ONLY with replayability tracing
// ═══════════════════════════════════════════════════════════════════════════

export class ForensicReconstructionRuntime {
  readonly #archive: ImmutableSnapshotArchive;

  constructor(archive: ImmutableSnapshotArchive) {
    this.#archive = archive;
  }

  get archiveSize(): number {
    return this.#archive.size;
  }

  /**
   * Trace replay replayability for a single archive entry.
   *
   * For `rerun_count` invocations, re-run `verifyExportArtifact` +
   * `validateSerializationHashes` against the entry's artifact. Record
   * each rerun's outcome. `all_reruns_identical` confirms the artifact
   * verifies deterministically (the contract of Phase 12 readers).
   *
   * Pure — same (archive, label, rerun_count) → same trace bytes.
   * NEVER throws on unknown label — returns `entry_found=false`.
   *
   * Throws on caller bug: rerun_count not safe-integer or ≤ 0.
   */
  traceReplayReplayability(label: string, rerunCount: number): ReplayReplayabilityTrace {
    if (!Number.isSafeInteger(rerunCount) || rerunCount <= 0) {
      throw new Error(
        `forensic_reconstruction_runtime: rerun_count must be positive safe integer, got ${String(rerunCount)}`,
      );
    }

    const entry: ArchiveEntry | undefined = this.#archive.lookupByLabel(label);
    if (entry === undefined) {
      const canonicalEmpty = canonicalSerialize({
        runtime_version: FORENSIC_RECONSTRUCTION_RUNTIME_VERSION,
        trace_kind: 'replay_replayability',
        label,
        entry_found: false,
        artifact_hash: null,
        rerun_count: rerunCount,
        reruns: [],
        all_reruns_identical: false,
      });
      return Object.freeze({
        runtime_version: FORENSIC_RECONSTRUCTION_RUNTIME_VERSION,
        trace_kind: 'replay_replayability' as const,
        label,
        entry_found: false,
        artifact_hash: null,
        rerun_count: rerunCount,
        reruns: Object.freeze([]),
        all_reruns_identical: false,
        deterministic_hash: fnv1a32(canonicalEmpty),
      });
    }

    const reruns: ReplayRerunResult[] = [];
    let firstVerifyOk: boolean | null = null;
    let firstHashOk: boolean | null = null;
    let firstHashHash: string | null = null;
    let allIdentical = true;
    for (let i = 0; i < rerunCount; i++) {
      const v = verifyExportArtifact(entry.artifact);
      const h = validateSerializationHashes(entry.artifact);
      const result: ReplayRerunResult = Object.freeze({
        rerun_index: i,
        verify_ok: v.ok,
        hash_validation_ok: h.ok,
        hash_validation_hash: h.deterministic_hash,
      });
      reruns.push(result);
      if (i === 0) {
        firstVerifyOk = v.ok;
        firstHashOk = h.ok;
        firstHashHash = h.deterministic_hash;
      } else if (
        v.ok !== firstVerifyOk ||
        h.ok !== firstHashOk ||
        h.deterministic_hash !== firstHashHash
      ) {
        allIdentical = false;
      }
    }
    const frozenReruns = Object.freeze(reruns.map((r) => r));

    const canonical = canonicalSerialize({
      runtime_version: FORENSIC_RECONSTRUCTION_RUNTIME_VERSION,
      trace_kind: 'replay_replayability',
      label,
      entry_found: true,
      artifact_hash: entry.artifact.deterministic_hash,
      rerun_count: rerunCount,
      reruns: frozenReruns.map((r) => ({
        rerun_index: r.rerun_index,
        verify_ok: r.verify_ok,
        hash_validation_ok: r.hash_validation_ok,
        hash_validation_hash: r.hash_validation_hash,
      })),
      all_reruns_identical: allIdentical,
    });

    return Object.freeze({
      runtime_version: FORENSIC_RECONSTRUCTION_RUNTIME_VERSION,
      trace_kind: 'replay_replayability' as const,
      label,
      entry_found: true,
      artifact_hash: entry.artifact.deterministic_hash,
      rerun_count: rerunCount,
      reruns: frozenReruns,
      all_reruns_identical: allIdentical,
      deterministic_hash: fnv1a32(canonical),
    });
  }

  /**
   * Replay replayability across ALL archive entries. For each entry,
   * run `traceReplayReplayability(label, rerunCount)` and aggregate.
   *
   * Returns a per-entry summary lex-sorted by label.
   */
  traceAllReplayability(rerunCount: number): {
    readonly runtime_version: number;
    readonly trace_kind: 'all_replay_replayability';
    readonly rerun_count: number;
    readonly entry_count: number;
    readonly per_entry: readonly {
      readonly label: string;
      readonly all_reruns_identical: boolean;
      readonly trace_hash: string;
    }[];
    readonly all_entries_replayable: boolean;
    readonly deterministic_hash: string;
  } {
    if (!Number.isSafeInteger(rerunCount) || rerunCount <= 0) {
      throw new Error(
        `forensic_reconstruction_runtime: rerun_count must be positive safe integer, got ${String(rerunCount)}`,
      );
    }

    const perEntry: { label: string; all_reruns_identical: boolean; trace_hash: string }[] = [];
    let allReplayable = true;
    for (const e of this.#archive.allEntries()) {
      const trace = this.traceReplayReplayability(e.label, rerunCount);
      if (!trace.all_reruns_identical) allReplayable = false;
      perEntry.push({
        label: e.label,
        all_reruns_identical: trace.all_reruns_identical,
        trace_hash: trace.deterministic_hash,
      });
    }
    perEntry.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    const frozenPerEntry = Object.freeze(perEntry.map((p) => Object.freeze(p)));

    const canonical = canonicalSerialize({
      runtime_version: FORENSIC_RECONSTRUCTION_RUNTIME_VERSION,
      trace_kind: 'all_replay_replayability',
      rerun_count: rerunCount,
      entry_count: frozenPerEntry.length,
      per_entry: frozenPerEntry.map((p) => ({
        label: p.label,
        all_reruns_identical: p.all_reruns_identical,
        trace_hash: p.trace_hash,
      })),
      all_entries_replayable: allReplayable,
    });

    return Object.freeze({
      runtime_version: FORENSIC_RECONSTRUCTION_RUNTIME_VERSION,
      trace_kind: 'all_replay_replayability' as const,
      rerun_count: rerunCount,
      entry_count: frozenPerEntry.length,
      per_entry: frozenPerEntry,
      all_entries_replayable: allReplayable,
      deterministic_hash: fnv1a32(canonical),
    });
  }
}
