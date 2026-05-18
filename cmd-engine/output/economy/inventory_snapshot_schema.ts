/**
 * INVENTORY SNAPSHOT SCHEMA — Phase 11B Batch 5.3 Mục VII.
 *
 * Schema + canonical sorter + dedupe helpers cho inventory serialization.
 *
 * 5 ordering domain locked deterministic (no runtime-dependent serialization):
 *   1. item ordering          — by id lex ASC
 *   2. affix ordering         — by id lex ASC within each item
 *   3. modifier ordering      — 5-tuple priority lock (same as modifier_ordering_audit)
 *   4. set bonus ordering     — by set_id lex ASC
 *   5. companion equipment    — owner-first, companion-after
 *
 * R30 + R31: JSON-pure INT serialization. NO float / BigInt / Date / Map / Symbol.
 *
 * Versioning fields embedded for cross-version replay validation (CMD2.docx FIX #11/#12).
 */
import { z } from 'zod';
import {
  EquipmentSlotSchema,
  RaritySchema,
  ItemStatBlockSchema,
  ItemAffixSchema,
} from '../../../cmd-item/output/legacy/itemization_types.js';
import { codepointCompare } from '../_shared/codepoint_compare.js';

// ───────── Snapshot version (bump khi schema changes) ─────────
// v1 → v2 (2026-05-15): sort algorithm switched from String.prototype.localeCompare
// (locale-dependent) to codepoint compare (locale-independent) per R32 replay-safe.
export const INVENTORY_SNAPSHOT_VERSION = 2;

// ───────── Item snapshot (1 instance owned by player) ─────────
export const InventoryItemSnapshotSchema = z.object({
  /** Stable instance id (UUID v4 hoặc deterministic gen). */
  instance_id: z.string().min(1),
  /** Registry item id (matches data/items.json). */
  item_id: z.string().regex(/^item_/),
  slot: EquipmentSlotSchema,
  rarity: RaritySchema,
  stats: ItemStatBlockSchema,
  /** Affixes — MUST be sorted by id lex (canonical ordering). */
  affixes: z.array(ItemAffixSchema),
  /** Set id if part of set, null otherwise. */
  set_id: z.string().regex(/^set_/).nullable(),
  /** Owner companion id if equipped on companion, null if owner player. */
  equipped_on_companion: z.string().regex(/^companion_/).nullable().default(null),
  /** Acquired tick (for forensic audit). */
  acquired_tick: z.number().int().nonnegative(),
  /** Upgrade tier (0 = unupgraded). */
  upgrade_tier: z.number().int().nonnegative().default(0),
});
export type InventoryItemSnapshot = z.infer<typeof InventoryItemSnapshotSchema>;

// ───────── Companion equipment slot snapshot ─────────
export const CompanionEquipmentSnapshotSchema = z.object({
  companion_id: z.string().regex(/^companion_/),
  /** Equipped item instance ids — sorted lex. */
  equipped_instance_ids: z.array(z.string()),
});
export type CompanionEquipmentSnapshot = z.infer<typeof CompanionEquipmentSnapshotSchema>;

// ───────── Set bonus active snapshot ─────────
export const ActiveSetSnapshotSchema = z.object({
  set_id: z.string().regex(/^set_/),
  /** Count of pieces equipped (across owner + companions). */
  piece_count: z.number().int().positive(),
  /** Active tier (depends on piece_count thresholds). */
  active_tier: z.number().int().nonnegative(),
});
export type ActiveSetSnapshot = z.infer<typeof ActiveSetSnapshotSchema>;

// ───────── Full inventory snapshot ─────────
export const InventorySnapshotSchema = z.object({
  /** Schema version (bump = breaking change). */
  snapshot_version: z.literal(INVENTORY_SNAPSHOT_VERSION),
  /** Player id owning inventory. */
  player_id: z.string().min(1),
  /** Tick when snapshot taken. */
  snapshot_tick: z.number().int().nonnegative(),
  /** Items — sorted by instance_id lex. */
  items: z.array(InventoryItemSnapshotSchema),
  /** Active sets — sorted by set_id lex. */
  active_sets: z.array(ActiveSetSnapshotSchema),
  /** Companion equipment — sorted by companion_id lex. */
  companion_equipment: z.array(CompanionEquipmentSnapshotSchema),
  /** Registry versioning for cross-version replay validation. */
  versioning: z.object({
    registry_content_hash: z.string(),
    registry_version: z.string(),
    formula_version: z.string(),
    softcap_version: z.string(),
  }),
});
export type InventorySnapshot = z.infer<typeof InventorySnapshotSchema>;

// ───────── Canonical sorters (in-place SORT — caller already cloned) ─────────

/** Sort affixes by id lex ASC. */
export function sortAffixesCanonical<T extends { id: string }>(affixes: T[]): T[] {
  return [...affixes].sort((a, b) => codepointCompare(a.id, b.id));
}

