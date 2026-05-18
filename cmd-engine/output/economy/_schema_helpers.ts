/**
 * SCHEMA HELPERS — Batch 5.4 C1 strict schema hardening.
 *
 * JSON config files có một số free `_doc` / `_locked_by` annotation key cho human
 * documentation. Schema strict cần biết key nào safe-to-ignore vs key nào là typo
 * (vi phạm schema hardening — Batch 5.4 Mục VIII).
 *
 * Workflow:
 *   1. Caller pass raw JSON object
 *   2. `stripDocKeys()` xóa các key trong SAFE_DOC_KEYS whitelist
 *   3. Caller pass kết quả vào Zod strict schema
 *   4. Zod fail-fast khi gặp key lạ (= typo)
 */

/** Whitelist các key annotation safe-to-ignore trong JSON config (CMD2 economy scope). */
export const SAFE_DOC_KEYS = [
  '_doc',
  '_locked_by',
  '_dna_lock',
  '_explain',
  '_seed_pattern',
  '_validation',
  '_replay_doc',
  '_note',
  '_a1b_note',
] as const;
export type SafeDocKey = (typeof SAFE_DOC_KEYS)[number];

const SAFE_DOC_KEY_SET: ReadonlySet<string> = new Set(SAFE_DOC_KEYS);

/** Recursively strip SAFE_DOC_KEYS from object (deep). Arrays preserved as-is. */
export function stripDocKeys<T = unknown>(raw: T): T {
  if (raw === null || raw === undefined) return raw;
  if (Array.isArray(raw)) {
    return raw.map(stripDocKeys) as unknown as T;
  }
  if (typeof raw !== 'object') return raw;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (SAFE_DOC_KEY_SET.has(k)) continue;
    out[k] = stripDocKeys(v);
  }
  return out as unknown as T;
}
