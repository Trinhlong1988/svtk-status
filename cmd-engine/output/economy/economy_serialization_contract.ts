/**
 * ECONOMY SERIALIZATION CONTRACT — Phase 11B Batch 5.3 Mục VI.
 *
 * Deterministic serialize/deserialize for:
 *   - InventorySnapshot (Mục VII schema)
 *   - LootDeltaMetadata (per-roll metadata for delta sync)
 *   - EconomyForensicSnapshot (telemetry payload)
 *
 * Same snapshot = same replay result ALWAYS.
 *
 * R30 + R31 + R32:
 *   - JSON-pure INT only (no float / BigInt / Date / Map / Symbol)
 *   - Stable key ordering (lex sort) for deterministic JSON.stringify output
 *   - FNV-1a hash for cross-platform replay checksum
 *   - Schema version embedded for cross-version compat
 *
 * Cross-platform guarantee:
 *   serialize(input) on Node x64 / ARM / Unity Mono → byte-identical output.
 */
import { z } from 'zod';
import { fnv1a32 } from './modifier_ordering_audit.js';
import {
  InventorySnapshotSchema,
  type InventorySnapshot,
  buildCanonicalInventorySnapshot,
  validateCanonicalSnapshot,
} from './inventory_snapshot_schema.js';
import type { LootRollResult, LootContext } from './loot/loot_generation_runtime.js';
import type { EconomySnapshot, InflationRiskReport } from './foundation/economy_foundation_runtime.js';
import { codepointCompare } from '../_shared/codepoint_compare.js';

// ───────── Serialization version ─────────
// Version 1 (Batch 5.3) → Version 2 (Batch 5.4 A3): rename `growth_ratio` → `growth_ratio_bp`
// + add `status` field to inflation_risk. Breaking signature.
export const ECONOMY_SERIALIZATION_VERSION = 2;

// ───────── Loot delta metadata ─────────
/**
 * Metadata for 1 loot drop, suitable for replay/delta sync.
 *
 * Caller serializes after each rollDrop() to persist or transmit.
 */
export const LootDeltaMetadataSchema = z.object({
  /** Serialization version (bump = breaking change). */
  serialization_version: z.literal(ECONOMY_SERIALIZATION_VERSION),
  /** Encounter context. */
  encounter_id: z.string().min(1),
  drop_index: z.number().int().nonnegative(),
  player_id: z.string().min(1),
  tick: z.number().int().nonnegative(),
  seed_root: z.string().min(1),
  /** Table id used. */
  table_id: z.string().min(1),
  /** Roll results — sorted by drop sub-index. */
  rolls: z.array(z.object({
    rarity: z.string(),
    slot: z.string(),
    item_id: z.string().nullable(),
    set_id: z.string().nullable(),
    affix_ids: z.array(z.string()),  // sorted lex
    seed_used: z.string(),
  })),
  /** FNV-1a hash for replay validation. */
  replay_checksum: z.string().regex(/^[0-9a-f]{8}$/),
});
export type LootDeltaMetadata = z.infer<typeof LootDeltaMetadataSchema>;

// ───────── Economy forensic snapshot (telemetry payload) ─────────
export const EconomyForensicSnapshotSchema = z.object({
  serialization_version: z.literal(ECONOMY_SERIALIZATION_VERSION),
  tick_start: z.number().int().nonnegative(),
  tick_end: z.number().int().nonnegative(),
  total_gold_in: z.number().int().nonnegative(),
  total_gold_out: z.number().int().nonnegative(),
  total_item_in: z.number().int().nonnegative(),
  total_item_out: z.number().int().nonnegative(),
  /** Rarity counts sorted lex by rarity name. */
  rarity_in_sorted: z.array(z.object({ rarity: z.string(), count: z.number().int().nonnegative() })),
  rarity_out_sorted: z.array(z.object({ rarity: z.string(), count: z.number().int().nonnegative() })),
  /** Gold source breakdown sorted lex by reason. */
  gold_source_breakdown_sorted: z.array(z.object({ reason: z.string(), amount: z.number().int().nonnegative() })),
  gold_sink_breakdown_sorted: z.array(z.object({ reason: z.string(), amount: z.number().int().nonnegative() })),
  /** Inflation risk summary (Batch 5.4 A3 + A4 schema). */
  inflation_risk: z.object({
    growth_ratio_bp: z.number().int(),
    severity: z.enum(['ok', 'warning', 'anomaly', 'critical']),
    sink_source_ratio_bp: z.number().int().nonnegative(),
    inflated_rarity: z.string().nullable(),
    status: z.enum(['on_target', 'no_flow', 'deviation_warning', 'deviation_anomaly', 'sink_deficit_critical']),
    detail: z.string(),
  }),
  /** FNV-1a checksum. */
  replay_checksum: z.string().regex(/^[0-9a-f]{8}$/),
});
export type EconomyForensicSnapshotPayload = z.infer<typeof EconomyForensicSnapshotSchema>;

