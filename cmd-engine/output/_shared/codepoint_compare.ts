/**
 * Codepoint string compare — locale-independent, deterministic.
 * Replaces String.prototype.localeCompare() in replay-affecting paths.
 * Per Global Deterministic Rule §FORBIDDEN.localeCompare + R32 replay-safe.
 *
 * Trả về -1 | 0 | 1 (integer, R30+R31 compliant — không float).
 */
export function codepointCompare(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}
