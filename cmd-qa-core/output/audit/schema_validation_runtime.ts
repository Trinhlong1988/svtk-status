/**
 * SCHEMA VALIDATION RUNTIME — CMD4 Commit #1 (hardening pass v2).
 *
 * Central deterministic Zod schema registry + validation reporting cho SVTK
 * content layer (`data/*.json`) và mọi loader pipeline downstream.
 *
 * GOALS:
 *   - register references tới Zod schema rải rác (NO mutation existing schema)
 *   - validate raw content vs registered schema
 *   - enforce R30/R31 INT-only data lock: `typeof === 'number' && !isInteger`
 *     → finding kind `float_in_data`
 *   - deterministic finding ordering: severity ENUM → schema_name lex → path lex
 *   - canonical FNV-1a 32-bit hash cho replay invariant + CI diff
 *   - deep-frozen immutable result (cyclic-safe via WeakSet)
 *   - reversible escaped path segments (keys containing `.` or `\` safe)
 *   - hash forensic metadata (diagnostic ONLY — NOT in canonical hash input)
 *
 * PURE READ-ONLY — no mutation of registered schemas, no mutation of input,
 * no I/O, no `Date.now`, no `Math.random`, no `localeCompare`.
 * Same input → same output ALWAYS.
 *
 * Path convention: dot-notation with backslash escaping.
 *   - `\\`  → literal `\` in segment
 *   - `\.`  → literal `.` in segment
 *   - segments joined by `.`
 *   - empty path string (`""`) = root
 *
 * Strict schema policy (Mục IX):
 *   - undefined values OMITTED from canonical form
 *   - null values PRESERVED (and passed to Zod for accept/reject decision)
 *   - optional absent allowed (Zod `.optional()`)
 *   - unknown keys REJECTED (use Zod `.strict()` at schema definition site)
 *   - `_doc` documentation key whitelisted only via explicit schema extension
 */
import type { ZodTypeAny, ZodIssue } from 'zod';

// ═══════════════════════════════════════════════════════════════════════════
// Severity ENUM (fixed integer order — NEVER string locale compare)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fixed severity ordinal. Lower = more severe. Used for deterministic sort.
 * DO NOT compare by string label.
 */
export const SEVERITY = Object.freeze({
  ERROR: 0,
  WARNING: 1,
  INFO: 2,
} as const);

export type Severity = (typeof SEVERITY)[keyof typeof SEVERITY];

// ═══════════════════════════════════════════════════════════════════════════
// Finding kinds
// ═══════════════════════════════════════════════════════════════════════════

export const FINDING_KINDS = [
  'schema_error', // Zod validation rejected the payload
  'float_in_data', // R30/R31 violation: non-integer number leaf in raw data
  'unknown_schema', // validateRegistry called with a name not registered
] as const;

export type FindingKind = (typeof FINDING_KINDS)[number];

// ═══════════════════════════════════════════════════════════════════════════
// Public result types — all `readonly`, all deep-frozen at runtime
// ═══════════════════════════════════════════════════════════════════════════

export interface ValidationFinding {
  readonly severity: Severity;
  readonly schema_name: string;
  /** Dot-notation path with backslash escaping; see `joinPath` / `splitPath`. */
  readonly path: string;
  readonly kind: FindingKind;
  readonly message: string;
}

/**
 * Diagnostic-only metadata. NEVER participates in `deterministic_hash`.
 * Production debugging aid for hash mismatch forensics.
 */
export interface HashDebugMetadata {
  readonly finding_count: number;
  readonly schema_count: number;
  readonly canonical_length: number;
  readonly registry_order_hash: string;
}

export interface ValidationResult {
  readonly schema_name: string;
  readonly passed: boolean;
  readonly findings: readonly ValidationFinding[];
  readonly deterministic_hash: string;
  readonly hash_debug_metadata: HashDebugMetadata;
}

export interface AggregateBySeverity {
  readonly error: number;
  readonly warning: number;
  readonly info: number;
}

export interface AggregateReport {
  readonly passed: boolean;
  readonly total_schemas: number;
  readonly total_findings: number;
  readonly by_severity: AggregateBySeverity;
  readonly results: readonly ValidationResult[];
  readonly deterministic_hash: string;
  readonly hash_debug_metadata: HashDebugMetadata;
}

// ═══════════════════════════════════════════════════════════════════════════
// FNV-1a 32-bit hash — cross-platform deterministic (no float math)
// ═══════════════════════════════════════════════════════════════════════════

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Deterministic 32-bit FNV-1a hash → 8-char lower-hex.
 *
 * ASCII-safe inputs (canonical serialization output). `Math.imul` ensures
 * INT32 multiplication on all platforms (Node x64 / ARM / Unity Mono).
 */