// ───────── Canonical JSON serializer ─────────

/**
 * JSON.stringify with sorted top-level keys (recursive).
 * Output byte-identical cross-platform for primitive INT structures.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`[canonicalJSON] non-integer number not allowed: ${value}`);
    }
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const pairs = keys.map(k => `${JSON.stringify(k)}:${canonicalJSON((value as Record<string, unknown>)[k])}`);
    return `{${pairs.join(',')}}`;
  }
  throw new Error(`[canonicalJSON] unsupported type: ${typeof value}`);
}

// ───────── Inventory snapshot serialize/deserialize ─────────

export interface InventorySerializationOptions {
  /** Skip canonical sort (caller already sorted). Default: false (auto-sort). */
  skipCanonicalize?: boolean;
}

/**
 * Serialize inventory snapshot to canonical JSON string.
 * Same input → byte-identical output ALWAYS.
 */
export function serializeInventorySnapshot(
  snapshot: InventorySnapshot,
  opts: InventorySerializationOptions = {},
): string {
  const canonical = opts.skipCanonicalize ? snapshot : buildCanonicalInventorySnapshot(snapshot);
  const validation = validateCanonicalSnapshot(canonical);
  if (!validation.is_valid) {
    throw new Error(
      `[serializeInventorySnapshot] canonical validation FAIL:\n${JSON.stringify(validation.violations, null, 2)}`,
    );
  }
  return canonicalJSON(canonical);
}

/**
 * Deserialize inventory snapshot from JSON string.
 * Throws if Zod schema fails.
 */
export function deserializeInventorySnapshot(json: string): InventorySnapshot {
  const raw = JSON.parse(json);
  const parsed = InventorySnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `[deserializeInventorySnapshot] schema FAIL:\n${JSON.stringify(parsed.error.issues, null, 2)}`,
    );
  }
  return parsed.data;
}

/**
 * Compute FNV-1a checksum of canonical serialization.
 * Use cho replay anomaly detection.
 */
export function computeInventoryChecksum(snapshot: InventorySnapshot): string {
  return fnv1a32(serializeInventorySnapshot(snapshot));
}

// ───────── Loot delta metadata builder ─────────

/**
 * Build LootDeltaMetadata from rollDrop output.
 * Caller invokes after each rollDrop() with context + result.
 */
export function buildLootDeltaMetadata(
  ctx: LootContext,
  table_id: string,
  rolls: readonly LootRollResult[],
): LootDeltaMetadata {
  const canonicalRolls = rolls.map(r => ({
    rarity: r.rarity,
    slot: r.slot,
    item_id: r.item_id,
    set_id: r.set_id,
    affix_ids: [...r.affixes.map(a => a.id)].sort(),
    seed_used: r.seed_used,
  }));
  const partial: Omit<LootDeltaMetadata, 'replay_checksum'> = {
    serialization_version: ECONOMY_SERIALIZATION_VERSION,
    encounter_id: ctx.encounter_id,
    drop_index: ctx.drop_index,
    player_id: ctx.player_id,
    tick: ctx.tick,
    seed_root: ctx.seed_root,
    table_id,
    rolls: canonicalRolls,
  };
  const checksum = fnv1a32(canonicalJSON(partial));
  return { ...partial, replay_checksum: checksum };
}

/** Serialize LootDeltaMetadata to canonical JSON. */
export function serializeLootDelta(meta: LootDeltaMetadata): string {
  return canonicalJSON(meta);
}

/** Deserialize + validate LootDeltaMetadata. */
export function deserializeLootDelta(json: string): LootDeltaMetadata {
  const raw = JSON.parse(json);
  const parsed = LootDeltaMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `[deserializeLootDelta] schema FAIL:\n${JSON.stringify(parsed.error.issues, null, 2)}`,
    );
  }
  return parsed.data;
}

