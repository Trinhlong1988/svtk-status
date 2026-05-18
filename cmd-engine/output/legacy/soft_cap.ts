/**
 * SOFT CAP (R24) — Diminishing Return helper, INT BP scale (CLAUDE.md mục 14, R30).
 *
 * Mọi stat scaling có DR sau cap. Vd Crit cap 50% (5000 BP), DR /2:
 *   raw 6000 → 5000 + (6000-5000)/2 = 5500
 *   raw 10000 → 5000 + (10000-5000)/2 = 7500
 *
 * @param rawBP        giá trị stat BP trước cap (vd 6000 = 60%)
 * @param capBP        ngưỡng cap BP (vd 5000 = 50%)
 * @param drDivider    số chia DR sau cap (vd 2 = mỗi 2 BP dư cộng 1)
 * @returns            stat sau soft cap, integer BP
 */
export function applySoftCap(rawBP: number, capBP: number, drDivider: number): number {
  if (rawBP <= capBP) return rawBP;
  if (drDivider <= 0) return capBP;
  const overflow = rawBP - capBP;
  return capBP + Math.floor(overflow / drDivider);
}

/** Clamp INT value to [lo, hi]. */
export function clampInt(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}