export function fnv1a32(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ═══════════════════════════════════════════════════════════════════════════
// Lex compare — DIRECT Unicode codepoint (cross-platform deterministic).
// FORBIDDEN: `localeCompare` (depends on host locale, drift Win/Linux/Mac).
// ═══════════════════════════════════════════════════════════════════════════

function lexCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Path escaping (reversible)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Escape a single path segment: `\` → `\\`, `.` → `\.`.
 * Use to safely embed keys containing `.` or `\` in dot-joined paths.
 */
export function escapeSegment(segment: string): string {
  // Backslash first (order matters) to prevent re-escaping of replacement.
  return segment.replace(/\\/g, '\\\\').replace(/\./g, '\\.');
}

/**
 * Unescape a single path segment. Inverse of `escapeSegment`.
 */
export function unescapeSegment(segment: string): string {
  let out = '';
  let i = 0;
  while (i < segment.length) {
    if (segment.charCodeAt(i) === 0x5c && i + 1 < segment.length) {
      out += segment.charAt(i + 1);
      i += 2;
    } else {
      out += segment.charAt(i);
      i += 1;
    }
  }
  return out;
}

/**
 * Join segments into a dot-notation path with escaping.
 * Empty input → empty string (root).
 */
export function joinPath(segments: readonly (string | number)[]): string {
  if (segments.length === 0) return '';
  return segments.map((s) => escapeSegment(String(s))).join('.');
}

/**
 * Split a dot-notation path into raw segments (unescaped).
 * Inverse of `joinPath`. Round-trip: `joinPath(splitPath(p))` ≡ `p`.
 */
export function splitPath(path: string): readonly string[] {
  if (path === '') return [];
  const out: string[] = [];
  let cur = '';
  let i = 0;
  while (i < path.length) {
    const code = path.charCodeAt(i);
    if (code === 0x5c && i + 1 < path.length) {
      cur += path.charAt(i + 1);
      i += 2;
    } else if (code === 0x2e) {
      out.push(cur);
      cur = '';
      i += 1;
    } else {
      cur += path.charAt(i);
      i += 1;
    }
  }
  out.push(cur);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Canonical serialization (centralized — Mục IV)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Canonical JSON-like serialization with strict deterministic policy:
 *   - object keys sorted lex (DIRECT codepoint, NOT localeCompare)
 *   - arrays preserve order (intentional — array order is semantic)
 *   - `undefined` keys OMITTED (Mục IX policy)
 *   - `null` PRESERVED as `"null"` (Mục IX policy)
 *   - booleans → `"true"` / `"false"`
 *   - numbers → `String(n)` (INT only by R30/R31; float will still serialize but
 *     `scanForFloats` already flagged it before this point)
 *   - strings → `JSON.stringify` (handles escape, quotes, control chars)
 *   - unsupported types (function, symbol, bigint) → `"null"` fallback
 *
 * No reliance on host `JSON.stringify` for object/array structure ordering.
 * Cycles NOT supported — caller's responsibility to pass acyclic data.
 */
export function canonicalSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';

  const t = typeof value;
  if (t === 'boolean') return value === true ? 'true' : 'false';
  if (t === 'number') return String(value);
  if (t === 'string') return JSON.stringify(value);

  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      parts.push(canonicalSerialize(value[i]));
    }
    return '[' + parts.join(',') + ']';
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(lexCompare);
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue; // §IX policy: undefined omitted
      parts.push(JSON.stringify(k) + ':' + canonicalSerialize(v));
    }
    return '{' + parts.join(',') + '}';
  }

  return 'null';
}

// ═══════════════════════════════════════════════════════════════════════════
// Schema Registry (hardened — Mục VIII)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Frozen view of a single registry entry (snapshot output).
 */
export interface RegistryEntry {
  readonly name: string;
  readonly schema: ZodTypeAny;
}

/**
 * Central registry of Zod schemas keyed by canonical schema name.
 *
 * Hardening guarantees:
 *   - register references ONLY (NO mutation of stored schema)
 *   - duplicate `register` HARD FAILS (throws Error)
 *   - `list()` always returns lex-sorted names
 *   - `snapshot()` returns frozen array of frozen entries
 *   - `snapshotHash()` deterministic hash of registered name set
 *
 * Same content + same set of registrations (any insertion order)
 *   → same validation findings + same `deterministic_hash` ALWAYS.
 */
export class SchemaRegistry {
  private readonly schemas: Map<string, ZodTypeAny> = new Map();

  /**
   * Register a Zod schema under a canonical name.
   * @throws if `name` already registered (hard-fail per Mục VIII).
   */
  register(name: string, schema: ZodTypeAny): void {
    if (this.schemas.has(name)) {
      throw new Error(`schema_registry: duplicate registration "${name}"`);
    }
    this.schemas.set(name, schema);
  }

  /** Returns true iff `name` is registered. */
  has(name: string): boolean {
    return this.schemas.has(name);
  }

  /** Returns the registered schema, or `undefined` if not registered. */
  get(name: string): ZodTypeAny | undefined {
    return this.schemas.get(name);
  }

  /** Registered names in deterministic lex order (codepoint, not locale). */
  list(): readonly string[] {
    return Object.freeze([...this.schemas.keys()].sort(lexCompare));
  }

  /** Count of registered schemas. */
  get size(): number {
    return this.schemas.size;
  }

  /**
   * Returns frozen array of frozen `{name, schema}` entries in lex order.
   * Caller cannot mutate the snapshot (entries Object.freeze'd).
   */
  snapshot(): readonly RegistryEntry[] {
    const names = this.list();
    const out: RegistryEntry[] = [];
    for (const name of names) {
      const schema = this.schemas.get(name);
      if (schema === undefined) continue; // unreachable; defensive
      out.push(Object.freeze({ name, schema }));
    }
    return Object.freeze(out);
  }

  /**
   * Deterministic 32-bit FNV-1a hash of the lex-sorted name set.
   * Used as `hash_debug_metadata.registry_order_hash` diagnostic.
   */
  snapshotHash(): string {
    return fnv1a32(canonicalSerialize(this.list()));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Float scan (R30/R31 INT-only enforcement) — Mục V/VI
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Walk a parsed JSON value tree. For each numeric leaf where
 * `Number.isInteger(value) === false` (catches floats, NaN, Infinity),
 * emit a `float_in_data` finding with escaped dot-notation path.
 *
 * Object keys traversed in lex-sorted order so findings are emitted in
 * deterministic position-independent order before final sort step.
 *
 * Path segments are escape-safe: keys containing `.` or `\` produce
 * `\.` and `\\` in the path string respectively.
 */
function scanForFloats(
  value: unknown,
  schemaName: string,
  segments: readonly string[],
  out: ValidationFinding[],
): void {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      out.push({
        severity: SEVERITY.ERROR,
        schema_name: schemaName,
        path: joinPath(segments),
        kind: 'float_in_data',
        message: `non-integer number ${String(value)} violates R30/R31 INT-only data lock`,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      scanForFloats(value[i], schemaName, [...segments, String(i)], out);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(lexCompare);
    for (const key of keys) {
      scanForFloats(obj[key], schemaName, [...segments, key], out);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Zod issue → finding (with escaped path)
// ═══════════════════════════════════════════════════════════════════════════

function zodIssueToFinding(issue: ZodIssue, schemaName: string): ValidationFinding {
  const segments: string[] = issue.path.map((p) => String(p));
  return {
    severity: SEVERITY.ERROR,
    schema_name: schemaName,
    path: joinPath(segments),
    kind: 'schema_error',
    message: issue.message,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Finding ordering — severity ENUM → schema_name lex → path lex
// ═══════════════════════════════════════════════════════════════════════════

function compareFinding(a: ValidationFinding, b: ValidationFinding): number {
  if (a.severity !== b.severity) return a.severity - b.severity;
  const c = lexCompare(a.schema_name, b.schema_name);
  if (c !== 0) return c;
  return lexCompare(a.path, b.path);
}

// ═══════════════════════════════════════════════════════════════════════════
// Cyclic-safe deep freeze (Mục VII)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Recursively freeze an object tree (objects + arrays). Primitives untouched.
 * Cycle-safe via `WeakSet<object>` visited tracking — no recursion overflow
 * even on self-referential graphs. Idempotent on already-frozen subtrees.
 */
function deepFreeze<T>(obj: T, visited: WeakSet<object> = new WeakSet()): T {
  if (obj === null || typeof obj !== 'object') return obj;
  const objRef = obj as unknown as object;
  if (visited.has(objRef)) return obj;
  visited.add(objRef);
  if (Object.isFrozen(obj)) {
    // Already frozen but still need to recurse — children may not be frozen.
    // Continue walk without re-freezing self.
  } else {
    Object.freeze(obj);
  }
  for (const key of Object.keys(obj as object)) {
    const value = (obj as Record<string, unknown>)[key];
    if (value !== null && typeof value === 'object') {
      deepFreeze(value, visited);
    }
  }
  return obj;
}

// ═══════════════════════════════════════════════════════════════════════════
// Canonical forms for hashing (replay-safe)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fixed-order tuple for a single finding. Order is semantic (NOT alphabetical
 * on field names) — corresponds to expected JSON wire stability.
 */
function canonicalFindingTuple(f: ValidationFinding): readonly (number | string)[] {
  return [f.severity, f.kind, f.schema_name, f.path, f.message];
}

/**
 * Canonical hash input for a single ValidationResult.
 * Includes: schema_name + passed + sorted finding tuples.
 * EXCLUDES: deterministic_hash, hash_debug_metadata (diagnostic only).
 */
function canonicalResultHashInput(
  schemaName: string,
  passed: boolean,
  findings: readonly ValidationFinding[],
): string {
  return canonicalSerialize([schemaName, passed, findings.map(canonicalFindingTuple)]);
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate a single raw payload against a registered schema.
 *
 * Behavior:
 *   - if `name` not registered → emits `unknown_schema` finding (no Zod call)
 *   - if registered → runs `schema.safeParse(raw)`; on failure emits one
 *     `schema_error` finding per Zod issue (with escape-safe path)
 *   - ALWAYS runs `scanForFloats` on raw (defense-in-depth R30/R31)
 *   - sorts all findings (severity ENUM → schema_name lex → path lex)
 *   - computes FNV-1a 32-bit `deterministic_hash` of canonical result
 *   - attaches `hash_debug_metadata` (diagnostic — NOT in hash)
 *   - deep-freezes (cyclic-safe) returned result
 *
 * Same registry + same `raw` → same `deterministic_hash` ALWAYS.
 *
 * IMPORTANT — `deterministic_hash` semantics: this hash is computed over
 * (schema_name, passed, findings). It is a VALIDATION-OUTCOME fingerprint,
 * NOT a content fingerprint. Two different `raw` inputs that both pass
 * validation with no findings will share the same `deterministic_hash`.
 * For content identity, use `ExportArtifact.deterministic_hash` (Commit #3,
 * `serializeProjectContent`) which hashes over canonical content bytes.
 */
export function validateRegistry(
  registry: SchemaRegistry,
  name: string,
  raw: unknown,
): ValidationResult {
  const findings: ValidationFinding[] = [];

  const schema = registry.get(name);
  if (schema === undefined) {
    findings.push({
      severity: SEVERITY.ERROR,
      schema_name: name,
      path: '',
      kind: 'unknown_schema',
      message: `schema "${name}" not registered`,
    });
  } else {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        findings.push(zodIssueToFinding(issue, name));
      }
    }
  }

  scanForFloats(raw, name, [], findings);

  findings.sort(compareFinding);

  const passed = findings.length === 0;
  const canonicalInput = canonicalResultHashInput(name, passed, findings);
  const debug: HashDebugMetadata = {
    finding_count: findings.length,
    schema_count: 1,
    canonical_length: canonicalInput.length,
    registry_order_hash: fnv1a32(canonicalSerialize([name])),
  };

  const result: ValidationResult = {
    schema_name: name,
    passed,
    findings,
    deterministic_hash: fnv1a32(canonicalInput),
    hash_debug_metadata: debug,
  };
  return deepFreeze(result);
}

/**
 * Validate a batch of raw payloads against registered schemas.
 *
 * `content_map` keys are schema names. Input key order does NOT affect
 * output ordering — results are emitted in lex order by schema_name.
 *
 * Aggregate hash = FNV-1a 32-bit over canonical
 *   `[result.deterministic_hash, ...]` in lex-sorted name order.
 * Same content_map (regardless of registration or key order) → same
 * `deterministic_hash` ALWAYS.
 *
 * IMPORTANT — same caveat as `validateRegistry`: the aggregate
 * `deterministic_hash` is a VALIDATION-OUTCOME fingerprint (per-schema
 * pass/fail + findings), NOT a content fingerprint. Two `content_map`s
 * with different payloads that both pass validation with no findings
 * will share the same hash. For content identity, layer
 * `serializeProjectContent` on top — `ExportArtifact.deterministic_hash`
 * IS content-sensitive.
 */
export function validateAllRegistries(
  registry: SchemaRegistry,
  content_map: Readonly<Record<string, unknown>>,
): AggregateReport {
  const names = Object.keys(content_map).sort(lexCompare);
  const results: ValidationResult[] = [];
  for (const name of names) {
    results.push(validateRegistry(registry, name, content_map[name]));
  }

  let totalFindings = 0;
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const r of results) {
    totalFindings += r.findings.length;
    for (const f of r.findings) {
      if (f.severity === SEVERITY.ERROR) errors++;
      else if (f.severity === SEVERITY.WARNING) warnings++;
      else if (f.severity === SEVERITY.INFO) infos++;
    }
  }

  const passed = errors === 0;
  const aggregateCanonical = canonicalSerialize(results.map((r) => r.deterministic_hash));
  const debug: HashDebugMetadata = {
    finding_count: totalFindings,
    schema_count: results.length,
    canonical_length: aggregateCanonical.length,
    registry_order_hash: fnv1a32(canonicalSerialize(names)),
  };

  const report: AggregateReport = {
    passed,
    total_schemas: results.length,
    total_findings: totalFindings,
    by_severity: { error: errors, warning: warnings, info: infos },
    results,
    deterministic_hash: fnv1a32(aggregateCanonical),
    hash_debug_metadata: debug,
  };
  return deepFreeze(report);
}
