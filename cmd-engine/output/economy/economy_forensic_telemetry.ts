/**
 * ECONOMY FORENSIC TELEMETRY — Phase 11B Mục VII + XIII.
 *
 * Production diagnostics surface — pure observability:
 *   pull data từ EconomyFoundationRuntime (read-only) → detect anomaly → emit event.
 *
 * 8 metric tracked (Mục VII):
 *   1. gold_velocity         — gold generated / tick
 *   2. rarity_saturation     — % share per rarity vs total drops
 *   3. sink_source_imbalance — sink/source ratio drift
 *   4. salvage_amplification — gold from salvage / original item cost
 *   5. duplicate_reward_path — same (player, item_id, tick) ≥ 2 records
 *   6. affix_inflation       — avg affix magnitude per rarity drift
 *   7. crafting_amplification— craft output value / input value ratio
 *   8. upgrade_inflation     — stat gain per upgrade tier delta vs baseline
 *
 * Wire pattern (Mục XIII): caller plug `EconomyForensicHook` →
 *   forward emit() sang global TelemetryService (CMD1 anomaly_kind enum) ngoài scope file này.
 *
 * Deterministic detection — same flow sequence + same window → same alert ALWAYS.
 *
 * R30 + R31: tất cả threshold INT BP. Ratios là INT BP scaled (10000 = 1.0).
 */
import type { EconomyFoundationRuntime } from './foundation/economy_foundation_runtime.js';
import type { LootRollResult } from './loot/loot_generation_runtime.js';

const BP_DENOM = 10000;

// ───────── Event kinds (Phase 11B Mục VII base + Batch 5.3 Mục VIII extension) ─────────
export const FORENSIC_EVENT_KINDS = [
  'gold_velocity_anomaly',
  'rarity_saturation_anomaly',
  'sink_source_imbalance',
  'salvage_amplification_anomaly',
  'duplicate_reward_path',
  'affix_inflation_anomaly',
  'crafting_amplification_anomaly',
  'upgrade_inflation_anomaly',
  // Batch 5.3 — inventory + serialization mismatch (Mục VIII expansion)
  'inventory_divergence',
  'replay_inventory_mismatch',
] as const;
export type EconomyForensicEventKind = (typeof FORENSIC_EVENT_KINDS)[number];

export type ForensicSeverity = 'info' | 'warning' | 'anomaly' | 'critical';

export interface EconomyForensicEvent {
  kind: EconomyForensicEventKind;
  severity: ForensicSeverity;
  tick_start: number;
  tick_end: number;
  detail: string;
  /** Detected ratio_bp / magnitude — INT for replay-safe assertion. */
  value_bp: number;
  /** Optional player scope. */
  player_id?: string;
}

export interface EconomyForensicHook {
  emit(event: EconomyForensicEvent): void;
}

/** Default in-memory hook — accumulate events for inspection/test. */
export function createInMemoryForensicHook(): EconomyForensicHook & {
  readonly events: readonly EconomyForensicEvent[];
  clear(): void;
} {
  const events: EconomyForensicEvent[] = [];
  return {
    emit(event) { events.push(event); },
    get events() { return events; },
    clear() { events.length = 0; },
  };
}

// ───────── Forensic thresholds (overridable) ─────────
export interface ForensicThresholds {
  /** Gold/tick anomaly multiplier vs baseline. Default 3× = 30000 BP. */
  velocity_anomaly_multiplier_bp: number;
  /** Rarity share above which counts as saturated. Mythic default 100 BP = 1%. */
  rarity_saturation_caps_bp: Record<string, number>;
  /** Salvage refund / generated_value ratio above which = amplification. Default 5000 BP = 50%. */
  salvage_amplification_cap_bp: number;
  /** Craft output / input ratio above which = amplification. Default 13000 BP = 130%. */
  crafting_amplification_cap_bp: number;
  /** Upgrade stat gain delta above which = inflation. Default 12000 BP = 120%. */
  upgrade_inflation_cap_bp: number;
  /** Affix magnitude drift above which = inflation. Default 2000 BP = 20% drift. */
  affix_drift_cap_bp: number;
}

