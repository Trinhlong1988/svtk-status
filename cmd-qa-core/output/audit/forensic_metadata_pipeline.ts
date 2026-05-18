/**
 * FORENSIC METADATA PIPELINE — CMD4 Phase 13 Module 4.
 *
 * Operational forensic metadata infrastructure — replay-linked metadata,
 * divergence timeline, audit trace export.
 *
 * Brief v12 §TASK 3 responsibilities:
 *   1. replay-linked metadata (bind to ExportArtifact via artifact_hash)
 *   2. deterministic forensic export (canonical serialize + own hash)
 *   3. divergence timeline metadata (ordered entries)
 *   4. operational audit metadata (kind tags + detail)
 *   5. validation trace export (deterministic JSON wire format)
 *
 * ★ CRITICAL RULE (brief v12 §TASK 3) ★
 *   metadata MUST NEVER affect:
 *     - replay checksum (ExportArtifact.deterministic_hash unchanged)
 *     - gameplay determinism
 *     - canonical export integrity
 *
 * Em achieve this by binding metadata via `artifact_hash` POINTER ONLY —
 * the ExportArtifact itself is read-only consumed, never mutated.
 *
 * Pure read-only producer. No I/O, no wall-clock, no Math.random,
 * no localeCompare. Same input → same metadata pipeline ALWAYS.
 *
 * Ownership: tooling/forensic layer (brief v12 §III).
 */
import { z } from 'zod';
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';
import type { ExportArtifact } from './deterministic_export_pipeline.js';
import { auditArtifactRegistryDrift } from './registry_diff_audit.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const FORENSIC_METADATA_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export const METADATA_ENTRY_KINDS = [
  'validation_pass',
  'validation_fail',
  'divergence_detected',
  'audit_trace',
  'replay_link',
] as const;
export type MetadataEntryKind = (typeof METADATA_ENTRY_KINDS)[number];

export interface ForensicMetadataEntry {
  /** Deterministic sequence ordinal (0-indexed, monotonic). */
  readonly ordinal: number;
  readonly kind: MetadataEntryKind;
  /** Linked artifact's deterministic_hash (POINTER, not embedded copy). */
  readonly artifact_hash: string;
  /** Optional per-schema scope (empty string for pipeline-wide entries). */
  readonly schema_name: string;
  readonly detail: string;
}

