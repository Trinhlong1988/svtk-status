/**
 * ECONOMY FOUNDATION RUNTIME — Implementation (Phase 11 Batch 5.2).
 *
 * Pure tracker — KHÔNG mutate external state. Caller systems push event vào tracker.
 *
 * Layer 3 Service (stateful per server instance) per CLAUDE.md 7B'.
 * Deterministic queries — same flow sequence + same window → same snapshot/risk.
 *
 * Anti-inflation pillar:
 *   - growth_ratio_bp (INT, 10000 = on target) — deviation classified vs anomaly/critical thresholds
 *   - sink/source ratio bp — must ≥ gold_sink_min_ratio_bp else 'critical'
 *   - rarity inflation cap per player per day (anti hoarding mythic)
 *
 * R30 + R31 hard lock: tất cả ratio/threshold INT BP (×10000).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  type EconomyFoundationRuntime,
  type GoldFlow,
  type ItemFlow,
  type EconomySnapshot,
  type InflationRiskReport,
  type GoldSourceKind,
  type GoldSinkKind,
  type ItemSourceKind,
  type ItemSinkKind,
  GoldSourceKindSchema,
  GoldSinkKindSchema,
  ItemSourceKindSchema,
  ItemSinkKindSchema,
} from './economy_foundation_runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, '../../../data/economy');

import { stripDocKeys } from '../_schema_helpers.js';

// ───────── Economy constants schema (Batch 5.4 C1 strict) ─────────
// stripDocKeys() loại bỏ `_doc` / `_locked_by` / `_dna_lock` trước Zod parse.
// Zod object STRICT (`.strict()`) → fail-fast khi gặp key lạ (vd typo `target_grow_per_day_bp`).
const GoldSourceCapsSchema = z.object({
  quest: z.number().int().nonnegative(),
  monster_drop: z.number().int().nonnegative(),
  boss_drop: z.number().int().nonnegative(),
  raid_drop: z.number().int().nonnegative(),
  dungeon_clear: z.number().int().nonnegative(),
  event_reward: z.number().int().nonnegative(),
  vendor_sell: z.number().int().nonnegative(),
  daily_login: z.number().int().nonnegative(),
  salvage_refund: z.number().int().nonnegative(),
}).strict();

const RarityInflationCapsSchema = z.object({
  common: z.number().int().nonnegative(),
  rare: z.number().int().nonnegative(),
  epic: z.number().int().nonnegative(),
  legendary: z.number().int().nonnegative(),
  mythic: z.number().int().nonnegative(),
}).strict();

const EconomyConstantsStrictSchema = z.object({
  registry_version: z.string(),
  formula_version: z.string(),
  inflation: z.object({
    target_growth_per_day_bp: z.number().int().nonnegative(),
    anomaly_threshold_bp: z.number().int().nonnegative(),
    critical_threshold_bp: z.number().int().nonnegative(),
    snapshot_window_ticks: z.number().int().positive(),
    tick_per_day_estimate: z.number().int().positive(),
  }).strict(),
  gold_source_caps_per_tick: GoldSourceCapsSchema,
  gold_sink_min_ratio_bp: z.object({ ratio_bp: z.number().int().nonnegative() }).strict(),
  item_source_kinds: z.array(z.string()),
  item_sink_kinds: z.array(z.string()),
  rarity_inflation_caps: RarityInflationCapsSchema,
  telemetry_severity: z.record(z.string(), z.string()),
  replay_drift_alert_count: z.number().int().nonnegative(),
  replay_drift_window_rolls: z.number().int().positive(),
}).strict();

type EconomyConstants = z.infer<typeof EconomyConstantsStrictSchema>;

let cachedConstants: EconomyConstants | null = null;
function loadConstants(): EconomyConstants {
  if (cachedConstants) return cachedConstants;
  const rawJson = JSON.parse(readFileSync(join(DATA_ROOT, 'economy_constants.json'), 'utf8'));
  // Batch 5.4 C1: strip safe doc keys → Zod strict reject typo.
  const cleaned = stripDocKeys(rawJson);
  const parsed = EconomyConstantsStrictSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(
      `[EconomyRuntime] economy_constants.json STRICT FAIL:\n${JSON.stringify(parsed.error.issues, null, 2)}`,
    );
  }
  cachedConstants = parsed.data;
  return cachedConstants;
}

/** Test-only reset. */
export function _resetEconomyConstantsCache(): void {
  cachedConstants = null;
}

const BP_DENOM = 10000;

// ───────── Factory ─────────

export interface EconomyRuntimeOptions {
  /** Inject custom constants (test). */
  constants?: EconomyConstants;
}

