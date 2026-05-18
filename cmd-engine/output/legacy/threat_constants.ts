/**
 * THREAT CONSTANTS — Zod-validated load for Phase 4.
 *
 * Source: data/threat_constants.json. INT BP scale (R30/R31).
 */
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const intNonNeg = z.number().int().nonnegative();
const intPositive = z.number().int().positive();
const intArrayBP = z.array(intNonNeg).min(1);

export const ThreatConstantsSchema = z.object({
  THREAT_COEF_DAMAGE_BP: intPositive,
  THREAT_COEF_HEAL_BP: intPositive,
  THREAT_COEF_SHIELD_BP: intPositive,
  THREAT_COEF_TAUNT_BP: intPositive,
  THREAT_COEF_PASSIVE_BP: intPositive,
  THREAT_COEF_SUMMON_BP: intPositive,
  THREAT_COEF_DOT_BP: intPositive,
  THREAT_COEF_HOT_BP: intPositive,

  ROLE_TANK_THREAT_MOD_BP: intPositive,
  ROLE_HEALER_THREAT_MOD_BP: intPositive,
  ROLE_DPS_VL_THREAT_MOD_BP: intPositive,
  ROLE_DPS_PH_THREAT_MOD_BP: intPositive,
  ROLE_SUPPORT_THREAT_MOD_BP: intPositive,
  ROLE_CONTROL_THREAT_MOD_BP: intPositive,
  ROLE_SUMMONER_THREAT_MOD_BP: intPositive,
  ASSASSIN_TAG_THREAT_MOD_BP: intPositive,

  DECAY_IDLE_BP: intNonNeg,
  DECAY_DISTANCE_BP: intNonNeg,
  DECAY_DISENGAGE_BP: intNonNeg,
  IDLE_TURNS_THRESHOLD: intPositive,

  TAUNT_DR_LEVELS_BP: intArrayBP,
  TAUNT_DR_RESET_TURNS: intPositive,
  BOSS_TAUNT_RESIST_BP: intNonNeg.max(10000),
  ELITE_TAUNT_RESIST_BP: intNonNeg.max(10000),

  MAX_THREAT_VALUE: intPositive,
  MIN_THREAT_VALUE: intNonNeg,
  MAX_TAUNT_DURATION_TURNS: intPositive,

  MAX_THREAT_RECURSION_DEPTH: intPositive,
  TARGET_SWITCH_HYSTERESIS_BP: intNonNeg,
  ANTI_EXPLOIT_FALLBACK_TURNS: intPositive,

  SUMMON_OWNER_THREAT_PROPAGATE_BP: intNonNeg.max(10000),
  PET_THREAT_SPLIT_BP: intNonNeg.max(10000),

  // FIX PHASE 4 hardening
  ENCOUNTER_LEASH_DISTANCE: intPositive,
  ENCOUNTER_DISENGAGE_TURNS: intPositive,
  ENCOUNTER_WIPE_DETECTION_TURNS: intPositive,

  COMPANION_INHERIT_PARTIAL_BP: intNonNeg.max(10000),
  COMPANION_OWNER_SHARE_BP: intNonNeg.max(10000),

  FORMATION_FRONT_THREAT_MULT_BP: intPositive,
  FORMATION_BACK_THREAT_MULT_BP: intPositive,
  FORMATION_EDGE_VULNERABILITY_BP: intPositive,

  SPATIAL_NEAR_BONUS_BP: intPositive,
  SPATIAL_FAR_DECAY_BP: intPositive,
  SPATIAL_NEAR_THRESHOLD: intPositive,
  SPATIAL_FAR_THRESHOLD: intPositive,
  SPATIAL_LINE_EXPOSURE_BP: intPositive,

  RATE_LIMIT_MAX_THREAT_PER_TICK: intPositive,
  RATE_LIMIT_MAX_THREAT_PER_ACTION: intPositive,
  RATE_LIMIT_SUMMON_BURST_CAP: intPositive,
  RATE_LIMIT_DOT_AGGREGATE_TURNS: intPositive,

  TELEMETRY_FLICKER_THRESHOLD: intPositive,
  TELEMETRY_SPIKE_ANOMALY_BP: intPositive,
  TELEMETRY_RETARGET_HIGH_FREQ_PER_TURN: intPositive,
});

export type ThreatConstants = z.infer<typeof ThreatConstantsSchema>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, '../../data');

let cached: ThreatConstants | null = null;

export function loadThreatConstants(): ThreatConstants {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(join(DATA_ROOT, 'threat_constants.json'), 'utf8'));
  const parsed = ThreatConstantsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`[ThreatConstants] schema FAIL:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
  cached = parsed.data;
  return cached;
}

export const ThreatConstants: ThreatConstants = loadThreatConstants();
