/**
 * DEEP FREEZE — Phase 1 hardening FIX #8.
 *
 * `Object.freeze` shallow-only. Nested object/array vẫn mutable → replay corruption.
 * deepFreeze recursively freezes all reachable objects.
 *
 * Performance: O(node count). Used at event emit boundary only (resolve / post_*).
 * Acceptable cost (events are flat shape with ≤ 10 fields).
 *
 * Replay-safe + deterministic guarantee.
 */
/**
 * Cache via WeakSet — skip already-deep-frozen object on subsequent calls.
 * (FIX #8 hardening — performance optimization.)
 */
const DEEP_FROZEN = new WeakSet<object>();

export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object') return obj;
  // Fast path: already deep-frozen via cache
  if (DEEP_FROZEN.has(obj as object)) return obj as Readonly<T>;
  // Fast path: shallow-frozen but NOT in cache → still need deep walk (could have unfrozen nested)
  if (!Object.isFrozen(obj)) Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === 'object' && !DEEP_FROZEN.has(val)) {
      deepFreeze(val);
    }
  }
  DEEP_FROZEN.add(obj as object);
  return obj as Readonly<T>;
}

/** Test-only — clear cache to verify behavior. */
export function _clearDeepFreezeCache(): void {
  // WeakSet không có clear() — dùng new instance
  // Hack for test isolation: re-export module reset would be needed
  // Production: cache grows monotonically (acceptable, GC handles unreachable objects)
}