export function createEconomyFoundationRuntime(
  opts: EconomyRuntimeOptions = {},
): EconomyFoundationRuntime {
  const constants = opts.constants ?? loadConstants();
  const goldFlows: GoldFlow[] = [];
  const itemFlows: ItemFlow[] = [];

  // ───────── Index for fast cap checks ─────────
  // key = `${player}|${kind}|${tick}` for gold source per tick
  const goldSourceByPlayerKindTick = new Map<string, number>();
  // key = `${player}|${rarity}|${day}` for rarity per day
  const itemSourceByPlayerRarityDay = new Map<string, number>();

  function dayOf(tick: number): number {
    return Math.floor(tick / constants.inflation.tick_per_day_estimate);
  }

  function buildSnapshotInternal(start: number, end: number): EconomySnapshot {
    let total_gold_in = 0;
    let total_gold_out = 0;
    let total_item_in = 0;
    let total_item_out = 0;
    const rarity_in: Record<string, number> = {};
    const rarity_out: Record<string, number> = {};
    const gold_source_breakdown: Record<string, number> = {};
    const gold_sink_breakdown: Record<string, number> = {};

    for (const f of goldFlows) {
      if (f.tick < start || f.tick > end) continue;
      if (f.direction === 'source') {
        total_gold_in += f.amount;
        gold_source_breakdown[f.reason] = (gold_source_breakdown[f.reason] ?? 0) + f.amount;
      } else {
        total_gold_out += f.amount;
        gold_sink_breakdown[f.reason] = (gold_sink_breakdown[f.reason] ?? 0) + f.amount;
      }
    }
    for (const f of itemFlows) {
      if (f.tick < start || f.tick > end) continue;
      if (f.direction === 'source') {
        total_item_in += 1;
        rarity_in[f.rarity] = (rarity_in[f.rarity] ?? 0) + 1;
      } else {
        total_item_out += 1;
        rarity_out[f.rarity] = (rarity_out[f.rarity] ?? 0) + 1;
      }
    }
    return {
      tick_start: start,
      tick_end: end,
      total_gold_in,
      total_gold_out,
      total_item_in,
      total_item_out,
      rarity_in,
      rarity_out,
      gold_source_breakdown,
      gold_sink_breakdown,
    };
  }

  return {
    recordGoldSource(player_id, amount, reason, tick) {
      GoldSourceKindSchema.parse(reason);
      if (amount < 0 || !Number.isInteger(amount)) {
        throw new Error(`[EconomyRuntime] gold source amount must be non-negative INT`);
      }
      goldFlows.push({ player_id, amount, reason, direction: 'source', tick });
      const k = `${player_id}|${reason}|${tick}`;
      goldSourceByPlayerKindTick.set(k, (goldSourceByPlayerKindTick.get(k) ?? 0) + amount);
    },

    recordGoldSink(player_id, amount, reason, tick) {
      GoldSinkKindSchema.parse(reason);
      if (amount < 0 || !Number.isInteger(amount)) {
        throw new Error(`[EconomyRuntime] gold sink amount must be non-negative INT`);
      }
      goldFlows.push({ player_id, amount, reason, direction: 'sink', tick });
    },

    recordItemSource(player_id, item_id, rarity, reason, tick) {
      ItemSourceKindSchema.parse(reason);
      itemFlows.push({ player_id, item_id, rarity: rarity as ItemFlow['rarity'], reason, direction: 'source', tick });
      const k = `${player_id}|${rarity}|${dayOf(tick)}`;
      itemSourceByPlayerRarityDay.set(k, (itemSourceByPlayerRarityDay.get(k) ?? 0) + 1);
    },

    recordItemSink(player_id, item_id, rarity, reason, tick) {
      ItemSinkKindSchema.parse(reason);
      itemFlows.push({ player_id, item_id, rarity: rarity as ItemFlow['rarity'], reason, direction: 'sink', tick });
    },

    getSnapshot(tick_start, tick_end) {
      if (tick_end < tick_start) throw new Error('[EconomyRuntime] tick_end < tick_start');
      return buildSnapshotInternal(tick_start, tick_end);
    },

    computeInflationRisk(tick_start, tick_end) {
      if (tick_end < tick_start) throw new Error('[EconomyRuntime] tick_end < tick_start');
      const snap = buildSnapshotInternal(tick_start, tick_end);
      const tickRange = Math.max(1, tick_end - tick_start);
      const { target_growth_per_day_bp, anomaly_threshold_bp, critical_threshold_bp,
              tick_per_day_estimate } = constants.inflation;

      // ── A4 fix: no-flow short-circuit ──
      // No gold flow in window → cannot compute meaningful growth ratio. Return explicit
      // status 'no_flow' để dashboard không nhầm với "on target".
      if (snap.total_gold_in === 0 && snap.total_gold_out === 0) {
        return {
          growth_ratio_bp: 0,
          severity: 'ok',
          sink_source_ratio_bp: 0,
          inflated_rarity: null,
          status: 'no_flow',
          detail: `no gold flow in window [${tick_start}, ${tick_end}] — risk classification skipped`,
        };
      }

      // ── growth_ratio_bp (A3 rename) ──
      const denom = BP_DENOM * tick_per_day_estimate;
      const targetGrowthRaw = denom > 0
        ? Math.floor((snap.total_gold_in * target_growth_per_day_bp * tickRange) / denom)
        : 0;
      const actualGrowthRaw = snap.total_gold_in - snap.total_gold_out;
      // Khi targetGrowthRaw = 0 (window quá ngắn) nhưng có flow → đo deviation tuyệt đối qua sink/source.
      const growth_ratio_bp = targetGrowthRaw > 0
        ? Math.floor((actualGrowthRaw * BP_DENOM) / targetGrowthRaw)
        : (actualGrowthRaw === 0 ? BP_DENOM : 0);

      // ── sink/source ratio ──
      const denomGold = Math.max(1, snap.total_gold_in);
      const sink_source_ratio_bp = Math.floor((snap.total_gold_out * BP_DENOM) / denomGold);
      const sinkMinBP = constants.gold_sink_min_ratio_bp.ratio_bp;

      // ── inflated rarity ──
      let inflated_rarity: string | null = null;
      const players = new Set<string>();
      for (const f of itemFlows) {
        if (f.tick >= tick_start && f.tick <= tick_end && f.direction === 'source') {
          players.add(f.player_id);
        }
      }
      const playerCount = Math.max(1, players.size);
      const days = Math.max(1, Math.floor(tickRange / tick_per_day_estimate));
      const rarityCaps = constants.rarity_inflation_caps as Record<string, number>;
      const rarities = Object.keys(snap.rarity_in).sort();
      for (const r of rarities) {
        const cap = rarityCaps[r] ?? 0;
        if (cap === 0) continue;
        const limit = cap * playerCount * days;
        if ((snap.rarity_in[r] ?? 0) > limit) {
          inflated_rarity = r;
          break;
        }
      }

      // ── severity + status classification ──
      const deviation = Math.abs(growth_ratio_bp - BP_DENOM);
      let severity: InflationRiskReport['severity'] = 'ok';
      let status: InflationRiskReport['status'] = 'on_target';
      const detailParts: string[] = [];
      if (sink_source_ratio_bp < sinkMinBP && snap.total_gold_in > 0) {
        severity = 'critical';
        status = 'sink_deficit_critical';
        detailParts.push(`sink/source ${sink_source_ratio_bp} BP < min ${sinkMinBP} BP`);
      } else if (deviation > critical_threshold_bp) {
        severity = 'anomaly';
        status = 'deviation_anomaly';
        detailParts.push(`growth deviation ${deviation} BP > critical ${critical_threshold_bp} BP`);
      } else if (deviation > anomaly_threshold_bp) {
        severity = 'warning';
        status = 'deviation_warning';
        detailParts.push(`growth deviation ${deviation} BP > anomaly ${anomaly_threshold_bp} BP`);
      } else {
        detailParts.push('on target');
      }
      if (inflated_rarity) {
        detailParts.push(`inflated rarity: ${inflated_rarity}`);
        if (severity === 'ok') {
          severity = 'warning';
          status = 'deviation_warning';
        }
      }

      return {
        growth_ratio_bp,
        severity,
        sink_source_ratio_bp,
        inflated_rarity,
        status,
        detail: detailParts.join('; '),
      };
    },

    validateGoldSourceCap(player_id, kind, amount, tick) {
      const caps = constants.gold_source_caps_per_tick as Record<string, number>;
      const cap = caps[kind] ?? 0;
      if (cap === 0) return true; // uncapped
      const k = `${player_id}|${kind}|${tick}`;
      const current = goldSourceByPlayerKindTick.get(k) ?? 0;
      return (current + amount) <= cap;
    },

    validateRarityInflationCap(player_id, rarity, tick) {
      const caps = constants.rarity_inflation_caps as Record<string, number>;
      const cap = caps[rarity] ?? 0;
      if (cap === 0) return true; // uncapped (common/rare = unlimited)
      const k = `${player_id}|${rarity}|${dayOf(tick)}`;
      const current = itemSourceByPlayerRarityDay.get(k) ?? 0;
      return current < cap;
    },

    _resetForTest() {
      goldFlows.length = 0;
      itemFlows.length = 0;
      goldSourceByPlayerKindTick.clear();
      itemSourceByPlayerRarityDay.clear();
    },

    get recordCount() {
      return goldFlows.length + itemFlows.length;
    },
  };
}

// Re-export schemas for downstream tests (convenience).
export {
  GoldSourceKindSchema,
  GoldSinkKindSchema,
  ItemSourceKindSchema,
  ItemSinkKindSchema,
};
export type { GoldSourceKind, GoldSinkKind, ItemSourceKind, ItemSinkKind };