/** Sort items by instance_id lex ASC. */
export function sortItemsCanonical<T extends { instance_id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => codepointCompare(a.instance_id, b.instance_id));
}

/** Sort sets by set_id lex ASC. */
export function sortSetsCanonical<T extends { set_id: string }>(sets: T[]): T[] {
  return [...sets].sort((a, b) => codepointCompare(a.set_id, b.set_id));
}

/** Sort companion equipment by companion_id lex ASC; equipped_instance_ids sorted lex. */
export function sortCompanionEquipmentCanonical(
  entries: CompanionEquipmentSnapshot[],
): CompanionEquipmentSnapshot[] {
  return [...entries]
    .map(e => ({
      ...e,
      equipped_instance_ids: [...e.equipped_instance_ids].sort(),
    }))
    .sort((a, b) => codepointCompare(a.companion_id, b.companion_id));
}

// ───────── Canonical builder ─────────

/**
 * Build canonical snapshot — apply all 5 sort rules.
 * Caller passes raw data, builder returns CANONICAL form ready to serialize/hash.
 */
export interface InventorySnapshotInput {
  player_id: string;
  snapshot_tick: number;
  items: InventoryItemSnapshot[];
  active_sets: ActiveSetSnapshot[];
  companion_equipment: CompanionEquipmentSnapshot[];
  versioning: InventorySnapshot['versioning'];
}

export function buildCanonicalInventorySnapshot(input: InventorySnapshotInput): InventorySnapshot {
  const items = sortItemsCanonical(input.items).map(it => ({
    ...it,
    affixes: sortAffixesCanonical(it.affixes),
  }));
  const active_sets = sortSetsCanonical(input.active_sets);
  const companion_equipment = sortCompanionEquipmentCanonical(input.companion_equipment);
  return {
    snapshot_version: INVENTORY_SNAPSHOT_VERSION,
    player_id: input.player_id,
    snapshot_tick: input.snapshot_tick,
    items,
    active_sets,
    companion_equipment,
    versioning: input.versioning,
  };
}

// ───────── Validation ─────────

export interface SnapshotValidationResult {
  is_valid: boolean;
  violations: { kind: string; detail: string }[];
}

/**
 * Validate snapshot for canonical ordering invariants.
 * Returns violations if found, empty if canonical.
 */
export function validateCanonicalSnapshot(snap: InventorySnapshot): SnapshotValidationResult {
  const violations: { kind: string; detail: string }[] = [];

  // items sorted by instance_id lex.
  for (let i = 1; i < snap.items.length; i++) {
    const prev = snap.items[i - 1];
    const cur = snap.items[i];
    if (prev && cur && prev.instance_id > cur.instance_id) {
      violations.push({
        kind: 'items_unsorted',
        detail: `items[${i}].instance_id="${cur.instance_id}" < prev="${prev.instance_id}"`,
      });
      break;
    }
  }

  // affixes sorted within each item.
  for (let i = 0; i < snap.items.length; i++) {
    const item = snap.items[i];
    if (!item) continue;
    for (let j = 1; j < item.affixes.length; j++) {
      const prev = item.affixes[j - 1];
      const cur = item.affixes[j];
      if (prev && cur && prev.id > cur.id) {
        violations.push({
          kind: 'affix_unsorted',
          detail: `items[${i}].affixes[${j}].id="${cur.id}" < prev="${prev.id}"`,
        });
        break;
      }
    }
  }

  // sets sorted by set_id lex.
  for (let i = 1; i < snap.active_sets.length; i++) {
    const prev = snap.active_sets[i - 1];
    const cur = snap.active_sets[i];
    if (prev && cur && prev.set_id > cur.set_id) {
      violations.push({
        kind: 'sets_unsorted',
        detail: `active_sets[${i}].set_id="${cur.set_id}" < prev="${prev.set_id}"`,
      });
      break;
    }
  }

  // companion equipment sorted by companion_id lex.
  for (let i = 1; i < snap.companion_equipment.length; i++) {
    const prev = snap.companion_equipment[i - 1];
    const cur = snap.companion_equipment[i];
    if (prev && cur && prev.companion_id > cur.companion_id) {
      violations.push({
        kind: 'companion_equipment_unsorted',
        detail: `companion_equipment[${i}].companion_id="${cur.companion_id}" < prev="${prev.companion_id}"`,
      });
      break;
    }
  }

  // duplicate instance_id detection.
  const seen = new Set<string>();
  for (const item of snap.items) {
    if (seen.has(item.instance_id)) {
      violations.push({
        kind: 'duplicate_instance_id',
        detail: `instance_id "${item.instance_id}" appears 2+ times`,
      });
      break;
    }
    seen.add(item.instance_id);
  }

  return { is_valid: violations.length === 0, violations };
}
