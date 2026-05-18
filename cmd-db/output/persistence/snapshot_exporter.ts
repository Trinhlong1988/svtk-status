/**
 * SNAPSHOT EXPORTER — Phase 12 Batch 1 Mục VI.
 *
 * Build 5 snapshot type, deterministic + replay-safe:
 *   1. inventory snapshot           — per player full equipment state
 *   2. player economy snapshot      — per player gold + flow window
 *   3. PvP audit snapshot           — PvP damage audit history per encounter
 *   4. loot forensic snapshot       — loot RNG audit + rarity distribution
 *   5. replay-safe archive snapshot — cold storage payload (all 4 above bundled)
 *
 * Mandatory:
 *   Same state → same snapshot ALWAYS (canonical JSON + FNV-1a checksum).
 *
 * Stream-friendly: snapshots build từ adapter query (lazy, không buffer toàn bộ).
 */
import type { EconomyFoundationRuntime } from '../../../cmd-engine/output/economy/foundation/economy_foundation_runtime.js';
import type { PvPDamageAudit, PvPMode } from '../../../cmd-engine/output/economy/pvp/pvp_equipment_normalizer.js';
import { fnv1a32 } from '../../../cmd-engine/output/economy/modifier_ordering_audit.js';
import {
  canonicalJSON,
  buildEconomyForensicSnapshot,
  type EconomyForensicSnapshotPayload,
} from '../../../cmd-engine/output/economy/economy_serialization_contract.js';
import type {
  InventorySnapshot,
} from '../../../cmd-engine/output/economy/inventory_snapshot_schema.js';
import {
  ECONOMY_SERIALIZATION_VERSION,
} from '../../../cmd-engine/output/economy/economy_serialization_contract.js';
import { codepointCompare } from '../_shared/codepoint_compare.js';

// ───────── Snapshot kind enum ─────────
export const SNAPSHOT_KINDS = [
  'inventory',
  'player_economy',
  'pvp_audit',
  'loot_forensic',
  'replay_archive',
] as const;
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

// ───────── Player economy snapshot ─────────
export interface PlayerEconomySnapshot {
  serialization_version: number;
  player_id: string;
  tick_start: number;
  tick_end: number;
  gold_in: number;
  gold_out: number;
  item_in: number;
  item_out: number;
  /** Source breakdown sorted lex by reason. */
  gold_source_sorted: ReadonlyArray<{ reason: string; amount: number }>;
  /** Sink breakdown sorted lex by reason. */
  gold_sink_sorted: ReadonlyArray<{ reason: string; amount: number }>;
  /** Rarity distribution sorted lex. */
  rarity_distribution_sorted: ReadonlyArray<{ rarity: string; count: number }>;
  checksum: string;
}

// ───────── PvP audit snapshot ─────────
export interface PvPAuditEntry {
  mode: PvPMode;
  encounter_id: string;
  tick: number;
  raw_damage: number;
  capped_damage: number;
  cap_hit: boolean;
  hp_floor_protected: boolean;
}

export interface PvPAuditSnapshot {
  serialization_version: number;
  encounter_id_filter: string | null;
  tick_start: number;
  tick_end: number;
  total_audits: number;
  cap_hit_count: number;
  hp_floor_count: number;
  /** Per-mode aggregates sorted lex. */
  per_mode_sorted: ReadonlyArray<{
    mode: string;
    audit_count: number;
    cap_hit_count: number;
    hp_floor_count: number;
    avg_capped_damage: number;
  }>;
  checksum: string;
}

// ───────── Loot forensic snapshot ─────────
export interface LootForensicEntry {
  encounter_id: string;
  drop_index: number;
  tick: number;
  rarity: string;
  slot: string;
  item_id: string | null;
  set_id: string | null;
}

export interface LootForensicSnapshot {
  serialization_version: number;
  tick_start: number;
  tick_end: number;
  total_drops: number;
  /** Rarity counts sorted lex. */
  rarity_counts_sorted: ReadonlyArray<{ rarity: string; count: number }>;
  /** Slot counts sorted lex. */
  slot_counts_sorted: ReadonlyArray<{ slot: string; count: number }>;
  /** Set piece percentage in BP (×10000). */
  set_piece_share_bp: number;
  /** Mythic share BP (anti-explosion alert reference). */
  mythic_share_bp: number;
  checksum: string;
}

