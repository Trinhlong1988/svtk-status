/**
 * OPERATIONAL TELEMETRY REGISTRY — CMD4 Phase 14 Module 4.
 *
 * Centralized telemetry metadata registry — independent foundation for
 * Phase 14 ci_pipeline / drift_monitor / multi_region_audit consumers.
 *
 * Brief v13 §TASK 4 responsibilities:
 *   1. telemetry schema registry (registered telemetry kinds + field shapes)
 *   2. deterministic telemetry serialization (canonical JSON)
 *   3. forensic telemetry linkage (snapshot ↔ schema_id POINTER)
 *   4. audit-safe operational metrics (immutable snapshots, INT-only)
 *   5. immutable telemetry snapshots (deep-frozen, no mutation API)
 *
 * ★ CRITICAL RULE (brief v13 §TASK 4) ★
 *   telemetry metadata MUST NEVER affect:
 *     - replay hash (em never feed snapshot into ExportArtifact canonical)
 *     - gameplay determinism (em never consumed by combat / progression)
 *     - export integrity (em is parallel pipeline, NOT embedded)
 *
 * In-memory deterministic ONLY — no live DB, no IO, no Date.now, no
 * Math.random, no localeCompare, no insertion-order dependence.
 *
 * Ownership: tooling/validator/forensic/export layer (brief v13 §III).
 */
import { z } from 'zod';
import { canonicalSerialize, fnv1a32 } from './schema_validation_runtime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Versioning
// ═══════════════════════════════════════════════════════════════════════════

export const TELEMETRY_REGISTRY_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export const TELEMETRY_FIELD_KINDS = ['int', 'string', 'bool'] as const;
export type TelemetryFieldKind = (typeof TELEMETRY_FIELD_KINDS)[number];

export interface TelemetryFieldDef {
  readonly name: string;
  readonly kind: TelemetryFieldKind;
  readonly required: boolean;
}

export interface TelemetrySchema {
  readonly schema_id: string;
  readonly fields: readonly TelemetryFieldDef[];
}

export interface TelemetrySnapshot {
  readonly registry_version: number;
  readonly schema_id: string;
  /** Logical clock ordinal (NOT wall time). Monotonic per caller-managed sequence. */
  readonly timestamp_ordinal: number;
  /** Frozen payload. Keys lex-sorted internally for canonical hashing. */
  readonly payload: Readonly<Record<string, string | number | boolean>>;
  /** Deterministic FNV-1a hash over canonical (registry_version, schema_id, ordinal, payload). */
  readonly deterministic_hash: string;
}

