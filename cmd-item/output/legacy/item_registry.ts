/**
 * ITEM REGISTRY — load items.json + Zod validate + cache singleton + versioning.
 *
 * Layer 1 DATA loader. Pure function — registry trả immutable item.
 *
 * CMD2.docx FINAL FIX #11: Registry version + content hash → replay compat check.
 * CMD2.docx FINAL FIX #12: Formula + softcap version pin từ itemization_constants.json.
 *
 * @see itemization_types.ts (schema)
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  EquipmentSlotSchema,
  RaritySchema,
  ItemStatBlockSchema,
  ItemAffixSchema,
  ItemPassiveSchema,
} from './itemization_types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, '../../../data');

// ───────── Item Schema (full canonical v15) ─────────
export const ItemSchema = z.object({
  id: z.string().regex(/^item_/),
  name_vi: z.string().min(1),
  slot: EquipmentSlotSchema,
  rarity: RaritySchema,
  stats: ItemStatBlockSchema,
  affixes: z.array(ItemAffixSchema).default([]).optional().transform(v => v ?? []),
  passives: z.array(ItemPassiveSchema).optional(),
  set_id: z.string().regex(/^set_/).optional(),
  tier: z.string().optional(),
  era: z.string().optional(),
  region: z.string().optional(),
  material: z.string().optional(),
  historical_feeling: z.string().optional(),
});
export type Item = z.infer<typeof ItemSchema>;

const ItemsFileSchema = z.object({
  items: z.array(ItemSchema),
}).passthrough();

const VersioningConfigSchema = z.object({
  registry_version: z.string(),
  formula_version: z.string(),
  softcap_version: z.string(),
}).passthrough();

interface RegistryVersioning {
  registry_content_hash: string;
  registry_version: string;
  formula_version: string;
  softcap_version: string;
}

let cachedItems: Map<string, Item> | null = null;
let cachedVersioning: RegistryVersioning | null = null;

/** Load + validate items.json. Singleton cache. Compute content hash. */
export function loadItemsRegistry(): Map<string, Item> {
  if (cachedItems) return cachedItems;
  const rawText = readFileSync(join(DATA_ROOT, 'items.json'), 'utf8');
  const raw = JSON.parse(rawText);
  const parsed = ItemsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`[ItemRegistry] items.json FAIL:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
  const map = new Map<string, Item>();
  for (const item of parsed.data.items) {
    if (map.has(item.id)) {
      throw new Error(`[ItemRegistry] duplicate item id: ${item.id}`);
    }
    map.set(item.id, Object.freeze(item) as Item);
  }
  cachedItems = map;

  // Compute content hash + load version (CMD2.docx FINAL FIX #11 + #12)
  const contentHash = createHash('sha256').update(rawText).digest('hex').slice(0, 16);
  const constRaw = JSON.parse(readFileSync(join(DATA_ROOT, 'itemization_constants.json'), 'utf8'));
  const verParsed = VersioningConfigSchema.safeParse(constRaw);
  if (!verParsed.success) {
    throw new Error(`[ItemRegistry] versioning fields missing in itemization_constants.json`);
  }
  cachedVersioning = {
    registry_content_hash: contentHash,
    registry_version: verParsed.data.registry_version,
    formula_version: verParsed.data.formula_version,
    softcap_version: verParsed.data.softcap_version,
  };

  return cachedItems;
}

/** Get 1 item by id (throw nếu không tồn tại). */
export function getItem(item_id: string): Item {
  const reg = loadItemsRegistry();
  const item = reg.get(item_id);
  if (!item) throw new Error(`[ItemRegistry] item not found: ${item_id}`);
  return item;
}

/** Get registry + formula versioning (for AggregatedStatBlock persist). */
export function getRegistryVersioning(): RegistryVersioning {
  if (!cachedVersioning) loadItemsRegistry();
  return cachedVersioning!;
}

/** Test-only cache reset. */
export function _resetItemRegistry(): void {
  cachedItems = null;
  cachedVersioning = null;
}