/**
 * Verify LootDeltaMetadata checksum (replay validation).
 * Returns true if checksum matches recomputed from rolls.
 */
export function verifyLootDeltaChecksum(meta: LootDeltaMetadata): boolean {
  // Rebuild minus checksum field, recompute, compare.
  const { replay_checksum, ...rest } = meta;
  const recomputed = fnv1a32(canonicalJSON(rest));
  return recomputed === replay_checksum;
}

// ───────── Economy forensic snapshot serialize ─────────

/**
 * Build forensic snapshot payload from EconomySnapshot + InflationRiskReport.
 * Same input → identical serialized output.
 */
export function buildEconomyForensicSnapshot(
  snap: EconomySnapshot,
  risk: InflationRiskReport,
): EconomyForensicSnapshotPayload {
  const rarity_in_sorted = Object.entries(snap.rarity_in)
    .map(([rarity, count]) => ({ rarity, count }))
    .sort((a, b) => codepointCompare(a.rarity, b.rarity));
  const rarity_out_sorted = Object.entries(snap.rarity_out)
    .map(([rarity, count]) => ({ rarity, count }))
    .sort((a, b) => codepointCompare(a.rarity, b.rarity));
  const gold_source_breakdown_sorted = Object.entries(snap.gold_source_breakdown)
    .map(([reason, amount]) => ({ reason, amount }))
    .sort((a, b) => codepointCompare(a.reason, b.reason));
  const gold_sink_breakdown_sorted = Object.entries(snap.gold_sink_breakdown)
    .map(([reason, amount]) => ({ reason, amount }))
    .sort((a, b) => codepointCompare(a.reason, b.reason));

  const partial: Omit<EconomyForensicSnapshotPayload, 'replay_checksum'> = {
    serialization_version: ECONOMY_SERIALIZATION_VERSION,
    tick_start: snap.tick_start,
    tick_end: snap.tick_end,
    total_gold_in: snap.total_gold_in,
    total_gold_out: snap.total_gold_out,
    total_item_in: snap.total_item_in,
    total_item_out: snap.total_item_out,
    rarity_in_sorted,
    rarity_out_sorted,
    gold_source_breakdown_sorted,
    gold_sink_breakdown_sorted,
    inflation_risk: {
      growth_ratio_bp: risk.growth_ratio_bp,
      severity: risk.severity,
      sink_source_ratio_bp: risk.sink_source_ratio_bp,
      inflated_rarity: risk.inflated_rarity,
      status: risk.status,
      detail: risk.detail,
    },
  };
  const checksum = fnv1a32(canonicalJSON(partial));
  return { ...partial, replay_checksum: checksum };
}

/** Serialize economy forensic snapshot. */
export function serializeEconomyForensicSnapshot(
  payload: EconomyForensicSnapshotPayload,
): string {
  return canonicalJSON(payload);
}

/** Deserialize + Zod validate. */
export function deserializeEconomyForensicSnapshot(
  json: string,
): EconomyForensicSnapshotPayload {
  const raw = JSON.parse(json);
  const parsed = EconomyForensicSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `[deserializeEconomyForensicSnapshot] schema FAIL:\n${JSON.stringify(parsed.error.issues, null, 2)}`,
    );
  }
  return parsed.data;
}

// ───────── Round-trip helpers ─────────

/**
 * Roundtrip test: serialize → deserialize → re-serialize.
 * Returns true if all 3 byte-identical (proves canonical determinism).
 */
export function verifyInventoryRoundtrip(snapshot: InventorySnapshot): boolean {
  const s1 = serializeInventorySnapshot(snapshot);
  const restored = deserializeInventorySnapshot(s1);
  const s2 = serializeInventorySnapshot(restored);
  return s1 === s2;
}

export function verifyLootDeltaRoundtrip(meta: LootDeltaMetadata): boolean {
  const s1 = serializeLootDelta(meta);
  const restored = deserializeLootDelta(s1);
  const s2 = serializeLootDelta(restored);
  return s1 === s2;
}

export function verifyForensicSnapshotRoundtrip(
  payload: EconomyForensicSnapshotPayload,
): boolean {
  const s1 = serializeEconomyForensicSnapshot(payload);
  const restored = deserializeEconomyForensicSnapshot(s1);
  const s2 = serializeEconomyForensicSnapshot(restored);
  return s1 === s2;
}
