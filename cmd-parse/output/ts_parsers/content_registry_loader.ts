/**
 * CONTENT REGISTRY LOADER — CMD4 Commit #2.
 *
 * Connects the deterministic `schema_validation_runtime` (Commit #1) to real
 * MMORPG content flow: discover `data/*.json` → load → register schemas → batch
 * validate → emit forensic exports.
 *
 * Re-uses Commit #1 primitives (NO duplicate of canonicalSerialize, FNV-1a,
 * SchemaRegistry, validateAllRegistries — single source of truth).
 *
 * GOALS:
 *   - deterministic file discovery (lex-sorted paths, no OS-dependent order)
 *   - deterministic schema registration (lex-sorted, hard-fail duplicate)
 *   - frozen immutable content map output
 *   - replay-safe validation aggregate + forensic export
 *   - injectable filesystem adapter (testability + future sharded layout)
 *
 * PURE READ-ONLY runtime (no `Date.now`, no `Math.random`, no `localeCompare`).
 * Filesystem IO is the only side effect, fully gated by `FileSystemAdapter`.
 *
 * Mục XI sharded content prep: `loadAllContent(dirPath, options?)` accepts
 * future option fields without breaking API. NOT implemented yet — clean
 * additive extension point only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ZodTypeAny } from 'zod';
import {
  SchemaRegistry,
  validateAllRegistries,
  canonicalSerialize,
  type AggregateReport,
  type AggregateBySeverity,
} from './schema_validation_runtime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Filesystem adapter (injectable)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Abstract filesystem operations used by `ContentRegistryLoader`.
 * Default impl uses `node:fs`; tests / future shard backends can swap.
 *
 * All methods are SYNC by contract — content loading happens at startup
 * boot path, no async needed. Determinism not affected by async resolution.
 */
export interface FileSystemAdapter {
  /** Returns entry names (files + dirs) in `dirPath`. Order NOT guaranteed. */
  readDir(dirPath: string): readonly string[];
  /** Returns UTF-8 file contents. Throws if not found / not readable. */
  readFile(filePath: string): string;
  /** Returns true iff `p` exists (file or dir). */
  exists(p: string): boolean;
}

/**
 * Default `FileSystemAdapter` using Node's `fs` module (sync API).
 * Use this for production. Tests should construct an in-memory adapter.
 */
