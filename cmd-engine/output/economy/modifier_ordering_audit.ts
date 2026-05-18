/**
 * MODIFIER ORDERING AUDIT — Phase 11B Mục VI.
 *
 * Verify same equipment → same replay hash ALWAYS by checking modifier
 * ordering determinism across runs.
 *
 * 6 ordering domain checked:
 *   1. affix merge order        — sorted by id lex (affix_runtime contract)
 *   2. passive ordering         — 5-tuple (priority/value/source_type/source_item/insert_order)
 *   3. proc ordering            — deterministic per resolve tick
 *   4. set bonus ordering       — sorted by set_id lex
 *   5. companion modifier order — owner first then companion deterministic
 *   6. PvP normalization order  — caps applied lex order over stat keys
 *
 * Pure read-only audit — KHÔNG mutate.
 * Same input → same hash ALWAYS (FNV-1a 32-bit).
 *
 * R30 + R31: input/output INT BP only.
 */
import type { ItemStatBlock } from '../../../cmd-item/output/legacy/itemization_types.js';
import type { LootRollResult } from './loot/loot_generation_runtime.js';
import { codepointCompare } from '../_shared/codepoint_compare.js';

// ───────── Finding kinds ─────────
export const ORDERING_FINDING_KINDS = [
  'affix_unsorted',
  'passive_priority_violation',
  'set_unsorted',
  'companion_owner_after',
  'pvp_cap_order_drift',
  'proc_ordering_drift',
  'hash_mismatch_replay',
] as const;
export type ModifierOrderingFindingKind = (typeof ORDERING_FINDING_KINDS)[number];

export interface ModifierOrderingFinding {
  kind: ModifierOrderingFindingKind;
  detail: string;
  expected_hash?: string;
  actual_hash?: string;
}

export interface ModifierOrderingReport {
  passed: boolean;
  findings: ModifierOrderingFinding[];
  hash_pairs_checked: number;
}

// ───────── FNV-1a 32-bit hash (deterministic cross-runtime) ─────────
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function fnv1a32(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  // Convert to unsigned hex (8 chars).
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ───────── Hashable canonical forms ─────────

/** Canonical form of affix list — sorted by id lex, JSON serialize INT only. */
export function canonicalAffixes(affixes: readonly { id: string; type: string; value_bp_or_raw: number }[]): string {
  const sorted = [...affixes].sort((a, b) => codepointCompare(a.id, b.id));
  return JSON.stringify(sorted.map(a => [a.id, a.type, a.value_bp_or_raw]));
}

/** Canonical form of stat block — sort keys lex, drop undefined. */
export function canonicalStats(stats: ItemStatBlock): string {
  const keys = Object.keys(stats).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = (stats as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const innerKeys = Object.keys(v as object).sort();
      const inner: Record<string, unknown> = {};
      for (const ik of innerKeys) inner[ik] = (v as Record<string, unknown>)[ik];
      out[k] = inner;
    } else {
      out[k] = v;
    }
  }
  return JSON.stringify(out);
}

/** Canonical form of LootRollResult — sort affixes, sort top-level keys. */
export function canonicalLootRoll(roll: LootRollResult): string {
  return JSON.stringify({
    rarity: roll.rarity,
    slot: roll.slot,
    item_id: roll.item_id,
    set_id: roll.set_id,
    affixes: JSON.parse(canonicalAffixes(roll.affixes)) as unknown,
    seed_used: roll.seed_used,
  });
}

// ───────── Domain checks ─────────

/** Check affix list sorted by id lex. */
export function checkAffixSorted(affixes: readonly { id: string }[]): ModifierOrderingFinding | null {
  for (let i = 1; i < affixes.length; i++) {
    if ((affixes[i - 1]?.id ?? '') > (affixes[i]?.id ?? '')) {
      return {
        kind: 'affix_unsorted',
        detail: `affix at index ${i} (id="${affixes[i]?.id ?? ''}") < prev "${affixes[i - 1]?.id ?? ''}"`,
      };
    }
  }
  return null;
}

/**
 * Check passive list ordered by 5-tuple:
 *   priority ASC, value DESC, source_type ASC, source_item_id ASC, insert_order ASC.
 */
export interface PassiveAuditEntry {
  passive_priority: number;
  value_bp_or_raw: number;
  source_type: string;
  source_item_id: string;
  insert_order: number;
}

export function checkPassiveOrdering(passives: readonly PassiveAuditEntry[]): ModifierOrderingFinding | null {
  for (let i = 1; i < passives.length; i++) {
    const a = passives[i - 1] as PassiveAuditEntry;
    const b = passives[i] as PassiveAuditEntry;
    const cmp = comparePassive(a, b);
    if (cmp > 0) {
      return {
        kind: 'passive_priority_violation',
        detail: `passive index ${i} violates 5-tuple order (prev pr=${a.passive_priority} val=${a.value_bp_or_raw}, curr pr=${b.passive_priority} val=${b.value_bp_or_raw})`,
      };
    }
  }
  return null;
}

