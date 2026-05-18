/**
 * FORENSIC RECONSTRUCTION CONSOLE — CMD4 Phase 15 Module 4.
 *
 * Top-level READ-ONLY operational replay reconstruction tooling. Wraps
 * an `ImmutableSnapshotArchive` + composes Phase 13/14/15 readers to
 * deliver deep forensic queries.
 *
 * Brief v15 §M4 responsibilities:
 *   1. replay divergence reconstruction (drift report + canonical trace)
 *   2. export drift diagnostics (verify + hash-validate + inspect chain)
 *   3. deterministic audit traces (frozen per-query reports)
 *   4. replay continuation reconstruction (chain audit + consecutive drift)
 *   5. operational incident replay analysis (per-label deep dive)
 *
 * STRICT RULE (brief v15 §M4):
 *   READ-ONLY ONLY.
 * FORBIDDEN:
 *   runtime mutation
 *   gameplay override
 *   GM authority injection
 *   replay mutation
 *
 * Class exposes NO mutation methods — no setArchive, no remove, no
 * inject, no patch. Construction takes the archive once; all queries are
 * pure functions of (archive state, query args).
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence.
 *
 * Ownership: tooling/forensic layer (brief v15 §III).
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';
import {
  verifyExportArtifact,
  type ExportArtifact,
  type VerifyExportResult,
} from './deterministic_export_pipeline.js';
import {
  validateSerializationHashes,
  type HashValidationReport,
} from './serialization_hash_validator.js';
import {
  inspectExportArtifact,
  type InspectionReport,
} from './replay_registry_inspector.js';
import {
  ImmutableSnapshotArchive,
  type ArchiveEntry,
  type ArchiveSnapshot,
} from './immutable_snapshot_archive.js';
import {
  auditArchiveReplayChain,
  diffArchiveSnapshots,
  type ArchiveChainAuditReport,
} from './automated_replay_regression_runtime.js';
import type { DriftReport } from './replay_drift_monitor.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const FORENSIC_CONSOLE_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface IncidentReport {
  readonly console_version: number;
  readonly query_kind: 'incident_analysis';
  readonly label: string;
  /** Found archive entry hash, or null if label unknown. */
  readonly artifact_hash: string | null;
  readonly entry_found: boolean;
  readonly verify: VerifyExportResult | null;
  readonly hash_validation: HashValidationReport | null;
  readonly inspection: InspectionReport | null;
  readonly ok: boolean;
  readonly deterministic_hash: string;
}

export interface DriftReconstructionReport {
  readonly console_version: number;
  readonly query_kind: 'drift_reconstruction';
  readonly label_a: string;
  readonly label_b: string;
  readonly drift: DriftReport;
  readonly deterministic_hash: string;
}

export interface ChainReconstructionReport {
  readonly console_version: number;
  readonly query_kind: 'chain_reconstruction';
  readonly chain_audit: ArchiveChainAuditReport;
  readonly deterministic_hash: string;
}

export interface FullDiagnosticsReport {
  readonly console_version: number;
  readonly query_kind: 'full_diagnostics';
  readonly archive_snapshot_hash: string;
  readonly chain_audit_hash: string;
  readonly archive_entry_count: number;
  readonly all_entries_verify_ok: boolean;
  readonly deterministic_hash: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// ForensicReconstructionConsole — read-only wrapper
// ═══════════════════════════════════════════════════════════════════════════

export class ForensicReconstructionConsole {
  /**
   * ES private field (`#archive`) — stronger than TS `private`. TS `private`
   * is a compile-time check that runtime can bypass via `(console as any)`.
   * `#archive` is enforced at the engine level: any reference outside the
   * class body throws `SyntaxError`. This closes the only remaining
   * READ-ONLY escape vector identified in the audit.
   */
  readonly #archive: ImmutableSnapshotArchive;

  /**
   * Construct console bound to a single archive. NO method exists to
   * replace the archive or mutate state. Console is a pure read-only view.
   */
  constructor(archive: ImmutableSnapshotArchive) {
    this.#archive = archive;
  }

  // ════ Direct archive query passthroughs ═══════════════════════════════

  /** O(1) lookup by label via internal Map. Returns frozen ArchiveEntry or undefined. */
  lookupEntry(label: string): ArchiveEntry | undefined {
    return this.#archive.lookupByLabel(label);
  }

  /** O(K log K) lookup by artifact deterministic_hash. Returns frozen list. */
  lookupByArtifactHash(artifactHash: string): readonly ArchiveEntry[] {
    return this.#archive.lookupByArtifactHash(artifactHash);
  }

  /** Archive snapshot — frozen, deterministic. */
  exportArchiveSnapshot(): ArchiveSnapshot {
    return this.#archive.exportSnapshot();
  }

