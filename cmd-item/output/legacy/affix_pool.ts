/**
 * AFFIX POOL — load + roll seeded RNG (CMD2.docx Mục V + Phase 7 Mục XV).
 *
 * Isolated stream `rng_affix` (KHÔNG Math.random — R deterministic).
 *
 * Pure function — caller pass seedrandom instance.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import seedrandom from 'seedrandom';
import {
  type ItemAffix,
  type EquipmentSlot,
} from './itemization_types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, '../../data');

// ───────── Affix entry schema (per pool) ─────────
const AffixEntrySchema = z.object({
  id: z.string().regex(/^affix_/),
  type: z.string().min(1),
  min: z.number().int(),
  max: z.number().int(),
});
type AffixEntry = z.infer<typeof AffixEntrySchema>;

const AffixPoolFileSchema = z.object({
  pools: z.record(z.string(), z.array(AffixEntrySchema)),
}).passthrough();

let cachedPool: Map<string, AffixEntry[]> | null = null;

function loadPool(): Map<string, AffixEntry[]> {
  if (cachedPool) return cachedPool;
  const raw = JSON.parse(readFileSync(join(DATA_ROOT, 'affix_pool.json'), 'utf8'));
  const parsed = AffixPoolFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`[AffixPool] affix_pool.json FAIL:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
  const map = new Map<string, AffixEntry[]>();
  for (const [slot, entries] of Object.entries(parsed.data.pools)) {
    map.set(slot, entries);
  }
  cachedPool = map;
  return cachedPool;
}

/** Get pool for 1 slot. */
export function getAffixPoolForSlot(slot: EquipmentSlot): readonly AffixEntry[] {
  const pool = loadPool();
  const entries = pool.get(slot);
  if (!entries) return Object.freeze([] as AffixEntry[]);
  return entries;
}

/**
 * Roll N affix từ pool. Seeded RNG required (R Phase 7 Mục XV — KHÔNG Math.random).
 *
 * Algorithm: Fisher-Yates partial shuffle để pick N distinct affix, sau đó roll value
 * trong [min, max] mỗi affix qua seedrandom uniform integer.
 *
 * @param slot      Item slot
 * @param count     N affix to roll (≤ pool size)
 * @param rng       seedrandom PRNG instance (caller provide stream "rng_affix:<seed>")
 * @returns         ItemAffix[] đã roll value
 */
export function rollAffixes(
  slot: EquipmentSlot,
  count: number,
  rng: seedrandom.PRNG,
): ItemAffix[] {
  const pool = getAffixPoolForSlot(slot);
  if (count <= 0 || pool.length === 0) return [];
  const n = Math.min(count, pool.length);

  // Partial Fisher-Yates: pick first n indices distinct
  const indices = pool.map((_, i) => i);
  for (let i = 0; i < n; i++) {
    // Deterministic INT roll via rng() ∈ [0, 1) → INT [i, pool.length)
    const r = rng();
    const j = i + Math.floor(r * (pool.length - i));
    const tmp = indices[i]!;
    indices[i] = indices[j]!;
    indices[j] = tmp;
  }

  const out: ItemAffix[] = [];
  for (let k = 0; k < n; k++) {
    const entry = pool[indices[k]!]!;
    const span = entry.max - entry.min + 1;
    const r = rng();
    const value = entry.min + Math.floor(r * span);
    out.push({
      id: entry.id,
      type: entry.type,
      value_bp_or_raw: value,
    });
  }
  return out;
}

/**
 * Helper: factory PRNG cho test/replay deterministic.
 * Production: caller compose seed (vd `rng_affix:player_id:item_id:roll_index`).
 */
export function createAffixRng(seed: string): seedrandom.PRNG {
  return seedrandom(`rng_affix:${seed}`);
}

/** Test-only cache reset. */
export function _resetAffixPoolCache(): void {
  cachedPool = null;
}