export const NODE_FS_ADAPTER: FileSystemAdapter = Object.freeze({
  readDir(dirPath: string): readonly string[] {
    return [...fs.readdirSync(dirPath)];
  },
  readFile(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8');
  },
  exists(p: string): boolean {
    return fs.existsSync(p);
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// Local lex compare (mirror Commit #1 — kept private to avoid cross-import)
// ═══════════════════════════════════════════════════════════════════════════

function lexCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface ContentLoadOptions {
  /**
   * File extension to discover (default `.json`).
   */
  readonly extension?: string;
  /**
   * Sharded content prep (Mục XI) — clean additive extension point.
   * NOT implemented in Commit #2; reserved for future sharded layout
   * (e.g. `data/skills_kim.json` + `data/skills_moc.json`).
   * If provided, the loader will refuse to operate until impl ships.
   */
  readonly subDirs?: readonly string[];
}

export interface ContentValidationOptions {
  /**
   * How content file basename maps to registered schema name.
   * Default: strip extension (e.g. `items.json` → `items`).
   */
  readonly schemaNameFromFile?: (fileBase: string) => string;
  /** Forwarded to `loadAllContent`. */
  readonly load?: ContentLoadOptions;
}

/**
 * Per-file diagnostic entry in `ForensicExport.per_file`.
 * Diagnostic only — NOT part of canonical hash input.
 */
export interface ForensicPerFileEntry {
  readonly schema_name: string;
  readonly passed: boolean;
  readonly finding_count: number;
  readonly deterministic_hash: string;
}

/**
 * Frozen forensic export — replay-safe diagnostic snapshot of a full project
 * validation pass. NEVER affects `aggregate_hash` (taken from the underlying
 * `AggregateReport.deterministic_hash`).
 */
export interface ForensicExport {
  readonly aggregate_hash: string;
  readonly registry_snapshot_hash: string;
  readonly schema_count: number;
  readonly content_file_count: number;
  readonly total_findings: number;
  readonly by_severity: AggregateBySeverity;
  readonly per_file: readonly ForensicPerFileEntry[];
  readonly export_metadata: ForensicExportMetadata;
}

/**
 * Diagnostic-only metadata attached to forensic exports.
 * Mirrors `HashDebugMetadata` pattern from Commit #1.
 */
export interface ForensicExportMetadata {
  readonly canonical_length: number;
  readonly forensic_export_version: number;
}

const FORENSIC_EXPORT_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// ContentRegistryLoader
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Deterministic content file discovery + loading wrapper around an injected
 * `FileSystemAdapter`.
 *
 * Guarantees:
 *   - `discoverContentFiles(dirPath)` returns lex-sorted basenames
 *   - `loadContent(filePath)` returns parsed JSON (throws on parse error)
 *   - `loadAllContent(dirPath, options?)` returns frozen Map<basename, parsed>
 *     in lex-sorted order
 */
export class ContentRegistryLoader {
  constructor(private readonly fsAdapter: FileSystemAdapter = NODE_FS_ADAPTER) {}

  /**
   * List `.json` (or `options.extension`) basenames in `dirPath`, lex-sorted.
   * Hidden files (leading `.`) and `_test_fixture.*` are EXCLUDED from default
   * discovery — caller can override by passing explicit paths to other APIs.
   */
  discoverContentFiles(dirPath: string, options?: ContentLoadOptions): readonly string[] {
    if (options?.subDirs && options.subDirs.length > 0) {
      throw new Error(
        'content_registry_loader: subDirs sharded layout reserved for future commit',
      );
    }
    const ext = options?.extension ?? '.json';
    if (!this.fsAdapter.exists(dirPath)) {
      throw new Error(`content_registry_loader: directory not found "${dirPath}"`);
    }
    const entries = this.fsAdapter.readDir(dirPath);
    const filtered: string[] = [];
    for (const name of entries) {
      if (name.length === 0) continue;
      if (name.charAt(0) === '.') continue; // skip dotfiles
      if (name.charAt(0) === '_') continue; // skip _test_fixture, _draft, etc.
      if (!name.endsWith(ext)) continue;
      filtered.push(name);
    }
    return Object.freeze(filtered.sort(lexCompare));
  }

  /**
   * Read + JSON.parse a single file. Throws with descriptive message on
   * IO error or invalid JSON.
   */
  loadContent(filePath: string): unknown {
    let raw: string;
    try {
      raw = this.fsAdapter.readFile(filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`content_registry_loader: read failed "${filePath}": ${msg}`);
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`content_registry_loader: JSON.parse failed "${filePath}": ${msg}`);
    }
  }

  /**
   * Discover + load all content files in `dirPath`.
   * Returns frozen Map<basename, parsed> in lex-sorted insertion order.
   * Map iteration order = lex order (Map preserves insertion order in JS).
   */
  loadAllContent(dirPath: string, options?: ContentLoadOptions): ReadonlyMap<string, unknown> {
    const files = this.discoverContentFiles(dirPath, options);
    const out = new Map<string, unknown>();
    for (const fileName of files) {
      const fullPath = path.join(dirPath, fileName);
      out.set(fileName, this.loadContent(fullPath));
    }
    // JS Map is sealable but not freezable directly. Wrap in immutable view:
    return freezeMapView(out);
  }
}

/**
 * Returns a frozen read-only view of a Map. Mutating operations on the view
 * throw at runtime (TypeError). Used for content map immutability (Mục X).
 */
function freezeMapView<K, V>(source: Map<K, V>): ReadonlyMap<K, V> {
  const view: ReadonlyMap<K, V> = {
    get size(): number {
      return source.size;
    },
    get(k: K): V | undefined {
      return source.get(k);
    },
    has(k: K): boolean {
      return source.has(k);
    },
    keys(): MapIterator<K> {
      return source.keys();
    },
    values(): MapIterator<V> {
      return source.values();
    },
    entries(): MapIterator<[K, V]> {
      return source.entries();
    },
    forEach(cb: (value: V, key: K, map: ReadonlyMap<K, V>) => void): void {
      source.forEach((v, k) => cb(v, k, view));
    },
    [Symbol.iterator](): MapIterator<[K, V]> {
      return source.entries();
    },
  };
  return Object.freeze(view);
}

// ═══════════════════════════════════════════════════════════════════════════
// Schema map registration (Mục VI)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Register all entries of `schemaMap` into `registry` in lex-sorted name order.
 *
 * Determinism: same `schemaMap` (any key insertion order) → identical
 * registration sequence → identical `registry.snapshotHash()`.
 *
 * Hard fail (throws) on duplicate name — leverages Commit #1 registry guard.
 */
export function registerSchemaMap(
  registry: SchemaRegistry,
  schemaMap: Readonly<Record<string, ZodTypeAny>>,
): void {
  const names = Object.keys(schemaMap).sort(lexCompare);
  for (const name of names) {
    const schema = schemaMap[name];
    if (schema === undefined) continue; // defensive — keys from Object.keys never undefined
    registry.register(name, schema);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Project-wide validation pipeline (Mục VIII)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Default file-base → schema-name mapping: strip trailing extension.
 * `items.json` → `items`. Multi-dot bases keep all but last extension.
 *
 * Exported so downstream tools (e.g. CI pipeline orchestrator) can reuse
 * the EXACT same default — preventing drift between validation and
 * serialization key spaces.
 */
export function defaultSchemaNameFromFile(fileBase: string): string {
  const lastDot = fileBase.lastIndexOf('.');
  if (lastDot <= 0) return fileBase;
  return fileBase.substring(0, lastDot);
}

/**
 * Run the full project-wide validation pipeline:
 *   1. discover content files in `dirPath` (lex-sorted)
 *   2. load each file's parsed JSON
 *   3. build content_map keyed by schema name (basename minus extension by
 *      default; override via `options.schemaNameFromFile`)
 *   4. delegate to Commit #1 `validateAllRegistries`
 *
 * Returns frozen `AggregateReport` exactly as Commit #1 contract.
 *
 * Same inputs (dir contents + registry) → same `deterministic_hash` ALWAYS.
 */
export function validateProjectContent(
  loader: ContentRegistryLoader,
  dirPath: string,
  registry: SchemaRegistry,
  options?: ContentValidationOptions,
): AggregateReport {
  const mapper = options?.schemaNameFromFile ?? defaultSchemaNameFromFile;
  const content = loader.loadAllContent(dirPath, options?.load);
  const contentMap: Record<string, unknown> = {};
  // Defensive: detect duplicate schema names produced by a non-injective
  // `schemaNameFromFile` mapper. Without this guard, two distinct files
  // mapped to the same name would silently overwrite (last-write-wins) —
  // losing content with no validation finding. Throw on duplicate so the
  // caller surfaces the conflict instead of corrupting validation silently.
  const seenSchemaNames = new Set<string>();
  for (const [fileName, parsed] of content) {
    const schemaName = mapper(fileName);
    if (seenSchemaNames.has(schemaName)) {
      throw new Error(
        `content_registry_loader: schemaNameFromFile produced duplicate name "${schemaName}" for file "${fileName}" — non-injective mapper would silently overwrite content`,
      );
    }
    seenSchemaNames.add(schemaName);
    contentMap[schemaName] = parsed;
  }
  return validateAllRegistries(registry, contentMap);
}

// ═══════════════════════════════════════════════════════════════════════════
// Forensic export (Mục IX)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Produce a frozen forensic export from a validation `AggregateReport` and
 * the `SchemaRegistry` used to validate it.
 *
 * Contents:
 *   - `aggregate_hash` — passthrough of `aggregate.deterministic_hash`
 *   - `registry_snapshot_hash` — `registry.snapshotHash()` (lex name set)
 *   - per-file diagnostic entries (sorted by schema_name lex)
 *   - severity counts mirror aggregate
 *   - `export_metadata` diagnostic (canonical_length, forensic_export_version)
 *
 * Rule (Mục IX): `export_metadata` is diagnostic ONLY — NEVER fed back into
 * `aggregate_hash`. `aggregate_hash` remains the single source of truth for
 * replay/CI comparison.
 *
 * Returns deep-frozen object (cyclic-safe via `Object.freeze` on each leaf).
 */
export function exportForensicReport(
  aggregate: AggregateReport,
  registry: SchemaRegistry,
): ForensicExport {
  const perFile: ForensicPerFileEntry[] = [];
  for (const r of aggregate.results) {
    perFile.push(
      Object.freeze({
        schema_name: r.schema_name,
        passed: r.passed,
        finding_count: r.findings.length,
        deterministic_hash: r.deterministic_hash,
      }),
    );
  }
  // `aggregate.results` is already lex-sorted by Commit #1 contract.
  const frozenPerFile = Object.freeze(perFile);

  // canonical_length diagnostic: lex-sorted serialization length of the
  // forensic per-file table. Diagnostic ONLY.
  const canonical = canonicalSerialize(
    perFile.map((e) => [e.schema_name, e.passed, e.finding_count, e.deterministic_hash]),
  );

  const exportMetadata: ForensicExportMetadata = Object.freeze({
    canonical_length: canonical.length,
    forensic_export_version: FORENSIC_EXPORT_VERSION,
  });

  const bySev: AggregateBySeverity = Object.freeze({
    error: aggregate.by_severity.error,
    warning: aggregate.by_severity.warning,
    info: aggregate.by_severity.info,
  });

  return Object.freeze({
    aggregate_hash: aggregate.deterministic_hash,
    registry_snapshot_hash: registry.snapshotHash(),
    schema_count: aggregate.total_schemas,
    content_file_count: aggregate.results.length,
    total_findings: aggregate.total_findings,
    by_severity: bySev,
    per_file: frozenPerFile,
    export_metadata: exportMetadata,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Replay-safe hash summary (Mục IV #7)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bundle of replay-safe hashes produced from a project validation pass.
 *
 * Use case: CI comparison between branches, replay archive identity check,
 * cross-runtime forensic diff. All fields deterministic across runs.
 */
export interface ReplaySafeHashSummary {
  readonly aggregate_hash: string;
  readonly registry_snapshot_hash: string;
  /** Map<schema_name, deterministic_hash> — frozen view. */
  readonly per_file_hashes: ReadonlyMap<string, string>;
  readonly forensic_export_version: number;
}

/**
 * Generate the canonical replay-safe hash bundle for CI / replay diff.
 * All hashes flow from Commit #1 contract — em does NOT recompute, only
 * collect into a single immutable summary.
 */
export function generateReplaySafeHashes(
  aggregate: AggregateReport,
  registry: SchemaRegistry,
): ReplaySafeHashSummary {
  const perFile = new Map<string, string>();
  for (const r of aggregate.results) {
    perFile.set(r.schema_name, r.deterministic_hash);
  }
  return Object.freeze({
    aggregate_hash: aggregate.deterministic_hash,
    registry_snapshot_hash: registry.snapshotHash(),
    per_file_hashes: freezeMapView(perFile),
    forensic_export_version: FORENSIC_EXPORT_VERSION,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Re-export Commit #1 types caller may need (no rewrap)
// ═══════════════════════════════════════════════════════════════════════════

export type { AggregateReport, ValidationResult } from './schema_validation_runtime.js';

// ─── Helper canonical-hash check (utility — Mục VIII verify) ───

/**
 * Quick replay-safety check: validate the same content_map twice and assert
 * `deterministic_hash` is identical. Useful in CI integration tests.
 *
 * Throws if hashes diverge — indicates a determinism regression somewhere.
 */
export function assertReplayStable(
  loader: ContentRegistryLoader,
  dirPath: string,
  registry: SchemaRegistry,
  options?: ContentValidationOptions,
): { readonly hash: string; readonly stable: true } {
  const r1 = validateProjectContent(loader, dirPath, registry, options);
  const r2 = validateProjectContent(loader, dirPath, registry, options);
  if (r1.deterministic_hash !== r2.deterministic_hash) {
    throw new Error(
      `content_registry_loader: replay stability check FAILED — ` +
        `${r1.deterministic_hash} ≠ ${r2.deterministic_hash}`,
    );
  }
  return Object.freeze({ hash: r1.deterministic_hash, stable: true as const });
}
