/**
 * ITEMIZATION TYPES — Layer 1 DATA shape, shared across 3 contract.
 *
 * Pure interface + Zod schema. NO state. NO I/O. NO method.
 * Replay-safe: all field JSON-serializable INT (R31).
 * BP scale `_bp` ×10000 cho mọi multiplier (R30, CLAUDE.md mục 14).
 *
 * Naming convention:
 *  - File: snake_case `.ts` (R Mục IX MASTER_LOCK)
 *  - Interface: PascalCase (TS convention)
 *  - Slot id: snake_case Việt unaccent (mu / ao / quan / gang_tay / giay / vu_khi / nhan / day_chuyen / ngoc)
 *
 * Spec source: spec/08_ITEMIZATION_RULE.md (MASTER) + 7.docx (reference only, NO override).
 *
 * ⚠ R30 NOTE — REVIEW REQUIRED:
 *   spec/08 Mục IX dùng `crit_rate: z.number()` decimal (vd 0.05 = 5%).
 *   File này CONVERT sang `_bp` integer (vd 500 = 5%) để khớp R30 cứng.
 *   Mr.Long ack hoặc reject convention shift này trong audit.
 */
import { z } from 'zod';
import { ElementSchema, type Element } from '../../../cmd-engine/output/legacy/types.js';

// ───────── Equipment Slot (9 slot — spec/08 Mục II + v15 align) ─────────
/**
 * 9 slot trang bị SVTK — snake_case Việt unaccent.
 *
 * 8 slot core + 1 phụ kiện (ngọc Bạo Kích).
 * Item progression bound to slot — KHÔNG hardcode slot logic ngoài file này (R Phase 7 Mục VI).
 */
export const EquipmentSlotSchema = z.enum([
  'mu',          // Mũ — INT/WIS, crit_rate, accuracy
  'ao',          // Áo (Giáp) — DEF, HP, threat_coef
  'quan',        // Quần — DEF, agility, dodge, HP regen
  'gang_tay',    // Găng tay (NEW v15) — ATK, crit_dmg, pen
  'giay',        // Giày — agility, speed, dodge
  'vu_khi',      // Vũ khí — ATK/INT chính, crit, pen, element_mod
  'nhan',        // Nhẫn — Resource/Mana, element resist, lifesteal
  'day_chuyen',  // Dây chuyền — HP regen, mana regen, element resist, anti-crit
  'ngoc',        // Ngọc Bạo Kích (phụ kiện) — crit-related stat
]);
export type EquipmentSlot = z.infer<typeof EquipmentSlotSchema>;

// ───────── Rarity (5 tier — spec/08 Mục IV) ─────────
/**
 * 5 rarity tier theo spec/08 (KHÔNG có UNCOMMON theo Phase 7 generic).
 *
 * Stat multiplier cố định, KHÔNG random vô hạn:
 *   common → 10000 BP (×1.0) · rare → 12000 BP (×1.2) · epic → 15000 BP (×1.5)
 *   legendary → 20000 BP (×2.0) · mythic → 25000 BP (×2.5)
 */
export const RaritySchema = z.enum(['common', 'rare', 'epic', 'legendary', 'mythic']);
export type Rarity = z.infer<typeof RaritySchema>;

// ───────── Stat Block (BP scale theo R30) ─────────
/**
 * Stat block trên item — INT fixed-point only (R31).
 *
 * Naming convention stat key:
 *  - Stat raw (HP/SP/DEF): integer absolute (vd hp = 200 = +200 HP)
 *  - Stat percent (crit_rate / pen / element_mod): suffix `_bp` ×10000 (vd crit_rate_bp = 500 = 5%)
 *  - has_crit: boolean — item có cho crit hay không (Bạo Kích cap enforcement marker)
 *
 * ⚠ Conflict với spec/08 Mục IX (decimal). Em propose `_bp` strict R30.
 */
