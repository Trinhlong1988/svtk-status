/**
 * ITEM REPLAY RUNTIME — CMD2.docx Mục XIV + Mục XIX (network prep).
 *
 * Build snapshot + restore + version compat check.
 * SUPPORT: item snapshot / aggregation replay / replay restore / version compat / registry compat / deterministic restore.
 *
 * Replay-safe: same snapshot → same aggregation result.
 * Network prep: snapshot shape JSON-serializable (R30 INT only).
 */
import {
  type ItemStatBlock,
  type AggregatedStatBlock,
  type StatModifier,
} from './itemization_types.js';
import {
  type EquipmentStatProvider,
  type EquippedItemMap,
  type CharId,
} from './equipment_stat_provider.js';
import { createEquipmentStatProvider } from './equipment_aggregate.js';
import { getRegistryVersioning } from './item_registry.js';

export interface ItemSnapshot {
  char_id: CharId;
  equipped: EquippedItemMap;
  base_stats: ItemStatBlock;
  tick: number;
  /** Versioning at snapshot time (FIX #11 + #12). */
  versioning: {
    registry_content_hash: string;
    registry_version: string;
    formula_version: string;
    softcap_version: string;
  };
}

export interface ReplayResult {
  /** Aggregation từ snapshot restore. */
  restored: AggregatedStatBlock;
  /** Compat status: 'ok' / 'registry_mismatch' / 'formula_mismatch'. */
  compat_status: 'ok' | 'registry_mismatch' | 'formula_mismatch' | 'softcap_mismatch';
  /** Detail nếu mismatch. */
  detail?: string;
}

export interface ItemReplayRuntime {
  /** Build snapshot từ current state (network sync prep). */
  buildSnapshot(
    char_id: CharId,
    equipped: EquippedItemMap,
    base_stats: ItemStatBlock,
    tick: number,
  ): ItemSnapshot;

  /** Restore aggregation từ snapshot + check version compat. */
  restore(snapshot: ItemSnapshot): ReplayResult;

  /** Verify same snapshot → same aggregation (deterministic). */
  verifyDeterminism(snapshot: ItemSnapshot, runs: number): {
    divergences: number;
    sample_modifier_count: number;
  };
}

export function createItemReplayRuntime(
  provider?: EquipmentStatProvider,
): ItemReplayRuntime {
  const eq = provider ?? createEquipmentStatProvider();

  return {
    buildSnapshot(char_id, equipped, base_stats, tick) {
      const ver = getRegistryVersioning();
      return {
        char_id,
        equipped: { ...equipped },
        base_stats: { ...base_stats },
        tick,
        versioning: { ...ver },
      };
    },

    restore(snapshot) {
      const current = getRegistryVersioning();
      // Check version compat (CMD2 FIX #11 + #12)
      if (snapshot.versioning.registry_content_hash !== current.registry_content_hash) {
        return {
          restored: eq.getAggregatedStats(snapshot.char_id, snapshot.equipped, snapshot.base_stats),
          compat_status: 'registry_mismatch',
          detail: `registry hash changed: ${snapshot.versioning.registry_content_hash} → ${current.registry_content_hash}`,
        };
      }
      if (snapshot.versioning.formula_version !== current.formula_version) {
        return {
          restored: eq.getAggregatedStats(snapshot.char_id, snapshot.equipped, snapshot.base_stats),
          compat_status: 'formula_mismatch',
          detail: `formula version changed: ${snapshot.versioning.formula_version} → ${current.formula_version}`,
        };
      }
      if (snapshot.versioning.softcap_version !== current.softcap_version) {
        return {
          restored: eq.getAggregatedStats(snapshot.char_id, snapshot.equipped, snapshot.base_stats),
          compat_status: 'softcap_mismatch',
          detail: `softcap version changed: ${snapshot.versioning.softcap_version} → ${current.softcap_version}`,
        };
      }
      const restored = eq.getAggregatedStats(snapshot.char_id, snapshot.equipped, snapshot.base_stats);
      return { restored, compat_status: 'ok' };
    },

    verifyDeterminism(snapshot, runs) {
      const ref = eq.getAggregatedStats(snapshot.char_id, snapshot.equipped, snapshot.base_stats);
      const refStr = JSON.stringify(ref);
      let divergences = 0;
      for (let i = 0; i < runs; i++) {
        const out = eq.getAggregatedStats(snapshot.char_id, snapshot.equipped, snapshot.base_stats);
        if (JSON.stringify(out) !== refStr) divergences++;
      }
      return { divergences, sample_modifier_count: ref.applied_modifiers.length };
    },
  };
}

/** Pure helper exposed for downstream serialization (network sync). */
export function snapshotToJson(snapshot: ItemSnapshot): string {
  return JSON.stringify(snapshot);
}

/** Pure helper: deserialize snapshot. */
export function snapshotFromJson(json: string): ItemSnapshot {
  return JSON.parse(json) as ItemSnapshot;
}

/** Pure helper: extract modifier list for transmit (network sync). */
export function aggregatedToTransmit(agg: AggregatedStatBlock): {
  stats: ItemStatBlock;
  modifiers: readonly StatModifier[];
  versioning: AggregatedStatBlock['versioning'];
} {
  return {
    stats: agg.stats,
    modifiers: agg.applied_modifiers,
    versioning: agg.versioning,
  };
}
