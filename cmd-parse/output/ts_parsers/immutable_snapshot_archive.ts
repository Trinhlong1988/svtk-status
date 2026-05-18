/**
 * IMMUTABLE SNAPSHOT ARCHIVE — CMD4 Phase 15 Module 3.
 *
 * Long-term replay/export archive infrastructure. Append-only, frozen,
 * canonically indexed. Replay-safe metadata isolation — caller-supplied
 * metadata MUST NEVER affect replay or archive entry hash.
 *
 * Brief v15 §M3 responsibilities:
 *   1. immutable replay archives (append-only, frozen, no mutation API)
 *   2. canonical archive indexing (lex-sorted, deterministic)
 *   3. replay-safe archive retrieval (frozen views, same call → same bytes)
 *   4. migration-safe archive metadata (archive_version field for migration)
 *   5. deterministic forensic restoration (full archive serializable + hash)
 *
 * CRITICAL RULE (brief v15 §M3):
 *   archive metadata MUST NEVER affect replay hash.
 *   `entry_hash` is computed WITHOUT metadata so the archive can hold
 *   metadata for forensic linkage without leaking into replay verification.
 *
 * ── HASH COLLISION POLICY ────────────────────────────────────────────────
 *   All archive hashes (entry_hash / index_hash / snapshot.deterministic_hash)
 *   use FNV-1a 32-bit (~4.29 billion namespace). Per Phase 12 design this
 *   is sufficient for deterministic identity at MMORPG tooling scale, NOT
 *   cryptographic collision-resistance. Callers needing cryptographic
 *   identity (signed releases, anti-tamper auditing) should layer a wider
 *   hash (e.g. SHA-256) over `snapshot.deterministic_hash` externally —
 *   the archive's deterministic chain remains the source of truth for
 *   identity; external crypto layers extend trust, not replace it.
 *
 *   Birthday-paradox collision probability becomes non-negligible (~50%)
 *   at ~77,000 distinct hashes in a 32-bit space; archive operators who
 *   expect long-lived multi-million-entry archives should monitor this.
 *
 * In-memory deterministic ONLY — no IO, no Date.now, no Math.random,
 * no localeCompare, no insertion-order dependence.
 *
 * Ownership: tooling/validator/forensic/export layer (brief v15 §III).
 */
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';
import type { ExportArtifact } from './deterministic_export_pipeline.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const IMMUTABLE_SNAPSHOT_ARCHIVE_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

/** Metadata value kinds — INT-only, no float, no objects. */
export type ArchiveMetadataValue = string | number | boolean;

export interface ArchiveEntry {
  readonly ordinal: number;
  readonly label: string;
  readonly artifact: ExportArtifact;
  /** Optional caller metadata. Frozen. NEVER feeds into entry_hash. */
  readonly metadata: Readonly<Record<string, ArchiveMetadataValue>>;
  /**
   * FNV-1a hash over (ordinal, label, artifact.deterministic_hash) — replay-key.
   * Excludes metadata by design.
   */
  readonly entry_hash: string;
}

/** Index row by label — lex-sorted by label. */
export interface IndexByLabel {
  readonly label: string;
  readonly ordinal: number;
  readonly artifact_hash: string;
  readonly entry_hash: string;
}

/** Index row by artifact_hash — lex-sorted by artifact_hash. */
export interface IndexByArtifactHash {
  readonly artifact_hash: string;
  readonly labels: readonly string[]; // lex-sorted
}

export interface ArchiveIndex {
  readonly archive_version: number;
  readonly entry_count: number;
  /** Lex-sorted by label. */
  readonly by_label: readonly IndexByLabel[];
  /** Lex-sorted by artifact_hash. Each row's labels are lex-sorted too. */
  readonly by_artifact_hash: readonly IndexByArtifactHash[];
  readonly deterministic_hash: string;
}