// ───────── Replay-safe archive (bundle) ─────────
export interface ReplayArchiveSnapshot {
  serialization_version: number;
  archive_version: number;  // bump khi bundle structure thay đổi
  tick_start: number;
  tick_end: number;
  inventory_snapshots: readonly InventorySnapshot[];
  player_economy_snapshots: readonly PlayerEconomySnapshot[];
  pvp_audit_snapshot: PvPAuditSnapshot;
  loot_forensic_snapshot: LootForensicSnapshot;
  economy_forensic_snapshot: EconomyForensicSnapshotPayload;
  bundle_checksum: string;
}

// v1 → v2 (2026-05-15): sort algorithm switched from String.prototype.localeCompare
// (locale-dependent) to codepoint compare (locale-independent) per R32 replay-safe.
// Hash chain on bundle_checksum depends on canonical sort; bump prevents loader
// from accepting v1 archive (locale-sort) against v2 runtime (codepoint-sort).
export const REPLAY_ARCHIVE_VERSION = 2;

// ───────── Snapshot Exporter Contract ─────────

export interface SnapshotExporter {
  /**
   * Build player economy snapshot from EconomyFoundationRuntime.
   * Deterministic: same input → same checksum ALWAYS.
   */
  buildPlayerEconomySnapshot(
    runtime: EconomyFoundationRuntime,
    player_id: string,
    tick_start: number,
    tick_end: number,
  ): PlayerEconomySnapshot;

  /** Build PvP audit snapshot from a stream of audit entries. */
  buildPvPAuditSnapshot(
    audits: readonly PvPAuditEntry[],
    encounter_id_filter: string | null,
    tick_start: number,
    tick_end: number,
  ): PvPAuditSnapshot;

  /** Build loot forensic snapshot from loot drop entries. */
  buildLootForensicSnapshot(
    drops: readonly LootForensicEntry[],
    tick_start: number,
    tick_end: number,
  ): LootForensicSnapshot;

  /** Bundle all snapshots into replay archive (cold storage payload). */
  buildReplayArchive(input: {
    tick_start: number;
    tick_end: number;
    inventory_snapshots: readonly InventorySnapshot[];
    player_economy_snapshots: readonly PlayerEconomySnapshot[];
    pvp_audit_snapshot: PvPAuditSnapshot;
    loot_forensic_snapshot: LootForensicSnapshot;
    economy_forensic_snapshot: EconomyForensicSnapshotPayload;
  }): ReplayArchiveSnapshot;
}

// ───────── Helpers ─────────

function buildPlayerEconomySnapshotInternal(
  runtime: EconomyFoundationRuntime,
  player_id: string,
  tick_start: number,
  tick_end: number,
): PlayerEconomySnapshot {
  const snap = runtime.getSnapshot(tick_start, tick_end);
  // Note: getSnapshot trả aggregate toàn server, không filter per player.
  // Phase 12 follow-up nếu cần per-player aggregation phải extend runtime API.
  // Hiện adapter dùng aggregate global cho player.
  const gold_source_sorted = Object.entries(snap.gold_source_breakdown)
    .map(([reason, amount]) => ({ reason, amount }))
    .sort((a, b) => codepointCompare(a.reason, b.reason));
  const gold_sink_sorted = Object.entries(snap.gold_sink_breakdown)
    .map(([reason, amount]) => ({ reason, amount }))
    .sort((a, b) => codepointCompare(a.reason, b.reason));
  const rarity_distribution_sorted = Object.entries(snap.rarity_in)
    .map(([rarity, count]) => ({ rarity, count }))
    .sort((a, b) => codepointCompare(a.rarity, b.rarity));
  const partial = {
    serialization_version: ECONOMY_SERIALIZATION_VERSION,
    player_id,
    tick_start, tick_end,
    gold_in: snap.total_gold_in,
    gold_out: snap.total_gold_out,
    item_in: snap.total_item_in,
    item_out: snap.total_item_out,
    gold_source_sorted,
    gold_sink_sorted,
    rarity_distribution_sorted,
  };
  return { ...partial, checksum: fnv1a32(canonicalJSON(partial)) };
}