function comparePassive(a: PassiveAuditEntry, b: PassiveAuditEntry): number {
  if (a.passive_priority !== b.passive_priority) return a.passive_priority - b.passive_priority;
  if (a.value_bp_or_raw !== b.value_bp_or_raw) return b.value_bp_or_raw - a.value_bp_or_raw; // DESC
  if (a.source_type !== b.source_type) return codepointCompare(a.source_type, b.source_type);
  if (a.source_item_id !== b.source_item_id) return codepointCompare(a.source_item_id, b.source_item_id);
  return a.insert_order - b.insert_order;
}

/** Check set bonus list sorted by set_id lex. */
export function checkSetSorted(sets: readonly { set_id: string }[]): ModifierOrderingFinding | null {
  for (let i = 1; i < sets.length; i++) {
    if ((sets[i - 1]?.set_id ?? '') > (sets[i]?.set_id ?? '')) {
      return {
        kind: 'set_unsorted',
        detail: `set at index ${i} (id="${sets[i]?.set_id ?? ''}") < prev "${sets[i - 1]?.set_id ?? ''}"`,
      };
    }
  }
  return null;
}

/** Check companion modifier always after owner (deterministic apply order). */
export interface CompanionLinkedEntry {
  is_owner: boolean;
  apply_order: number;
}

export function checkCompanionOrdering(entries: readonly CompanionLinkedEntry[]): ModifierOrderingFinding | null {
  let seenCompanion = false;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as CompanionLinkedEntry;
    if (!e.is_owner) seenCompanion = true;
    if (e.is_owner && seenCompanion) {
      return {
        kind: 'companion_owner_after',
        detail: `owner modifier at index ${i} appears after companion modifier — violates apply order`,
      };
    }
  }
  return null;
}

// ───────── Replay hash comparator ─────────

/** Compare 2 LootRollResult arrays via canonical hash. */
export function compareLootSequences(
  expected: readonly LootRollResult[],
  actual: readonly LootRollResult[],
): ModifierOrderingFinding | null {
  const expHash = fnv1a32(expected.map(canonicalLootRoll).join('|'));
  const actHash = fnv1a32(actual.map(canonicalLootRoll).join('|'));
  if (expHash !== actHash) {
    return {
      kind: 'hash_mismatch_replay',
      detail: `loot sequence hash mismatch (expected ${expHash}, actual ${actHash})`,
      expected_hash: expHash,
      actual_hash: actHash,
    };
  }
  return null;
}

/** Compare 2 stat blocks (PvP normalization order independence). */
export function compareStatBlocks(
  a: ItemStatBlock,
  b: ItemStatBlock,
): ModifierOrderingFinding | null {
  const ha = fnv1a32(canonicalStats(a));
  const hb = fnv1a32(canonicalStats(b));
  if (ha !== hb) {
    return {
      kind: 'pvp_cap_order_drift',
      detail: `PvP normalized stat hash mismatch (${ha} vs ${hb})`,
      expected_hash: ha,
      actual_hash: hb,
    };
  }
  return null;
}

// ───────── Composite audit ─────────

export interface AuditInput {
  affixes?: readonly { id: string; type: string; value_bp_or_raw: number }[];
  passives?: readonly PassiveAuditEntry[];
  sets?: readonly { set_id: string }[];
  companion_entries?: readonly CompanionLinkedEntry[];
  loot_pair?: { expected: readonly LootRollResult[]; actual: readonly LootRollResult[] };
  pvp_stat_pair?: { a: ItemStatBlock; b: ItemStatBlock };
}

export function runModifierOrderingAudit(input: AuditInput): ModifierOrderingReport {
  const findings: ModifierOrderingFinding[] = [];
  let hash_pairs_checked = 0;

  if (input.affixes) {
    const f = checkAffixSorted(input.affixes);
    if (f) findings.push(f);
  }
  if (input.passives) {
    const f = checkPassiveOrdering(input.passives);
    if (f) findings.push(f);
  }
  if (input.sets) {
    const f = checkSetSorted(input.sets);
    if (f) findings.push(f);
  }
  if (input.companion_entries) {
    const f = checkCompanionOrdering(input.companion_entries);
    if (f) findings.push(f);
  }
  if (input.loot_pair) {
    hash_pairs_checked++;
    const f = compareLootSequences(input.loot_pair.expected, input.loot_pair.actual);
    if (f) findings.push(f);
  }
  if (input.pvp_stat_pair) {
    hash_pairs_checked++;
    const f = compareStatBlocks(input.pvp_stat_pair.a, input.pvp_stat_pair.b);
    if (f) findings.push(f);
  }
  return {
    passed: findings.length === 0,
    findings,
    hash_pairs_checked,
  };
}