export const ItemStatBlockSchema = z.object({
  // Absolute INT stat (no _bp suffix — đã là integer raw)
  hp: z.number().int().nonnegative().optional(),
  sat_luc: z.number().int().nonnegative().optional(),       // ATK
  phap_luc: z.number().int().nonnegative().optional(),      // INT (magic)
  defense: z.number().int().nonnegative().optional(),
  agility: z.number().int().nonnegative().optional(),
  hp_regen_per_turn: z.number().int().nonnegative().optional(),
  mana_regen_per_turn: z.number().int().nonnegative().optional(),

  // Percent stat — BP scale ×10000 (R30)
  crit_rate_bp: z.number().int().nonnegative().optional(),     // 500 = 5%
  crit_dmg_bp: z.number().int().nonnegative().optional(),      // 18000 = 180%
  penetration_bp: z.number().int().nonnegative().optional(),   // 2000 = 20%
  threat_coef_bp: z.number().int().optional(),                 // ±BP, signed (tank +200% / heal -30%)
  lifesteal_bp: z.number().int().nonnegative().optional(),     // 1500 = 15%
  dodge_bp: z.number().int().nonnegative().optional(),         // 800 = 8%

  // Element modifier per hệ — BP scale (12000 = ×1.2)
  element_mod_bp: z.record(ElementSchema, z.number().int()).optional(),
  element_resist_bp: z.record(ElementSchema, z.number().int()).optional(),

  // Flag: item có cho crit không (Bạo Kích enforcement)
  has_crit: z.boolean().default(false),
});
export type ItemStatBlock = z.infer<typeof ItemStatBlockSchema>;

// ───────── Affix (rolled khi craft / drop, seeded RNG) ─────────
/**
 * Affix instance trên item — pure data, KHÔNG behavior.
 *
 * Source pool: data/affix_pool.json (Phase 7 Mục V).
 * Roll qua isolated stream `rng_affix` (R Phase 7 Mục XV).
 */
export const ItemAffixSchema = z.object({
  /** Affix id từ pool (vd "affix_crit_minor", "affix_burn_proc"). snake_case unaccent. */
  id: z.string().regex(/^affix_[a-z0-9_]+$/),
  /** Type key — match một trong stat keys hoặc effect type. */
  type: z.string(),
  /** Magnitude rolled — INT (raw absolute hoặc BP tùy type). */
  value_bp_or_raw: z.number().int(),
});
export type ItemAffix = z.infer<typeof ItemAffixSchema>;

// ───────── Passive (set bonus, conditional trigger) ─────────
/**
 * Passive effect — pure data. Resolver xử lý conflict (5-tuple, CMD2.docx FINAL FIX #5).
 *
 * Lock 5-tuple resolution order:
 *   1. passive_priority ASC
 *   2. value_bp_or_raw DESC (stronger wins)
 *   3. source_type ASC (alphabetical)
 *   4. source_item_id lex ASC
 *   5. insertion_order ASC
 *
 * Condition string parsed bởi conditional resolver (data-driven, KHÔNG hardcode logic).
 */
export const ItemPassiveSchema = z.object({
  /** Passive type id — snake_case (vd "crit_after_burn", "lifesteal_burst"). */
  type: z.string().regex(/^[a-z0-9_]+$/),
  /** Magnitude — INT (raw hoặc BP). */
  value_bp_or_raw: z.number().int(),
  /** Optional condition expression — parsed bởi conditional engine. */
  condition: z.string().optional(),
  /**
   * Passive priority — explicit ordering (CMD2.docx FINAL FIX #5).
   * Lower = applied first / wins ties trước.
   * Default 100 nếu không set.
   */
  passive_priority: z.number().int().default(100),
});
export type ItemPassive = z.infer<typeof ItemPassiveSchema>;

// ───────── Modifier (apply khi equip — input cho ModifierPipeline) ─────────
/**
 * Modifier kind theo Phase 7 Mục VIII (6 kind):
 *   - flat: cộng absolute vào stat (vd +50 HP)
 *   - pct_bp: nhân % vào stat base (vd +1500 BP = +15%)
 *   - conditional: chỉ active khi condition true (parsed)
 *   - passive: always-on, bound to item equipped
 *   - companion_linked: khi companion equipped item nào → owner nhận bonus
 *   - formation_prep: dành cho Module formation tương lai (NOT implement Phase 7)
 */