export interface ForensicMetadataPipeline {
  readonly metadata_version: number;
  /** Primary artifact this metadata pipeline describes. */
  readonly primary_artifact_hash: string;
  readonly entries: readonly ForensicMetadataEntry[];
  /** Deterministic hash of metadata (NOT a replacement for artifact hash). */
  readonly timeline_hash: string;
  /** Length of canonical metadata string (forensic preflight). */
  readonly canonical_byte_length: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function canonicalEntryTuple(e: ForensicMetadataEntry): readonly (string | number)[] {
  return [e.ordinal, e.kind, e.artifact_hash, e.schema_name, e.detail];
}

function canonicalPipelineNoLength(p: Omit<ForensicMetadataPipeline, 'timeline_hash' | 'canonical_byte_length'>): string {
  return canonicalSerialize({
    metadata_version: p.metadata_version,
    primary_artifact_hash: p.primary_artifact_hash,
    entries: p.entries.map(canonicalEntryTuple),
  });
}

function canonicalPipelineWithLength(p: Omit<ForensicMetadataPipeline, 'timeline_hash'>): string {
  return canonicalSerialize({
    metadata_version: p.metadata_version,
    primary_artifact_hash: p.primary_artifact_hash,
    entries: p.entries.map(canonicalEntryTuple),
    canonical_byte_length: p.canonical_byte_length,
  });
}

function freezeEntries(entries: ForensicMetadataEntry[]): readonly ForensicMetadataEntry[] {
  for (const e of entries) Object.freeze(e);
  return Object.freeze(entries);
}

function buildPipeline(
  primaryArtifactHash: string,
  entries: ForensicMetadataEntry[],
): ForensicMetadataPipeline {
  const frozenEntries = freezeEntries(entries);
  const partialNoLength = {
    metadata_version: FORENSIC_METADATA_VERSION,
    primary_artifact_hash: primaryArtifactHash,
    entries: frozenEntries,
  };
  const canonicalByteLength = canonicalPipelineNoLength(partialNoLength).length;
  const partialWithLength = { ...partialNoLength, canonical_byte_length: canonicalByteLength };
  const timelineHash = fnv1a32(canonicalPipelineWithLength(partialWithLength));
  return Object.freeze({
    ...partialWithLength,
    timeline_hash: timelineHash,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — createForensicMetadata
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a fresh metadata pipeline bound to an `ExportArtifact`.
 *
 * Adds a single `replay_link` entry pointing to the artifact's
 * deterministic_hash. Caller can append more entries via
 * `withAppendedEntries` (im-mutable update returning new pipeline).
 */
export function createForensicMetadata(artifact: ExportArtifact): ForensicMetadataPipeline {
  const entries: ForensicMetadataEntry[] = [
    {
      ordinal: 0,
      kind: 'replay_link',
      artifact_hash: artifact.deterministic_hash,
      schema_name: '',
      detail: `bound to artifact v${String(artifact.artifact_version)} content_count=${String(artifact.artifact_content_count)}`,
    },
  ];
  return buildPipeline(artifact.deterministic_hash, entries);
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — withAppendedEntries (immutable update)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Append new entries to an existing pipeline. Returns a NEW frozen pipeline
 * with deterministically-incremented ordinals. Original pipeline untouched
 * (immutability invariant).
 *
 * Caller passes partial entries without `ordinal` — em assign sequentially
 * starting from `pipeline.entries.length`.
 */
export function withAppendedEntries(
  pipeline: ForensicMetadataPipeline,
  newEntries: readonly Omit<ForensicMetadataEntry, 'ordinal'>[],
): ForensicMetadataPipeline {
  const combined: ForensicMetadataEntry[] = [];
  for (const e of pipeline.entries) combined.push({ ...e });
  let nextOrdinal = pipeline.entries.length;
  for (const e of newEntries) {
    combined.push({
      ordinal: nextOrdinal,
      kind: e.kind,
      artifact_hash: e.artifact_hash,
      schema_name: e.schema_name,
      detail: e.detail,
    });
    nextOrdinal++;
  }
  return buildPipeline(pipeline.primary_artifact_hash, combined);
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — appendDivergenceTrace (composable with Module 3)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run `auditArtifactRegistryDrift(baseline, current)` and append each
 * drift entry as a `divergence_detected` metadata entry on the pipeline.
 *
 * Returns new frozen pipeline. Drift entries appended in deterministic
 * lex order (kind, schema_name) per Module 3 contract.
 */
export function appendDivergenceTrace(
  pipeline: ForensicMetadataPipeline,
  baseline: ExportArtifact,
  current: ExportArtifact,
): ForensicMetadataPipeline {
  const drift = auditArtifactRegistryDrift(baseline, current);
  const newEntries: Omit<ForensicMetadataEntry, 'ordinal'>[] = drift.drift_entries.map((d) => ({
    kind: 'divergence_detected' as const,
    artifact_hash: current.deterministic_hash,
    schema_name: d.schema_name,
    detail: `${d.kind}: ${d.detail}`,
  }));
  return withAppendedEntries(pipeline, newEntries);
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — appendAuditTrace (validation tracing)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Append a validation audit trace entry. Use for recording validation
 * outcomes per schema (e.g. "items.json validated, 0 findings").
 */
export function appendAuditTrace(
  pipeline: ForensicMetadataPipeline,
  artifact: ExportArtifact,
  schemaName: string,
  passed: boolean,
  detail: string,
): ForensicMetadataPipeline {
  const kind: MetadataEntryKind = passed ? 'validation_pass' : 'validation_fail';
  return withAppendedEntries(pipeline, [
    {
      kind,
      artifact_hash: artifact.deterministic_hash,
      schema_name: schemaName,
      detail,
    },
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════
// Wire format — serialize / deserialize
// ═══════════════════════════════════════════════════════════════════════════

const ForensicEntrySchema = z
  .object({
    ordinal: z.number().int().nonnegative(),
    kind: z.enum(METADATA_ENTRY_KINDS),
    artifact_hash: z.string().regex(/^[0-9a-f]{8}$/),
    schema_name: z.string(),
    detail: z.string(),
  })
  .strict();

const ForensicPipelineSchema = z
  .object({
    metadata_version: z.literal(FORENSIC_METADATA_VERSION),
    primary_artifact_hash: z.string().regex(/^[0-9a-f]{8}$/),
    entries: z.array(ForensicEntrySchema),
    canonical_byte_length: z.number().int().nonnegative(),
    timeline_hash: z.string().regex(/^[0-9a-f]{8}$/),
  })
  .strict();

/**
 * Serialize metadata pipeline to canonical JSON wire format.
 * Same pipeline → byte-identical JSON ALWAYS.
 */
export function serializeMetadata(pipeline: ForensicMetadataPipeline): string {
  return canonicalSerialize({
    metadata_version: pipeline.metadata_version,
    primary_artifact_hash: pipeline.primary_artifact_hash,
    entries: pipeline.entries.map((e) => ({
      ordinal: e.ordinal,
      kind: e.kind,
      artifact_hash: e.artifact_hash,
      schema_name: e.schema_name,
      detail: e.detail,
    })),
    canonical_byte_length: pipeline.canonical_byte_length,
    timeline_hash: pipeline.timeline_hash,
  });
}

/**
 * Parse + Zod-validate + freeze metadata pipeline from JSON.
 * Throws on parse / schema mismatch / unsupported version.
 *
 * Float contamination rejected via `z.number().int()` (ordinal +
 * canonical_byte_length).
 */
export function deserializeMetadata(json: string): ForensicMetadataPipeline {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`forensic_metadata_pipeline: invalid JSON: ${msg}`);
  }
  const parsed = ForensicPipelineSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first ? first.path.join('.') : '<root>';
    const msg = first ? first.message : 'unknown';
    throw new Error(`forensic_metadata_pipeline: schema reject at "${path}": ${msg}`);
  }
  // Enforce ordinal contract: 0-indexed, strictly monotonic (entries[i].ordinal === i).
  // Schema only checks nonnegative-int; without this guard a malformed wire payload
  // (e.g. duplicate or skipped ordinals) would silently pass, then collide when
  // a later withAppendedEntries() uses entries.length to assign the next ordinal.
  for (let i = 0; i < parsed.data.entries.length; i++) {
    const entry = parsed.data.entries[i]!;
    if (entry.ordinal !== i) {
      throw new Error(
        `forensic_metadata_pipeline: ordinal contract violated at index ${String(i)}: expected ${String(i)}, got ${String(entry.ordinal)}`,
      );
    }
  }
  const entries = parsed.data.entries.map((e) => Object.freeze({ ...e }));
  return Object.freeze({
    metadata_version: parsed.data.metadata_version,
    primary_artifact_hash: parsed.data.primary_artifact_hash,
    entries: Object.freeze(entries),
    canonical_byte_length: parsed.data.canonical_byte_length,
    timeline_hash: parsed.data.timeline_hash,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Verify (re-compute timeline_hash from canonical)
// ═══════════════════════════════════════════════════════════════════════════

export interface MetadataVerifyResult {
  readonly ok: boolean;
  readonly canonical_byte_length_match: boolean;
  readonly timeline_hash_match: boolean;
  /** Confirms metadata-vs-artifact pointer integrity. */
  readonly primary_artifact_hash_format_ok: boolean;
}

/**
 * Re-compute timeline_hash + canonical_byte_length from the metadata
 * pipeline fields and compare with stored values. Verifies metadata
 * integrity without touching the artifact em pointer at.
 *
 * Returns frozen result. Pure — NO throws.
 */
export function verifyForensicMetadata(pipeline: ForensicMetadataPipeline): MetadataVerifyResult {
  const partialNoLength = {
    metadata_version: pipeline.metadata_version,
    primary_artifact_hash: pipeline.primary_artifact_hash,
    entries: pipeline.entries,
  };
  const recomputedLength = canonicalPipelineNoLength(partialNoLength).length;
  const lengthMatch = recomputedLength === pipeline.canonical_byte_length;

  const partialWithLength = { ...partialNoLength, canonical_byte_length: pipeline.canonical_byte_length };
  const recomputedHash = fnv1a32(canonicalPipelineWithLength(partialWithLength));
  const hashMatch = recomputedHash === pipeline.timeline_hash;

  const formatOk = /^[0-9a-f]{8}$/.test(pipeline.primary_artifact_hash);

  return Object.freeze({
    ok: lengthMatch && hashMatch && formatOk,
    canonical_byte_length_match: lengthMatch,
    timeline_hash_match: hashMatch,
    primary_artifact_hash_format_ok: formatOk,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// One-way flow guard (Mục v11 §IMPORTANT ARCHITECTURE RULE)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Assert that the metadata pipeline points to but does NOT contain the
 * artifact (no embedded copy). Returns true if the contract is honored.
 *
 * This is a STRUCTURAL guard — em scan entries to ensure no entry
 * contains an `artifact_hash` field that doesn't match the format.
 */
export function assertOneWayFlow(pipeline: ForensicMetadataPipeline): { readonly ok: true } {
  // Pipeline only stores `artifact_hash` strings — never the artifact object
  // itself. By TS type system this is enforced at compile time.
  // Em do a runtime sanity check on format.
  for (const e of pipeline.entries) {
    if (!/^[0-9a-f]{8}$/.test(e.artifact_hash)) {
      throw new Error(
        `forensic_metadata_pipeline: entry ordinal=${String(e.ordinal)} has invalid artifact_hash format "${e.artifact_hash}"`,
      );
    }
  }
  return Object.freeze({ ok: true });
}
