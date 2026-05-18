/**
 * SKILL CONSTANTS — Zod-validated load for Phase 3.
 *
 * Source: data/skill_constants.json. INT BP scale (R30/R31).
 */
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const intNonNeg = z.number().int().nonnegative();
const intPositive = z.number().int().positive();

export const SkillConstantsSchema = z.object({
  GLOBAL_COOLDOWN_TURNS: intNonNeg,
  MAX_COMBO_DEPTH: intPositive,
  MAX_COMBO_OUTPUT_PER_RULE: intPositive,

  // Turn orchestration (FIX PHASE 3 — verified from TS Online decode)
  TURN_DELAY_MS: intPositive,
  PVE_TURN_DURATION_SEC: intPositive,
  BOSS_TURN_DURATION_SEC: intPositive,
  PVP_TURN_DURATION_SEC: intPositive,
  AFK_TIMEOUT_TURNS: intPositive,
  RECONNECT_GRACE_SEC: intPositive,
  COMPANION_SWAP_COOLDOWN_TURNS: intPositive,
  MAX_FORMATION_SLOTS_PER_TEAM: intPositive,
  MAX_PARTY_PLAYERS: intPositive,

  // FIX PHASE 3 § "TS feel" — animation/playback constants (verified TS gốc Main.unity:681 frameRate=4)
  ANIM_FRAME_RATE: intPositive,
  ANIM_FRAME_DURATION_MS: intPositive,
  IMPACT_FRAME_DEFAULT: intPositive,
  PROJECTILE_TRAVEL_MS_DEFAULT: intPositive,
  BOSS_WINDUP_MS_DEFAULT: intPositive,
  STATUS_TICK_VISUAL_MS: intPositive,
  TIMELINE_MAX_EVENTS_PER_TURN: intPositive,
  PLAYBACK_QUEUE_MAX_DEPTH: intPositive,

  MANA_COST_REDUCTION_CAP_BP: intNonNeg.max(10000),
  HASTE_COOLDOWN_REDUCTION_CAP_BP: intNonNeg.max(10000),

  SCALING_LV_MIN: intPositive,
  SCALING_LV_MAX: intPositive,
  SCALING_LINEAR_MAX_GROWTH_BP: intPositive,

  TARGET_AOE_MAX_HITS: intPositive,
  TARGET_LINE_MAX_HITS: intPositive,

  CAST_TIME_MS_MIN: intNonNeg,
  CAST_TIME_MS_MAX: intPositive,
  COOLDOWN_TURNS_MIN: intNonNeg,
  COOLDOWN_TURNS_MAX: intPositive,
  MANA_COST_MIN: intNonNeg,
  MANA_COST_MAX: intPositive,

  PVP_HASTE_SCALE_BP: intNonNeg.max(10000),

  MAX_TARGET_PER_CAST: intPositive,
  MAX_STATUS_REQUEST_PER_CAST: intPositive,
});

export type SkillConstants = z.infer<typeof SkillConstantsSchema>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, '../../data');

let cached: SkillConstants | null = null;

export function loadSkillConstants(): SkillConstants {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(join(DATA_ROOT, 'skill_constants.json'), 'utf8'));
  const parsed = SkillConstantsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`[SkillConstants] schema FAIL:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
  cached = parsed.data;
  return cached;
}

export const SkillConstants: SkillConstants = loadSkillConstants();