  get archiveSize(): number {
    return this.#archive.size;
  }

  // ════ Reconstruction queries ══════════════════════════════════════════

  /**
   * Operational incident replay analysis: deep dive on a single label.
   * Returns verify + hash-validate + inspection bundle. Label unknown →
   * `entry_found=false`, all readers null.
   */
  reconstructIncident(label: string): IncidentReport {
    const entry = this.#archive.lookupByLabel(label);

    const v: VerifyExportResult | null = entry !== undefined ? verifyExportArtifact(entry.artifact) : null;
    const h: HashValidationReport | null = entry !== undefined ? validateSerializationHashes(entry.artifact) : null;
    const insp: InspectionReport | null = entry !== undefined ? inspectExportArtifact(entry.artifact) : null;

    const ok =
      v !== null && h !== null && insp !== null && v.ok && h.ok && insp.ok;
    const artifactHash = entry !== undefined ? entry.artifact.deterministic_hash : null;

    // Canonical fields kept identical across found/unknown branches —
    // each field is either its real value or null. This prevents accidental
    // hash collisions if the schema evolves and forecloses determinism
    // bugs from branch-asymmetric field sets.
    const canonical = canonicalSerialize({
      console_version: FORENSIC_CONSOLE_VERSION,
      query_kind: 'incident_analysis',
      label,
      artifact_hash: artifactHash,
      entry_found: entry !== undefined,
      verify_ok: v?.ok ?? null,
      hash_validation_ok: h?.ok ?? null,
      inspection_ok: insp?.ok ?? null,
      hash_validation_hash: h?.deterministic_hash ?? null,
      inspection_hash: insp?.deterministic_hash ?? null,
      ok,
    });
    return Object.freeze({
      console_version: FORENSIC_CONSOLE_VERSION,
      query_kind: 'incident_analysis' as const,
      label,
      artifact_hash: artifactHash,
      entry_found: entry !== undefined,
      verify: v,
      hash_validation: h,
      inspection: insp,
      ok,
      deterministic_hash: fnv1a32(canonical),
    });
  }

  /**
   * Replay divergence reconstruction between two archive entries.
   * Returns full drift report bundled with the console query envelope.
   *
   * Throws on caller bug (unknown labels) — those are programmer errors.
   */
  reconstructDriftBetween(labelA: string, labelB: string): DriftReconstructionReport {
    const drift = diffArchiveSnapshots(this.#archive, labelA, labelB);
    const canonical = canonicalSerialize({
      console_version: FORENSIC_CONSOLE_VERSION,
      query_kind: 'drift_reconstruction',
      label_a: labelA,
      label_b: labelB,
      drift_hash: drift.deterministic_hash,
    });
    return Object.freeze({
      console_version: FORENSIC_CONSOLE_VERSION,
      query_kind: 'drift_reconstruction' as const,
      label_a: labelA,
      label_b: labelB,
      drift,
      deterministic_hash: fnv1a32(canonical),
    });
  }

  /**
   * Replay continuation reconstruction: full chain audit (every entry's
   * artifact re-verified + consecutive drift).
   */
  reconstructChain(): ChainReconstructionReport {
    const audit = auditArchiveReplayChain(this.#archive);
    const canonical = canonicalSerialize({
      console_version: FORENSIC_CONSOLE_VERSION,
      query_kind: 'chain_reconstruction',
      chain_audit_hash: audit.deterministic_hash,
    });
    return Object.freeze({
      console_version: FORENSIC_CONSOLE_VERSION,
      query_kind: 'chain_reconstruction' as const,
      chain_audit: audit,
      deterministic_hash: fnv1a32(canonical),
    });
  }

  /**
   * Composite diagnostic: archive snapshot hash + chain audit hash +
   * counts. Suitable for periodic forensic health reports.
   */
  exportFullDiagnostics(): FullDiagnosticsReport {
    const snap = this.#archive.exportSnapshot();
    const audit = auditArchiveReplayChain(this.#archive);
    const canonical = canonicalSerialize({
      console_version: FORENSIC_CONSOLE_VERSION,
      query_kind: 'full_diagnostics',
      archive_snapshot_hash: snap.deterministic_hash,
      chain_audit_hash: audit.deterministic_hash,
      archive_entry_count: snap.entries.length,
      all_entries_verify_ok: audit.all_entries_verify_ok,
    });
    return Object.freeze({
      console_version: FORENSIC_CONSOLE_VERSION,
      query_kind: 'full_diagnostics' as const,
      archive_snapshot_hash: snap.deterministic_hash,
      chain_audit_hash: audit.deterministic_hash,
      archive_entry_count: snap.entries.length,
      all_entries_verify_ok: audit.all_entries_verify_ok,
      deterministic_hash: fnv1a32(canonical),
    });
  }
}