export interface ArchiveSnapshot {
  readonly archive_version: number;
  /** Ordinal-sorted. */
  readonly entries: readonly ArchiveEntry[];
  readonly index: ArchiveIndex;
  /** FNV-1a of canonical (version, entries[*entry_hash], index.deterministic_hash). */
  readonly deterministic_hash: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers — direct-codepoint compare
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

function computeEntryHash(
  ordinal: number,
  label: string,
  artifactHash: string,
): string {
  return fnv1a32(
    canonicalSerialize({ ordinal, label, artifact_hash: artifactHash }),
  );
}

function freezeMetadata(
  md: Record<string, ArchiveMetadataValue> | undefined,
): Readonly<Record<string, ArchiveMetadataValue>> {
  if (md === undefined) return Object.freeze({});
  // Defensive copy — caller's mutation post-append cannot leak in.
  const copy: Record<string, ArchiveMetadataValue> = {};
  for (const k of Object.keys(md).sort(lexCompare)) {
    const v = md[k]!;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new Error(
        `immutable_snapshot_archive: metadata value at "${k}" must be string|number|boolean`,
      );
    }
    if (typeof v === 'number' && !Number.isInteger(v)) {
      throw new Error(
        `immutable_snapshot_archive: metadata number at "${k}" must be integer (float forbidden)`,
      );
    }
    copy[k] = v;
  }
  return Object.freeze(copy);
}

// ═══════════════════════════════════════════════════════════════════════════
// Index builder — pure, deterministic
// ═══════════════════════════════════════════════════════════════════════════