export interface SnapshotVerifyResult {
  readonly ok: boolean;
  readonly registry_version_match: boolean;
  readonly schema_registered: boolean;
  readonly required_fields_present: boolean;
  readonly field_kinds_match: boolean;
  readonly deterministic_hash_match: boolean;
  readonly missing_fields: readonly string[];
  readonly type_mismatched_fields: readonly string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function lexCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function canonicalSnapshotHashInput(
  registryVersion: number,
  schemaId: string,
  ordinal: number,
  payload: Readonly<Record<string, string | number | boolean>>,
): string {
  return canonicalSerialize({
    registry_version: registryVersion,
    schema_id: schemaId,
    timestamp_ordinal: ordinal,
    payload,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// TelemetryRegistry
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Central registry of telemetry schemas. Pattern mirrors Commit #1
 * `SchemaRegistry` — lex-sorted, duplicate-fail-hard, frozen output.
 *
 * Telemetry schemas are independent of game content schemas (Zod) — em
 * intentionally use a simpler field-kind enum here so telemetry serialization
 * stays trivially INT-safe.
 */
export class TelemetryRegistry {
  private readonly schemas: Map<string, TelemetrySchema> = new Map();

  register(schema: TelemetrySchema): void {
    if (this.schemas.has(schema.schema_id)) {
      throw new Error(`telemetry_registry: duplicate schema_id "${schema.schema_id}"`);
    }
    // Validate field names + lex-sort fields for canonical form.
    const seenFieldNames = new Set<string>();
    for (const f of schema.fields) {
      if (seenFieldNames.has(f.name)) {
        throw new Error(`telemetry_registry: duplicate field "${f.name}" in schema "${schema.schema_id}"`);
      }
      seenFieldNames.add(f.name);
    }
    const sortedFields = [...schema.fields]
      .sort((a, b) => lexCompare(a.name, b.name))
      .map((f) => Object.freeze({ name: f.name, kind: f.kind, required: f.required }));
    const frozen: TelemetrySchema = Object.freeze({
      schema_id: schema.schema_id,
      fields: Object.freeze(sortedFields),
    });
    this.schemas.set(schema.schema_id, frozen);
  }

  has(schemaId: string): boolean {
    return this.schemas.has(schemaId);
  }

  get(schemaId: string): TelemetrySchema | undefined {
    return this.schemas.get(schemaId);
  }

  list(): readonly string[] {
    return Object.freeze([...this.schemas.keys()].sort(lexCompare));
  }

  get size(): number {
    return this.schemas.size;
  }

  /** Deterministic FNV-1a of registry schema set (lex-sorted ids + fields). */
  snapshotHash(): string {
    const names = this.list();
    const canonical = canonicalSerialize(
      names.map((n) => {
        const s = this.schemas.get(n);
        if (s === undefined) return [n];
        return [
          s.schema_id,
          s.fields.map((f) => [f.name, f.kind, f.required]),
        ];
      }),
    );
    return fnv1a32(canonical);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// createTelemetrySnapshot
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a frozen deterministic telemetry snapshot bound to a registered
 * schema. Validates payload against schema fields. Throws if schema unknown
 * or payload missing required fields / type mismatch.
 *
 * `timestamp_ordinal` is a LOGICAL clock (caller-managed monotonic int) —
 * NOT wall time. Em never call Date.now.
 */
export function createTelemetrySnapshot(
  registry: TelemetryRegistry,
  schemaId: string,
  payload: Readonly<Record<string, string | number | boolean>>,
  ordinal: number,
): TelemetrySnapshot {
  const schema = registry.get(schemaId);
  if (schema === undefined) {
    throw new Error(`operational_telemetry_registry: unknown schema_id "${schemaId}"`);
  }
  // Number.isSafeInteger (not Number.isInteger): values >= 2^53 alias under
  // IEEE-754 (2^53 + 1 === 2^53), which would silently collapse two semantically
  // distinct logical-clock ordinals into the same hash input. Matches the
  // ordinal contract used by replay_drift_monitor / immutable_snapshot_archive.
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new Error(`operational_telemetry_registry: timestamp_ordinal must be a non-negative safe integer, got ${String(ordinal)}`);
  }

  // Required + type validation.
  const fieldByName = new Map<string, TelemetryFieldDef>();
  for (const f of schema.fields) fieldByName.set(f.name, f);

  const missing: string[] = [];
  const typeMismatch: string[] = [];
  for (const f of schema.fields) {
    // Use Object.hasOwn (not `in`): payload is a plain {} that inherits
    // Object.prototype, so `in` would falsely match field names like
    // 'toString' / 'constructor' / 'hasOwnProperty' and skip the missing-
    // required check, then misclassify them as type-mismatched on the
    // inherited function value.
    if (f.required && !Object.hasOwn(payload, f.name)) {
      missing.push(f.name);
      continue;
    }
    if (Object.hasOwn(payload, f.name)) {
      const v = payload[f.name];
      if (!validateFieldKind(v, f.kind)) typeMismatch.push(f.name);
    }
  }
  if (missing.length > 0) {
    throw new Error(`operational_telemetry_registry: missing required fields: ${missing.join(', ')}`);
  }
  if (typeMismatch.length > 0) {
    throw new Error(`operational_telemetry_registry: type-mismatched fields: ${typeMismatch.join(', ')}`);
  }

  // Build frozen lex-sorted payload (drop undefined per Commit #1 policy).
  const sortedPayload: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(payload).sort(lexCompare)) {
    const v = payload[key];
    if (v === undefined) continue;
    sortedPayload[key] = v;
  }
  const frozenPayload = Object.freeze(sortedPayload);

  const canonical = canonicalSnapshotHashInput(
    TELEMETRY_REGISTRY_VERSION,
    schemaId,
    ordinal,
    frozenPayload,
  );
  return Object.freeze({
    registry_version: TELEMETRY_REGISTRY_VERSION,
    schema_id: schemaId,
    timestamp_ordinal: ordinal,
    payload: frozenPayload,
    deterministic_hash: fnv1a32(canonical),
  });
}

function validateFieldKind(value: unknown, kind: TelemetryFieldKind): boolean {
  if (kind === 'int') return typeof value === 'number' && Number.isInteger(value);
  if (kind === 'string') return typeof value === 'string';
  if (kind === 'bool') return typeof value === 'boolean';
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Wire format — serialize / deserialize
// ═══════════════════════════════════════════════════════════════════════════

const TelemetryPayloadSchema = z.record(
  z.string(),
  z.union([z.number().int(), z.string(), z.boolean()]),
);

const TelemetrySnapshotSchema = z
  .object({
    registry_version: z.literal(TELEMETRY_REGISTRY_VERSION),
    schema_id: z.string(),
    timestamp_ordinal: z.number().int().nonnegative(),
    payload: TelemetryPayloadSchema,
    deterministic_hash: z.string().regex(/^[0-9a-f]{8}$/),
  })
  .strict();

/** Serialize snapshot to canonical JSON. Same snapshot → byte-identical JSON. */
export function serializeSnapshot(snap: TelemetrySnapshot): string {
  return canonicalSerialize({
    registry_version: snap.registry_version,
    schema_id: snap.schema_id,
    timestamp_ordinal: snap.timestamp_ordinal,
    payload: snap.payload,
    deterministic_hash: snap.deterministic_hash,
  });
}

/**
 * Parse + Zod-validate + freeze a snapshot from JSON. Throws on JSON parse
 * error, schema mismatch, wrong registry_version, or float contamination.
 */
export function deserializeSnapshot(json: string): TelemetrySnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`operational_telemetry_registry: invalid JSON: ${msg}`);
  }
  const parsed = TelemetrySnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first ? first.path.join('.') : '<root>';
    const msg = first ? first.message : 'unknown';
    throw new Error(`operational_telemetry_registry: schema reject at "${path}": ${msg}`);
  }
  return Object.freeze({
    registry_version: parsed.data.registry_version,
    schema_id: parsed.data.schema_id,
    timestamp_ordinal: parsed.data.timestamp_ordinal,
    payload: Object.freeze({ ...parsed.data.payload }),
    deterministic_hash: parsed.data.deterministic_hash,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// verifyTelemetrySnapshot
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verify snapshot against registry. Pure read-only — NO throws.
 *
 * Checks:
 *   1. registry_version matches TELEMETRY_REGISTRY_VERSION
 *   2. schema_id is registered in `registry`
 *   3. all required fields present in payload
 *   4. payload field kinds match schema
 *   5. deterministic_hash re-computes from canonical
 */
export function verifyTelemetrySnapshot(
  snap: TelemetrySnapshot,
  registry: TelemetryRegistry,
): SnapshotVerifyResult {
  const versionMatch = snap.registry_version === TELEMETRY_REGISTRY_VERSION;
  // Bug #28 fix: verify is the trust boundary for snapshots that didn't pass
  // through `createTelemetrySnapshot` (e.g. deserialized externally). Mirror
  // factory's `Number.isSafeInteger(ordinal) && ordinal >= 0` guard so a
  // fabricated NaN/Infinity/negative/2^53 ordinal cannot pass verify.
  const ordinalSafeInt =
    Number.isSafeInteger(snap.timestamp_ordinal) && snap.timestamp_ordinal >= 0;
  const schema = registry.get(snap.schema_id);
  const registered = schema !== undefined;

  const missing: string[] = [];
  const typeMismatch: string[] = [];

  if (schema !== undefined) {
    for (const f of schema.fields) {
      // Object.hasOwn — see createTelemetrySnapshot for rationale (avoid
      // Object.prototype inherited-property matches via `in`).
      if (f.required && !Object.hasOwn(snap.payload, f.name)) {
        missing.push(f.name);
        continue;
      }
      if (Object.hasOwn(snap.payload, f.name)) {
        const v = snap.payload[f.name];
        if (!validateFieldKind(v, f.kind)) typeMismatch.push(f.name);
      }
    }
  }
  missing.sort(lexCompare);
  typeMismatch.sort(lexCompare);

  const requiredOk = missing.length === 0;
  const kindsOk = typeMismatch.length === 0;

  const recomputed = fnv1a32(
    canonicalSnapshotHashInput(snap.registry_version, snap.schema_id, snap.timestamp_ordinal, snap.payload),
  );
  const hashMatch = recomputed === snap.deterministic_hash;

  const ok = versionMatch && ordinalSafeInt && registered && requiredOk && kindsOk && hashMatch;
  return Object.freeze({
    ok,
    registry_version_match: versionMatch,
    schema_registered: registered,
    required_fields_present: requiredOk,
    field_kinds_match: kindsOk,
    deterministic_hash_match: hashMatch,
    missing_fields: Object.freeze(missing),
    type_mismatched_fields: Object.freeze(typeMismatch),
  });
}
