/**
 * STATUS CONSTANTS — Zod-validated load for Phase 2.
 *
 * Source: data/status_constants.json. INT BP scale (R30/R31).
 */
import { z } from 'zod';
import { Constants as ConstantsLoaderInstance } from './db.js';

const intNonNeg = z.number().int().nonnegative();
const intPositive = z.number().int().positive();
const intArray = z.array(z.number().int().nonnegative()).min(1);

export const StatusConstantsSchema = z.object({
  // DR per group: [level0, level1, ..., immune]
  DR_RESET_TURNS_HARD_CC: intNonNeg,
  DR_LEVELS_HARD_CC_BP: intArray,

  DR_RESET_TURNS_SOFT_CC: intNonNeg,
  DR_LEVELS_SOFT_CC_BP: intArray,

  DR_RESET_TURNS_DOT: intNonNeg,
  DR_LEVELS_DOT_BP: intArray,

  DR_RESET_TURNS_HOT: intNonNeg,
  DR_LEVELS_HOT_BP: intArray,

  // Stack cap per type
  STACK_CAP_DOT: intPositive,
  STACK_CAP_HOT: intPositive,
  STACK_CAP_DEBUFF_STAT: intPositive,
  STACK_CAP_BUFF_STAT: intPositive,
  STACK_CAP_DEFAULT: intPositive,

  // Effect tuning (BP)
  TAUNT_THREAT_BONUS_BP: intPositive,
  GUARD_DEF_BONUS_BP: intPositive,
  REFLECT_DAMAGE_PCT_BP: intPositive,

  // Boss / PvP
  BOSS_HARDCC_RESIST_BP: intNonNeg.max(10000),
  BOSS_SOFTCC_RESIST_BP: intNonNeg.max(10000),
  PVP_DR_SCALE_BP: intNonNeg.max(10000),

  // Recursion guard
  MAX_EFFECT_CHAIN_DEPTH: intPositive,
});

export type StatusConstants = z.infer<typeof StatusConstantsSchema>;

// Use a separate ConstantsLoader instance to avoid file-name collision với combat constants.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, '../../data');

let cached: StatusConstants | null = null;

export function loadStatusConstants(): StatusConstants {
  if (cached) return cached;
  const filePath = join(DATA_ROOT, 'status_constants.json');
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const parsed = StatusConstantsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`[StatusConstants] schema FAIL:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
  cached = parsed.data;
  return cached;
}

// Use loader at module load — crash sớm
export const StatusConstants: StatusConstants = loadStatusConstants();
// Suppress unused-import lint (ConstantsLoaderInstance kept for symmetry với combat constants pattern)
void ConstantsLoaderInstance;
