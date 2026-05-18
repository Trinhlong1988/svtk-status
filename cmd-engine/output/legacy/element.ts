/**
 * ELEMENT WHEEL — pure function (R3 Data-Driven + spec/02_COMBAT_FORMULA §IV).
 *
 * Counter chain: KIM > MOC > THO > THUY > HOA > KIM.
 * TÂM neutral với mọi hệ (không tham gia counter).
 *
 * BP scale (CLAUDE.md mục 14, R30): trả multiplier `_bp` (12000 = 120% = ×1.2).
 *
 * Source of truth: data/element_wheel.json (hot-fix-able).
 */
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Element } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, '../../data');

const ElementWheelSchema = z.object({
  counter_chain: z.array(z.enum(['KIM', 'MOC', 'THO', 'THUY', 'HOA'])).length(5),
  counter_multiplier_bp: z.number().int().positive(),
  countered_multiplier_bp: z.number().int().positive(),
  neutral_multiplier_bp: z.number().int().positive(),
  tam_special: z.object({
    vs_other_bp: z.number().int().positive(),
    other_vs_tam_bp: z.number().int().positive(),
    tam_damage_nerf_bp: z.number().int().positive(),
  }),
});

export type ElementWheel = z.infer<typeof ElementWheelSchema>;

let cachedWheel: ElementWheel | null = null;

/** Load + Zod validate `element_wheel.json`. Cache singleton. */
export function loadElementWheel(): ElementWheel {
  if (cachedWheel) return cachedWheel;
  const filePath = join(DATA_ROOT, 'element_wheel.json');
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const parsed = ElementWheelSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`[ElementWheel] schema FAIL:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
  cachedWheel = parsed.data;
  return cachedWheel;
}

/** Test-only reset (không dùng production). */
export function _resetElementWheelCache(): void {
  cachedWheel = null;
}

/**
 * Get element modifier BP cho damage roll.
 *
 * @param attacker  hệ skill caster
 * @param target    hệ target
 * @returns         multiplier BP (12000 = ×1.2 counter, 8000 = ×0.8 countered, 10000 = neutral)
 */
export function getElementModifierBP(attacker: Element, target: Element): number {
  const wheel = loadElementWheel();

  if (attacker === 'TAM' || target === 'TAM') {
    return wheel.tam_special.vs_other_bp;
  }

  const chain = wheel.counter_chain;
  const aIdx = chain.indexOf(attacker);
  const tIdx = chain.indexOf(target);
  if (aIdx === -1 || tIdx === -1) return wheel.neutral_multiplier_bp;

  // attacker counter target nếu attacker đứng trước target trong chain (mod 5)
  if ((aIdx + 1) % 5 === tIdx) return wheel.counter_multiplier_bp;
  if ((tIdx + 1) % 5 === aIdx) return wheel.countered_multiplier_bp;
  return wheel.neutral_multiplier_bp;
}
