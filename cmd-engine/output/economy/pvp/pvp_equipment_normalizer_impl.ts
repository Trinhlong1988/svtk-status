/**
 * PVP EQUIPMENT NORMALIZER — Implementation (Phase 11 Batch 5.2).
 *
 * Pure deterministic transform:
 *   input ItemStatBlock → cap per mode → output normalized ItemStatBlock (NEW immutable).
 *
 * 4 mode (data/pvp_normalization.json):
 *   arena_1v1 (strict) / arena_3v3 / battleground / open_pvp (loose)
 *
 * Anti-pattern blocks (CMD2.docx PHASE 11B Mục VIII):
 *   - one-shot via damage_cap_per_hit + hp_floor protection
 *   - companion 2v1 trá hình via companion_pvp_ratio_bp scale-down
 *   - proc explosion via block_passive_types_in_pvp + max_simultaneous_procs
 *   - stat ceiling via 6 cap fields (crit_rate/crit_dmg/pen/lifesteal/dodge/proc)
 *
 * R30 + R31 hard lock: tất cả cap INT BP (×10000); raw stat INT only.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  type PvPEquipmentNormalizer,
  type PvPMode,
  type PvPCaps,
  type PvPNormalizationContext,
  type PvPValidationResult,
  type PvPDamageAudit,
  PvPCapsSchema,
} from './pvp_equipment_normalizer.js';
import type { ItemStatBlock, Element } from '../../../../cmd-item/output/legacy/itemization_types.js';
import { stripDocKeys } from '../_schema_helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, '../../../data');

const BP_DENOM = 10000;

// ───────── PvP normalization config schema (Batch 5.4 C1 strict) ─────────
// stripDocKeys() loại bỏ `_doc` / `_locked_by` / `_a1b_note` trước Zod.
// Zod strict mode mode keys explicit (4 PvP mode) → reject typo mode name.
const ModeKeyEnum = z.enum(['arena_1v1', 'arena_3v3', 'battleground', 'open_pvp']);
const ModeCapsByMode = z.object({
  arena_1v1: PvPCapsSchema.strict(),
  arena_3v3: PvPCapsSchema.strict(),
  battleground: PvPCapsSchema.strict(),
  open_pvp: PvPCapsSchema.strict(),
}).strict();

const RatioByMode = z.object({
  arena_1v1: z.number().int().positive(),
  arena_3v3: z.number().int().positive(),
  battleground: z.number().int().positive(),
  open_pvp: z.number().int().positive(),
}).strict();

const PvPNormConfigStrictSchema = z.object({
  modes: ModeCapsByMode,
  companion_pvp_ratio_bp: RatioByMode,
  proc_normalization_rules: z.object({
    block_passive_types_in_pvp: z.array(z.string()),
    max_simultaneous_procs_per_action: z.number().int().positive(),
    proc_value_scaling_bp: RatioByMode,
  }).strict(),
  telemetry_severity: z.record(z.string(), z.string()),
}).strict();

type PvPNormConfig = z.infer<typeof PvPNormConfigStrictSchema>;
// Re-export for downstream if needed.
const _ModeKeyEnum = ModeKeyEnum;
void _ModeKeyEnum;

let cachedConfig: PvPNormConfig | null = null;
function loadConfig(): PvPNormConfig {
  if (cachedConfig) return cachedConfig;
  const rawJson = JSON.parse(readFileSync(join(DATA_ROOT, 'pvp_normalization.json'), 'utf8'));
  const cleaned = stripDocKeys(rawJson);
  const parsed = PvPNormConfigStrictSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(
      `[PvPNormalizer] pvp_normalization.json STRICT FAIL:\n${JSON.stringify(parsed.error.issues, null, 2)}`,
    );
  }
  cachedConfig = parsed.data;
  return cachedConfig;
}

export function _resetPvPNormalizerCache(): void {
  cachedConfig = null;
}

/** INT chain multiplier — same convention as src/logic/constants.ts. */
function chainMul(left: number, right_bp: number): number {
  return Math.floor((left * right_bp) / BP_DENOM);
}

/** Cap helper — return min(value, cap_bp). */
function capStat(value: number | undefined, cap_bp: number): number | undefined {
  if (value === undefined) return undefined;
  return Math.min(value, cap_bp);
}

/** Scale absolute INT stat by stat_scaling_bp. */
function scaleStat(value: number | undefined, scale_bp: number): number | undefined {
  if (value === undefined) return undefined;
  return chainMul(value, scale_bp);
}