export const ModifierKindSchema = z.enum([
  'flat',
  'pct_bp',
  'conditional',
  'passive',
  'companion_linked',
  'formation_prep',
]);
export type ModifierKind = z.infer<typeof ModifierKindSchema>;

/**
 * Source type ENUM — explicit (CMD2.docx FINAL FIX #2).
 *
 * KHÔNG derive từ source_item_id string parse (replay risk khi rename pattern).
 * Lưu trực tiếp trong modifier payload.
 */
export const ModifierSourceTypeEnumSchema = z.enum([
  'affix',
  'base_item',
  'passive',
  'set_bonus',
  'tinh_anh',
  'companion_aura',
]);
export type ModifierSourceTypeEnum = z.infer<typeof ModifierSourceTypeEnumSchema>;

export const StatModifierSchema = z.object({
  /** Stat key target (vd "sat_luc", "crit_rate_bp"). */
  stat_key: z.string(),
  /** Kind — quyết định áp dụng (flat add / pct multiply / conditional...). */
  kind: ModifierKindSchema,
  /** Magnitude — INT. */
  amount_bp_or_raw: z.number().int(),
  /** Source item id (debug + passive conflict resolve). */
  source_item_id: z.string().regex(/^(item_|affix_|passive_|set_|tinh_anh_|companion_aura_)/),
  /** Source type ENUM — explicit (KHÔNG derive). */
  source_type: ModifierSourceTypeEnumSchema,
  /** Optional condition cho kind=conditional. */
  condition: z.string().optional(),
  /** Application order priority (deterministic ordering, R Phase 7 Mục VIII). */
  order_priority: z.number().int(),
  /**
   * Modifier insert order — EXPLICIT (CMD2.docx FINAL FIX #1).
   *
   * KHÔNG depend ECMAScript Array.sort stable. Explicit INT cho cross-runtime
   * deterministic comparator (Mono / V8 / embedded engine khác nhau).
   *
   * Caller (collectModifiers) assign monotonic increment khi push vào array.
   */
  modifier_insert_order: z.number().int().nonnegative(),
});
export type StatModifier = z.infer<typeof StatModifierSchema>;

// ───────── Stat Aggregation Result ─────────
/**
 * Output của EquipmentStatProvider — tổng stat từ items equipped.
 *
 * Pure data — Combat Core ĐỌC, KHÔNG mutate.
 * Replay-safe: deterministic ordering enforced.
 *
 * ⚠ HARD LOCK (CMD2.docx FINAL FIX #7):
 *   `stats` MUST remain flat immutable INT structure.
 *   Future nested migration MUST version bump (formula_version + softcap_version).
 */
export const AggregatedStatBlockSchema = z.object({
  /** Final stats sau apply tất cả modifier (flat → pct → conditional → passive). FLAT INT only. */
  stats: ItemStatBlockSchema,
  /** Set bonus active (set_id list). */
  active_sets: z.array(z.string().regex(/^set_/)),
  /** Modifiers đã apply (cho debug + replay). */
  applied_modifiers: z.array(StatModifierSchema),
  /** Items equipped (snapshot id list). */
  equipped_item_ids: z.array(z.string().regex(/^item_/)),
  /**
   * Replay compatibility versioning (CMD2.docx FINAL FIX #11 + #12).
   * Persist for cross-version replay validation.
   */
  versioning: z.object({
    /** Items registry content hash (mỗi liveops update bump). */
    registry_content_hash: z.string(),
    /** Items registry version (semver-like or monotonic int as string). */
    registry_version: z.string(),
    /** Combat formula version (pin softcap_version too). */
    formula_version: z.string(),
    /** Softcap formula version. */
    softcap_version: z.string(),
  }),
});
export type AggregatedStatBlock = z.infer<typeof AggregatedStatBlockSchema>;

// ───────── Re-export Element (convenience) ─────────
export type { Element };