function buildPvPAuditSnapshotInternal(
  audits: readonly PvPAuditEntry[],
  encounter_id_filter: string | null,
  tick_start: number,
  tick_end: number,
): PvPAuditSnapshot {
  // Filter by tick range + encounter (deterministic stable order).
  const filtered = audits
    .filter(a => a.tick >= tick_start && a.tick <= tick_end)
    .filter(a => encounter_id_filter === null || a.encounter_id === encounter_id_filter);

  const cap_hit_count = filtered.filter(a => a.cap_hit).length;
  const hp_floor_count = filtered.filter(a => a.hp_floor_protected).length;

  // Per-mode aggregates sorted lex.
  const modeMap = new Map<string, { audit_count: number; cap_hit_count: number; hp_floor_count: number; sumCappedDamage: number }>();
  for (const a of filtered) {
    let agg = modeMap.get(a.mode);
    if (!agg) {
      agg = { audit_count: 0, cap_hit_count: 0, hp_floor_count: 0, sumCappedDamage: 0 };
      modeMap.set(a.mode, agg);
    }
    agg.audit_count++;
    if (a.cap_hit) agg.cap_hit_count++;
    if (a.hp_floor_protected) agg.hp_floor_count++;
    agg.sumCappedDamage += a.capped_damage;
  }
  const per_mode_sorted = [...modeMap.entries()]
    .map(([mode, agg]) => ({
      mode,
      audit_count: agg.audit_count,
      cap_hit_count: agg.cap_hit_count,
      hp_floor_count: agg.hp_floor_count,
      avg_capped_damage: agg.audit_count > 0 ? Math.floor(agg.sumCappedDamage / agg.audit_count) : 0,
    }))
    .sort((a, b) => codepointCompare(a.mode, b.mode));

  const partial = {
    serialization_version: ECONOMY_SERIALIZATION_VERSION,
    encounter_id_filter,
    tick_start, tick_end,
    total_audits: filtered.length,
    cap_hit_count,
    hp_floor_count,
    per_mode_sorted,
  };
  return { ...partial, checksum: fnv1a32(canonicalJSON(partial)) };
}

function buildLootForensicSnapshotInternal(
  drops: readonly LootForensicEntry[],
  tick_start: number,
  tick_end: number,
): LootForensicSnapshot {
  const filtered = drops.filter(d => d.tick >= tick_start && d.tick <= tick_end);
  const total = filtered.length;

  const rarityMap = new Map<string, number>();
  const slotMap = new Map<string, number>();
  let setPieces = 0;
  let mythicCount = 0;
  for (const d of filtered) {
    rarityMap.set(d.rarity, (rarityMap.get(d.rarity) ?? 0) + 1);
    slotMap.set(d.slot, (slotMap.get(d.slot) ?? 0) + 1);
    if (d.set_id) setPieces++;
    if (d.rarity === 'mythic') mythicCount++;
  }
  const rarity_counts_sorted = [...rarityMap.entries()]
    .map(([rarity, count]) => ({ rarity, count }))
    .sort((a, b) => codepointCompare(a.rarity, b.rarity));
  const slot_counts_sorted = [...slotMap.entries()]
    .map(([slot, count]) => ({ slot, count }))
    .sort((a, b) => codepointCompare(a.slot, b.slot));

  const set_piece_share_bp = total > 0 ? Math.floor((setPieces * 10000) / total) : 0;
  const mythic_share_bp = total > 0 ? Math.floor((mythicCount * 10000) / total) : 0;

  const partial = {
    serialization_version: ECONOMY_SERIALIZATION_VERSION,
    tick_start, tick_end,
    total_drops: total,
    rarity_counts_sorted,
    slot_counts_sorted,
    set_piece_share_bp,
    mythic_share_bp,
  };
  return { ...partial, checksum: fnv1a32(canonicalJSON(partial)) };
}

// ───────── Factory ─────────

export function createSnapshotExporter(): SnapshotExporter {
  return {
    buildPlayerEconomySnapshot: buildPlayerEconomySnapshotInternal,
    buildPvPAuditSnapshot: buildPvPAuditSnapshotInternal,
    buildLootForensicSnapshot: buildLootForensicSnapshotInternal,
    buildReplayArchive(input) {
      // Sort inventory snapshots by player_id lex deterministic.
      const inventory_snapshots = [...input.inventory_snapshots].sort((a, b) =>
        codepointCompare(a.player_id, b.player_id));
      const player_economy_snapshots = [...input.player_economy_snapshots].sort((a, b) =>
        codepointCompare(a.player_id, b.player_id));
      const partial = {
        serialization_version: ECONOMY_SERIALIZATION_VERSION,
        archive_version: REPLAY_ARCHIVE_VERSION,
        tick_start: input.tick_start,
        tick_end: input.tick_end,
        inventory_snapshots,
        player_economy_snapshots,
        pvp_audit_snapshot: input.pvp_audit_snapshot,
        loot_forensic_snapshot: input.loot_forensic_snapshot,
        economy_forensic_snapshot: input.economy_forensic_snapshot,
      };
      const bundle_checksum = fnv1a32(canonicalJSON(partial as unknown));
      return { ...partial, bundle_checksum };
    },
  };
}

// Re-export for convenience.
export { canonicalJSON, fnv1a32 };