// ───────── Factory ─────────

export interface PvPNormalizerOptions {
  config?: PvPNormConfig;
}

export function createPvPEquipmentNormalizer(
  opts: PvPNormalizerOptions = {},
): PvPEquipmentNormalizer {
  const config = opts.config ?? loadConfig();

  function getCapsOrThrow(mode: PvPMode): PvPCaps {
    const cap = config.modes[mode];
    if (!cap) throw new Error(`[PvPNormalizer] unknown mode: ${mode}`);
    return cap as PvPCaps;
  }

  function normalizeInternal(
    stats: ItemStatBlock,
    caps: PvPCaps,
    pre_scale_bp?: number,
  ): ItemStatBlock {
    // 1. Pre-scale absolute INT stats (companion ratio).
    let pre: ItemStatBlock = pre_scale_bp ? {
      hp: scaleStat(stats.hp, pre_scale_bp),
      sat_luc: scaleStat(stats.sat_luc, pre_scale_bp),
      phap_luc: scaleStat(stats.phap_luc, pre_scale_bp),
      defense: scaleStat(stats.defense, pre_scale_bp),
      agility: scaleStat(stats.agility, pre_scale_bp),
      hp_regen_per_turn: scaleStat(stats.hp_regen_per_turn, pre_scale_bp),
      mana_regen_per_turn: scaleStat(stats.mana_regen_per_turn, pre_scale_bp),
      // BP percent stats also scaled by pre_scale (companion weaker even on % stat).
      crit_rate_bp: scaleStat(stats.crit_rate_bp, pre_scale_bp),
      // Batch 5.4 A2 fix: ALL combat percentage stats scale consistently (no hidden whitelist).
      crit_dmg_bp: scaleStat(stats.crit_dmg_bp, pre_scale_bp),
      penetration_bp: scaleStat(stats.penetration_bp, pre_scale_bp),
      threat_coef_bp: stats.threat_coef_bp,
      lifesteal_bp: scaleStat(stats.lifesteal_bp, pre_scale_bp),
      dodge_bp: scaleStat(stats.dodge_bp, pre_scale_bp),
      element_mod_bp: stats.element_mod_bp,
      element_resist_bp: stats.element_resist_bp,
      has_crit: stats.has_crit,
    } : stats;

    // 2. Stat scaling (mode-wide).
    if (caps.stat_scaling_bp !== BP_DENOM) {
      pre = {
        hp: scaleStat(pre.hp, caps.stat_scaling_bp),
        sat_luc: scaleStat(pre.sat_luc, caps.stat_scaling_bp),
        phap_luc: scaleStat(pre.phap_luc, caps.stat_scaling_bp),
        defense: scaleStat(pre.defense, caps.stat_scaling_bp),
        agility: scaleStat(pre.agility, caps.stat_scaling_bp),
        hp_regen_per_turn: scaleStat(pre.hp_regen_per_turn, caps.stat_scaling_bp),
        mana_regen_per_turn: scaleStat(pre.mana_regen_per_turn, caps.stat_scaling_bp),
        crit_rate_bp: pre.crit_rate_bp,
        crit_dmg_bp: pre.crit_dmg_bp,
        penetration_bp: pre.penetration_bp,
        threat_coef_bp: pre.threat_coef_bp,
        lifesteal_bp: pre.lifesteal_bp,
        dodge_bp: pre.dodge_bp,
        element_mod_bp: pre.element_mod_bp,
        element_resist_bp: pre.element_resist_bp,
        has_crit: pre.has_crit,
      };
    }

    // 3. Cap percent stats.
    return {
      hp: pre.hp,
      sat_luc: pre.sat_luc,
      phap_luc: pre.phap_luc,
      defense: pre.defense,
      agility: pre.agility,
      hp_regen_per_turn: pre.hp_regen_per_turn,
      mana_regen_per_turn: pre.mana_regen_per_turn,
      crit_rate_bp: capStat(pre.crit_rate_bp, caps.max_crit_rate_bp),
      crit_dmg_bp: capStat(pre.crit_dmg_bp, caps.max_crit_dmg_bp),
      penetration_bp: capStat(pre.penetration_bp, caps.max_penetration_bp),
      threat_coef_bp: pre.threat_coef_bp,
      lifesteal_bp: capStat(pre.lifesteal_bp, caps.max_lifesteal_bp),
      dodge_bp: capStat(pre.dodge_bp, caps.max_dodge_bp),
      element_mod_bp: pre.element_mod_bp ? freezeElementMap(pre.element_mod_bp) : undefined,
      element_resist_bp: pre.element_resist_bp ? freezeElementMap(pre.element_resist_bp) : undefined,
      has_crit: pre.has_crit,
    };
  }

  return {
    normalize(stats, context) {
      const caps = getCapsOrThrow(context.mode);
      return normalizeInternal(stats, caps);
    },

    normalizeCompanion(companion_stats, context) {
      const caps = getCapsOrThrow(context.mode);
      const companion_ratio = config.companion_pvp_ratio_bp[context.mode];
      if (companion_ratio === undefined) {
        throw new Error(`[PvPNormalizer] companion_pvp_ratio_bp missing for mode: ${context.mode}`);
      }
      return normalizeInternal(companion_stats, caps, companion_ratio);
    },

    normalizeProc(proc_value, context) {
      const caps = getCapsOrThrow(context.mode);
      const scale_bp = config.proc_normalization_rules.proc_value_scaling_bp[context.mode];
      if (scale_bp === undefined) {
        throw new Error(`[PvPNormalizer] proc_value_scaling_bp missing for mode: ${context.mode}`);
      }
      const scaled = chainMul(proc_value, scale_bp);
      return Math.min(scaled, caps.max_proc_chance_bp);
    },

    auditDamage(raw_damage, target_max_hp, context) {
      const caps = getCapsOrThrow(context.mode);
      // Batch 5.4 A1.b: 2-layer guard.
      // Layer 1 — damage_cap_per_hit_pct_bp clamp max damage.
      // Layer 2 — hp_floor_pct_bp guarantee remaining HP ≥ floor (defense-in-depth khi
      //          cap > 100% - hp_floor%, vd open_pvp cap 90% + floor 15% → max damage 85%).
      const cap_per_hit = chainMul(target_max_hp, caps.damage_cap_per_hit_pct_bp);
      const hp_floor = chainMul(target_max_hp, caps.hp_floor_pct_bp);
      let capped = Math.min(raw_damage, cap_per_hit);
      const cap_hit = capped < raw_damage;
      let hp_floor_protected = false;
      if (hp_floor > 0) {
        const max_allowed = Math.max(0, target_max_hp - hp_floor);
        if (capped > max_allowed) {
          capped = max_allowed;
          hp_floor_protected = true;
        }
      }
      return {
        raw_damage,
        capped_damage: capped,
        cap_hit,
        hp_floor_protected,
      } satisfies PvPDamageAudit;
    },

    validateLoadout(equipped_passives, stats, context) {
      const caps = getCapsOrThrow(context.mode);
      const blocked = new Set(config.proc_normalization_rules.block_passive_types_in_pvp);
      // Sort lex deterministic for replay-safe ordering.
      const blocked_passives = [...new Set(equipped_passives)]
        .filter(p => blocked.has(p))
        .sort();
      const capped_stats: PvPValidationResult['capped_stats'] = [];
      // Check each capped stat field (sort key lex deterministic).
      const cap_checks: Array<{ key: keyof ItemStatBlock; cap_bp: number }> = [
        { key: 'crit_dmg_bp', cap_bp: caps.max_crit_dmg_bp },
        { key: 'crit_rate_bp', cap_bp: caps.max_crit_rate_bp },
        { key: 'dodge_bp', cap_bp: caps.max_dodge_bp },
        { key: 'lifesteal_bp', cap_bp: caps.max_lifesteal_bp },
        { key: 'penetration_bp', cap_bp: caps.max_penetration_bp },
      ];
      for (const { key, cap_bp } of cap_checks) {
        const raw = stats[key];
        if (typeof raw === 'number' && raw > cap_bp) {
          capped_stats.push({ stat_key: key, raw, capped: cap_bp });
        }
      }
      return {
        is_valid: blocked_passives.length === 0 && capped_stats.length === 0,
        blocked_passives,
        capped_stats,
      };
    },

    getCaps(mode) {
      return getCapsOrThrow(mode);
    },
  };
}

/** Deterministic copy of element map (sort keys lex). */
function freezeElementMap(m: Partial<Record<Element, number>>): Partial<Record<Element, number>> {
  const out: Partial<Record<Element, number>> = {};
  const keys = Object.keys(m).sort() as Element[];
  for (const k of keys) out[k] = m[k];
  return out;
}