export const DEFAULT_FORENSIC_THRESHOLDS: ForensicThresholds = Object.freeze({
  velocity_anomaly_multiplier_bp: 30000,
  rarity_saturation_caps_bp: {
    common: 8000,    // 80% common = healthy ceiling
    rare: 4000,
    epic: 1500,
    legendary: 400,
    mythic: 100,
  },
  salvage_amplification_cap_bp: 5000,
  crafting_amplification_cap_bp: 13000,
  upgrade_inflation_cap_bp: 12000,
  affix_drift_cap_bp: 2000,
});

// ───────── Severity helpers ─────────
function classifyDeviation(deviation_bp: number, anomaly_bp: number, critical_bp: number): ForensicSeverity {
  if (deviation_bp > critical_bp) return 'critical';
  if (deviation_bp > anomaly_bp) return 'anomaly';
  if (deviation_bp > Math.floor(anomaly_bp / 2)) return 'warning';
  return 'info';
}

// ───────── Public forensic runtime ─────────

export interface EconomyForensicRuntime {
  /** Run full forensic scan over [tick_start, tick_end]. Emit detected events. */
  scan(tick_start: number, tick_end: number): EconomyForensicEvent[];

  /** Scan single metric — gold velocity. */
  scanGoldVelocity(tick_start: number, tick_end: number, baseline_per_tick?: number): EconomyForensicEvent[];

  /** Scan rarity saturation distribution. */
  scanRaritySaturation(tick_start: number, tick_end: number): EconomyForensicEvent[];

  /** Scan sink/source imbalance. */
  scanSinkSourceImbalance(tick_start: number, tick_end: number, min_ratio_bp: number): EconomyForensicEvent[];

  /** Scan duplicate reward paths. */
  scanDuplicateRewards(tick_start: number, tick_end: number): EconomyForensicEvent[];

  /** Record + audit salvage operation. */
  recordSalvage(player_id: string, original_value: number, refund_value: number, tick: number): EconomyForensicEvent | null;

  /** Record + audit craft operation. */
  recordCraft(player_id: string, input_value: number, output_value: number, tick: number): EconomyForensicEvent | null;

  /** Record + audit upgrade operation. */
  recordUpgrade(player_id: string, prev_stat: number, new_stat: number, tick: number): EconomyForensicEvent | null;

  /** Record + audit affix roll for inflation drift. */
  recordAffixRoll(rarity: string, roll: LootRollResult, tick: number): EconomyForensicEvent | null;

  /**
   * Batch 5.3 Mục VIII — inventory divergence detection.
   * Compare two inventory checksums; emit if mismatch.
   */
  recordInventoryDivergence(
    player_id: string,
    expected_checksum: string,
    actual_checksum: string,
    tick: number,
  ): EconomyForensicEvent | null;

  /**
   * Batch 5.3 Mục VIII — replay inventory mismatch.
   * Compare replay outcome inventory vs baseline; emit if drift.
   */
  recordReplayInventoryMismatch(
    player_id: string,
    baseline_checksum: string,
    replay_checksum: string,
    tick: number,
    drift_count: number,
  ): EconomyForensicEvent | null;

  /** Total events emitted (telemetry counter). */
  readonly emittedCount: number;
}

export interface ForensicRuntimeOptions {
  hook?: EconomyForensicHook;
  thresholds?: ForensicThresholds;
}