function buildIndex(entries: readonly ArchiveEntry[]): ArchiveIndex {
  const byLabel: IndexByLabel[] = entries.map((e) => ({
    label: e.label,
    ordinal: e.ordinal,
    artifact_hash: e.artifact.deterministic_hash,
    entry_hash: e.entry_hash,
  }));
  byLabel.sort((a, b) => lexCompare(a.label, b.label));
  const frozenByLabel = Object.freeze(byLabel.map((r) => Object.freeze(r)));

  // Group by artifact_hash → lex-sorted labels.
  const groupMap = new Map<string, string[]>();
  for (const e of entries) {
    const k = e.artifact.deterministic_hash;
    let list = groupMap.get(k);
    if (!list) {
      list = [];
      groupMap.set(k, list);
    }
    list.push(e.label);
  }
  const byHash: IndexByArtifactHash[] = [];
  for (const [h, labels] of groupMap) {
    const sortedLabels = [...labels].sort(lexCompare);
    byHash.push({ artifact_hash: h, labels: Object.freeze(sortedLabels) });
  }
  byHash.sort((a, b) => lexCompare(a.artifact_hash, b.artifact_hash));
  const frozenByHash = Object.freeze(byHash.map((r) => Object.freeze(r)));

  const canonical = canonicalSerialize({
    archive_version: IMMUTABLE_SNAPSHOT_ARCHIVE_VERSION,
    entry_count: entries.length,
    by_label: frozenByLabel.map((r) => ({
      label: r.label,
      ordinal: r.ordinal,
      artifact_hash: r.artifact_hash,
      entry_hash: r.entry_hash,
    })),
    by_artifact_hash: frozenByHash.map((r) => ({
      artifact_hash: r.artifact_hash,
      labels: r.labels,
    })),
  });

  return Object.freeze({
    archive_version: IMMUTABLE_SNAPSHOT_ARCHIVE_VERSION,
    entry_count: entries.length,
    by_label: frozenByLabel,
    by_artifact_hash: frozenByHash,
    deterministic_hash: fnv1a32(canonical),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ImmutableSnapshotArchive — append-only with canonical index
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Append-only archive. Caller manages logical clock (ordinal, strict monotonic
 * INT). Same sequence of `append` calls → same archive bytes ALWAYS.
 *
 * Labels MUST be globally unique within the archive (caller bug otherwise).
 */
export class ImmutableSnapshotArchive {
  private readonly entries: ArchiveEntry[] = [];
  /** O(1) label → entry index (also acts as the label-uniqueness Set). */
  private readonly byLabel = new Map<string, ArchiveEntry>();
  /** O(1) artifact_hash → entries — entries within each bucket appended in insertion order. */
  private readonly byArtifactHash = new Map<string, ArchiveEntry[]>();
  private lastOrdinal: number | null = null;

  append(
    ordinal: number,
    label: string,
    artifact: ExportArtifact,
    metadata?: Record<string, ArchiveMetadataValue>,
  ): void {
    if (!Number.isSafeInteger(ordinal)) {
      // `Number.isSafeInteger` (stricter than `isInteger`) rejects values
      // outside ±(2^53 − 1). Beyond that range JS float64 representation
      // silently loses precision — two distinct "ordinals" could compare
      // equal, breaking monotonicity and replay determinism. Reject up-front.
      throw new Error(
        `immutable_snapshot_archive: ordinal must be safe integer (|ordinal| < 2^53), got ${String(ordinal)}`,
      );
    }
    if (this.lastOrdinal !== null && ordinal <= this.lastOrdinal) {
      throw new Error(
        `immutable_snapshot_archive: ordinal must be strictly monotonic (last=${String(this.lastOrdinal)}, got=${String(ordinal)})`,
      );
    }
    if (typeof label !== 'string' || label.length === 0) {
      throw new Error('immutable_snapshot_archive: label must be non-empty string');
    }
    if (this.byLabel.has(label)) {
      throw new Error(`immutable_snapshot_archive: duplicate label "${label}"`);
    }
    const md = freezeMetadata(metadata);
    const entry: ArchiveEntry = Object.freeze({
      ordinal,
      label,
      artifact,
      metadata: md,
      entry_hash: computeEntryHash(ordinal, label, artifact.deterministic_hash),
    });
    this.entries.push(entry);
    this.byLabel.set(label, entry);
    const hashKey = artifact.deterministic_hash;
    let bucket = this.byArtifactHash.get(hashKey);
    if (bucket === undefined) {
      bucket = [];
      this.byArtifactHash.set(hashKey, bucket);
    }
    bucket.push(entry);
    this.lastOrdinal = ordinal;
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * O(1) accessor for the most recently appended entry (largest ordinal).
   * Returns undefined if archive is empty. Cheap read — no index rebuild.
   */
  latestEntry(): ArchiveEntry | undefined {
    if (this.entries.length === 0) return undefined;
    return this.entries[this.entries.length - 1];
  }

  /**
   * O(1) frozen view of all entries in ordinal-insertion order. Cheap read
   * — no index rebuild. Used by chain audit / regression consumers that
   * need to iterate entries without the cost of `exportSnapshot()`.
   */
  allEntries(): readonly ArchiveEntry[] {
    return Object.freeze([...this.entries]);
  }

  /**
   * O(1) lookup by label via internal Map index. Returns frozen entry or
   * undefined. Pure — no side effects, no mutation.
   */
  lookupByLabel(label: string): ArchiveEntry | undefined {
    return this.byLabel.get(label);
  }

  /**
   * O(K log K) lookup by artifact deterministic_hash where K is the number
   * of matching entries (typically small). Uses an internal hash-bucket
   * map — no full archive scan. Returns frozen list (may be empty),
   * lex-sorted by label for deterministic order.
   */
  lookupByArtifactHash(artifactHash: string): readonly ArchiveEntry[] {
    const bucket = this.byArtifactHash.get(artifactHash);
    if (bucket === undefined) return Object.freeze([] as ArchiveEntry[]);
    const out = [...bucket];
    out.sort((a, b) => lexCompare(a.label, b.label));
    return Object.freeze(out);
  }

  /**
   * Build current index. Pure — same archive state → same index bytes.
   * Index excludes metadata by design (replay-safe).
   */
  exportIndex(): ArchiveIndex {
    return buildIndex(this.entries);
  }

  /**
   * Full frozen snapshot of archive. Used for forensic restoration / wire
   * export. Same state → same `deterministic_hash` ALWAYS.
   */
  exportSnapshot(): ArchiveSnapshot {
    const index = this.exportIndex();
    const frozenEntries = Object.freeze(this.entries.map((e) => e));
    // Note: each entry is already frozen at append time.
    const canonical = canonicalSerialize({
      archive_version: IMMUTABLE_SNAPSHOT_ARCHIVE_VERSION,
      // Entries are already ordinal-sorted because append is strictly
      // monotonic. Snapshot reflects insertion order = ordinal order.
      entry_hashes: frozenEntries.map((e) => e.entry_hash),
      index_hash: index.deterministic_hash,
    });
    return Object.freeze({
      archive_version: IMMUTABLE_SNAPSHOT_ARCHIVE_VERSION,
      entries: frozenEntries,
      index,
      deterministic_hash: fnv1a32(canonical),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Restoration helpers — pure, deterministic
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verify an `ArchiveEntry`'s `entry_hash` recomputes from its public fields
 * (excluding metadata). Used for forensic integrity checks.
 */
export function verifyArchiveEntryHash(entry: ArchiveEntry): boolean {
  return (
    entry.entry_hash ===
    computeEntryHash(entry.ordinal, entry.label, entry.artifact.deterministic_hash)
  );
}

/** Result of `verifyArchiveSnapshot` — frozen, deterministic. */
export interface ArchiveVerifyResult {
  readonly ok: boolean;
  readonly version_match: boolean;
  readonly ordinal_monotonic: boolean;
  readonly labels_unique: boolean;
  readonly all_entry_hashes_valid: boolean;
  readonly index_recompute_match: boolean;
  readonly top_hash_recompute_match: boolean;
  readonly first_bad_label: string | null;
}

/**
 * Verify a full `ArchiveSnapshot`:
 *   - archive_version matches
 *   - entries are strictly monotonic by ordinal
 *   - labels unique
 *   - every entry_hash valid
 *   - index recomputes correctly
 *   - top-level deterministic_hash recomputes
 *
 * Returns frozen `ArchiveVerifyResult`. Same input → same bytes.
 */
export function verifyArchiveSnapshot(snapshot: ArchiveSnapshot): ArchiveVerifyResult {
  const versionMatch = snapshot.archive_version === IMMUTABLE_SNAPSHOT_ARCHIVE_VERSION;

  // Bug #27 fix: verify is the trust boundary for snapshots that didn't pass
  // through `ImmutableSnapshotArchive.append` (e.g. deserialized externally).
  // Without per-entry isSafeInteger, a single-entry snapshot with NaN ordinal
  // slips past the monotonic check (intCompare(NaN, null)=0 first time) and a
  // matching fabricated entry_hash would pass ok=true. Re-enforce strict
  // safe-int upfront at the boundary.
  let allOrdinalsSafe = true;
  for (const e of snapshot.entries) {
    if (!Number.isSafeInteger(e.ordinal)) {
      allOrdinalsSafe = false;
      break;
    }
  }

  let monotonic = true;
  let lastOrd: number | null = null;
  for (const e of snapshot.entries) {
    if (lastOrd !== null && intCompare(e.ordinal, lastOrd) <= 0) {
      monotonic = false;
      break;
    }
    lastOrd = e.ordinal;
  }

  const labelSet = new Set<string>();
  let unique = true;
  for (const e of snapshot.entries) {
    if (labelSet.has(e.label)) {
      unique = false;
      break;
    }
    labelSet.add(e.label);
  }

  let firstBad: string | null = null;
  let allHashesValid = true;
  for (const e of snapshot.entries) {
    if (!verifyArchiveEntryHash(e)) {
      allHashesValid = false;
      firstBad = e.label;
      break;
    }
  }

  const rebuiltIndex = buildIndex(snapshot.entries);
  const indexMatch = rebuiltIndex.deterministic_hash === snapshot.index.deterministic_hash;

  const recomputedTop = fnv1a32(
    canonicalSerialize({
      archive_version: IMMUTABLE_SNAPSHOT_ARCHIVE_VERSION,
      entry_hashes: snapshot.entries.map((e) => e.entry_hash),
      index_hash: rebuiltIndex.deterministic_hash,
    }),
  );
  const topMatch = recomputedTop === snapshot.deterministic_hash;

  return Object.freeze({
    ok: versionMatch && allOrdinalsSafe && monotonic && unique && allHashesValid && indexMatch && topMatch,
    version_match: versionMatch,
    ordinal_monotonic: monotonic,
    labels_unique: unique,
    all_entry_hashes_valid: allHashesValid,
    index_recompute_match: indexMatch,
    top_hash_recompute_match: topMatch,
    first_bad_label: firstBad,
  });
}