export function createEconomyForensicRuntime(
  econ: EconomyFoundationRuntime,
  opts: ForensicRuntimeOptions = {},
): EconomyForensicRuntime {
  const hook = opts.hook ?? createInMemoryForensicHook();
  const thresholds = opts.thresholds ?? DEFAULT_FORENSIC_THRESHOLDS;
  let emitted = 0;

  function emit(event: EconomyForensicEvent): EconomyForensicEvent {
    hook.emit(event);
    emitted++;
    return event;
  }

  // Affix baseline tracker — moving avg per rarity for drift detection.
  const affixBaseline = new Map<string, { sumMag: number; count: number }>();

  return {
    scan(tick_start, tick_end) {
      const out: EconomyForensicEvent[] = [];
      out.push(...this.scanGoldVelocity(tick_start, tick_end));
      out.push(...this.scanRaritySaturation(tick_start, tick_end));
      out.push(...this.scanSinkSourceImbalance(tick_start, tick_end, 7000));
      out.push(...this.scanDuplicateRewards(tick_start, tick_end));
      return out;
    },

    scanGoldVelocity(tick_start, tick_end, baseline_per_tick) {
      const snap = econ.getSnapshot(tick_start, tick_end);
      const range = Math.max(1, tick_end - tick_start);
      const actual_per_tick = Math.floor(snap.total_gold_in / range);
      const baseline = baseline_per_tick ?? Math.max(1, Math.floor(snap.total_gold_in / Math.max(1, range)));
      if (baseline <= 0) return [];
      const ratio_bp = Math.floor((actual_per_tick * BP_DENOM) / baseline);
      const events: EconomyForensicEvent[] = [];
      if (ratio_bp > thresholds.velocity_anomaly_multiplier_bp) {
        events.push(emit({
          kind: 'gold_velocity_anomaly',
          severity: 'anomaly',
          tick_start, tick_end,
          detail: `gold velocity ${actual_per_tick}/tick = ${ratio_bp} BP of baseline ${baseline}/tick (threshold ${thresholds.velocity_anomaly_multiplier_bp} BP)`,
          value_bp: ratio_bp,
        }));
      }
      return events;
    },

    scanRaritySaturation(tick_start, tick_end) {
      const snap = econ.getSnapshot(tick_start, tick_end);
      const totalDrops = snap.total_item_in;
      if (totalDrops <= 0) return [];
      const events: EconomyForensicEvent[] = [];
      const rarityKeys = Object.keys(snap.rarity_in).sort();
      for (const r of rarityKeys) {
        const cap = thresholds.rarity_saturation_caps_bp[r];
        if (cap === undefined) continue;
        const share_bp = Math.floor(((snap.rarity_in[r] ?? 0) * BP_DENOM) / totalDrops);
        if (share_bp > cap) {
          const deviation = share_bp - cap;
          events.push(emit({
            kind: 'rarity_saturation_anomaly',
            severity: classifyDeviation(deviation, cap, cap * 2),
            tick_start, tick_end,
            detail: `rarity "${r}" share ${share_bp} BP > cap ${cap} BP (count ${snap.rarity_in[r]}/${totalDrops})`,
            value_bp: share_bp,
          }));
        }
      }
      return events;
    },

    scanSinkSourceImbalance(tick_start, tick_end, min_ratio_bp) {
      const snap = econ.getSnapshot(tick_start, tick_end);
      if (snap.total_gold_in <= 0) return [];
      const ratio_bp = Math.floor((snap.total_gold_out * BP_DENOM) / Math.max(1, snap.total_gold_in));
      if (ratio_bp >= min_ratio_bp) return [];
      const deficit = min_ratio_bp - ratio_bp;
      return [emit({
        kind: 'sink_source_imbalance',
        severity: classifyDeviation(deficit, 1000, 3000),
        tick_start, tick_end,
        detail: `sink/source ${ratio_bp} BP < min ${min_ratio_bp} BP (deficit ${deficit} BP)`,
        value_bp: ratio_bp,
      })];
    },

    scanDuplicateRewards(tick_start, tick_end) {
      // Detect (player, item_id, tick) appearing ≥ 2x in source flows.
      const snap = econ.getSnapshot(tick_start, tick_end);
      if (snap.total_item_in <= 0) return [];
      // Re-scan economy raw — em access via getSnapshot không trả flow detail.
      // Phase 11B: pull duplicate detection thông qua flow stream khi runtime expose.
      // Hiện tại runtime expose recordCount only — em emit conservative warning
      // nếu rarity_in mythic > 5 items/scan-window (heuristic không có duplicate access).
      const mythicCount = snap.rarity_in['mythic'] ?? 0;
      if (mythicCount >= 5) {
        return [emit({
          kind: 'duplicate_reward_path',
          severity: 'warning',
          tick_start, tick_end,
          detail: `mythic count ${mythicCount} suspiciously high in window — investigate duplicate reward path`,
          value_bp: mythicCount,
        })];
      }
      return [];
    },

    recordSalvage(player_id, original_value, refund_value, tick) {
      if (original_value <= 0) return null;
      const ratio_bp = Math.floor((refund_value * BP_DENOM) / original_value);
      if (ratio_bp > thresholds.salvage_amplification_cap_bp) {
        return emit({
          kind: 'salvage_amplification_anomaly',
          severity: classifyDeviation(ratio_bp - thresholds.salvage_amplification_cap_bp, 1000, 5000),
          tick_start: tick, tick_end: tick,
          detail: `salvage refund ${refund_value} / original ${original_value} = ${ratio_bp} BP > cap ${thresholds.salvage_amplification_cap_bp} BP`,
          value_bp: ratio_bp,
          player_id,
        });
      }
      return null;
    },

    recordCraft(player_id, input_value, output_value, tick) {
      if (input_value <= 0) return null;
      const ratio_bp = Math.floor((output_value * BP_DENOM) / input_value);
      if (ratio_bp > thresholds.crafting_amplification_cap_bp) {
        return emit({
          kind: 'crafting_amplification_anomaly',
          severity: classifyDeviation(ratio_bp - thresholds.crafting_amplification_cap_bp, 2000, 8000),
          tick_start: tick, tick_end: tick,
          detail: `craft output ${output_value} / input ${input_value} = ${ratio_bp} BP > cap ${thresholds.crafting_amplification_cap_bp} BP`,
          value_bp: ratio_bp,
          player_id,
        });
      }
      return null;
    },

    recordUpgrade(player_id, prev_stat, new_stat, tick) {
      if (prev_stat <= 0) return null;
      const ratio_bp = Math.floor((new_stat * BP_DENOM) / prev_stat);
      if (ratio_bp > thresholds.upgrade_inflation_cap_bp) {
        return emit({
          kind: 'upgrade_inflation_anomaly',
          severity: classifyDeviation(ratio_bp - thresholds.upgrade_inflation_cap_bp, 1000, 5000),
          tick_start: tick, tick_end: tick,
          detail: `upgrade ${prev_stat} → ${new_stat} = ${ratio_bp} BP > cap ${thresholds.upgrade_inflation_cap_bp} BP`,
          value_bp: ratio_bp,
          player_id,
        });
      }
      return null;
    },

    recordAffixRoll(rarity, roll, tick) {
      const sumMag = roll.affixes.reduce((s, a) => s + Math.abs(a.value_bp_or_raw), 0);
      const count = roll.affixes.length;
      if (count === 0) return null;
      const avg = Math.floor(sumMag / count);
      let baseline = affixBaseline.get(rarity);
      if (!baseline) {
        baseline = { sumMag: 0, count: 0 };
        affixBaseline.set(rarity, baseline);
      }
      // Update moving avg first
      baseline.sumMag += sumMag;
      baseline.count += count;
      const baselineAvg = Math.floor(baseline.sumMag / Math.max(1, baseline.count));
      if (baselineAvg <= 0) return null;
      const drift_bp = Math.floor((Math.abs(avg - baselineAvg) * BP_DENOM) / baselineAvg);
      if (drift_bp > thresholds.affix_drift_cap_bp) {
        return emit({
          kind: 'affix_inflation_anomaly',
          severity: classifyDeviation(drift_bp - thresholds.affix_drift_cap_bp, 1000, 3000),
          tick_start: tick, tick_end: tick,
          detail: `rarity "${rarity}" affix avg ${avg} drift ${drift_bp} BP vs baseline ${baselineAvg} (cap ${thresholds.affix_drift_cap_bp} BP)`,
          value_bp: drift_bp,
        });
      }
      return null;
    },

    recordInventoryDivergence(player_id, expected_checksum, actual_checksum, tick) {
      if (expected_checksum === actual_checksum) return null;
      return emit({
        kind: 'inventory_divergence',
        severity: 'critical',
        tick_start: tick, tick_end: tick,
        detail: `player "${player_id}" inventory checksum mismatch: expected ${expected_checksum} vs actual ${actual_checksum}`,
        value_bp: 0,
        player_id,
      });
    },

    recordReplayInventoryMismatch(player_id, baseline_checksum, replay_checksum, tick, drift_count) {
      if (baseline_checksum === replay_checksum && drift_count === 0) return null;
      return emit({
        kind: 'replay_inventory_mismatch',
        severity: drift_count > 5 ? 'critical' : 'anomaly',
        tick_start: tick, tick_end: tick,
        detail: `player "${player_id}" replay inventory drift (${drift_count} item divergent) — baseline ${baseline_checksum} vs replay ${replay_checksum}`,
        value_bp: drift_count,
        player_id,
      });
    },

    get emittedCount() { return emitted; },
  };
}
