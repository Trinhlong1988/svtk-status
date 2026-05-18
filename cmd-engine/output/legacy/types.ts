/**
 * Core type definitions — shared across Layer 2 Logic.
 *
 * Mọi domain entity (Skill / NPC / Item / Boss / Effect) có Zod schema riêng.
 * File này chỉ định nghĩa type ở mức skeleton — chi tiết per module.
 */
import { z } from 'zod';

// ───────── Element (6 hệ ngũ hành) ─────────
export const ElementSchema = z.enum(['KIM', 'MOC', 'THO', 'THUY', 'HOA', 'TAM']);
export type Element = z.infer<typeof ElementSchema>;

// ───────── Tier (6 tier sau remap) ─────────
export const TierSchema = z.enum(['Mob', 'Elite', 'Captain', 'MiniBoss', 'Boss', 'Myth']);
export type Tier = z.infer<typeof TierSchema>;

// ───────── Role (R17 — tradeoff) ─────────
export const RoleSchema = z.enum(['Tank', 'Healer', 'DPS_VL', 'DPS_PH', 'Support', 'Control', 'Summoner']);
export type Role = z.infer<typeof RoleSchema>;

// ───────── RB (Chuyển sinh) ─────────
export const RbSchema = z.enum(['RB0', 'RB1', 'RB2', 'RB3']);
export type Rb = z.infer<typeof RbSchema>;

// ───────── Damage type ─────────
export const DamageTypeSchema = z.enum(['physical', 'magical', 'true']);
export type DamageType = z.infer<typeof DamageTypeSchema>;

// ───────── Mana category (6 — chốt v15) ─────────
export const ManaCategorySchema = z.enum(['core', 'combo', 'control', 'aoe', 'ultimate', 'legendary']);
export type ManaCategory = z.infer<typeof ManaCategorySchema>;

// ───────── Effect type (≥11 BẮT BUỘC, mở rộng được) ─────────
export const EffectTypeSchema = z.enum([
  // 11 BẮT BUỘC
  'dot', 'hot', 'shield', 'taunt', 'silence', 'freeze', 'stun',
  'cleanse', 'anti_heal', 'reflect', 'summon_link',
  // Mở rộng
  'charm', 'reveal', 'invisibility', 'buff_stat', 'debuff_stat',
  'revive', 'morale', 'counter', 'lifesteal', 'mana_drain',
  'penetration', 'stealth_detection', 'formation_break', 'knockback',
  'mark', 'execute', 'vulnerability',
]);
export type EffectType = z.infer<typeof EffectTypeSchema>;

// ───────── Skill effect (data trong JSON) ─────────
export const SkillEffectSchema = z.object({
  type: EffectTypeSchema,
  /** Magnitude — meaning tùy effect type (vd burn = damage/tick, shield = absorb amount) */
  amount: z.array(z.number()).optional(),
  /** Duration per skill level (cấp 1..10) */
  duration_by_level: z.array(z.number()).optional(),
  /** Stack limit — max stack cùng target */
  stack_limit: z.number().int().min(1).optional(),
  /** Tick interval (turn) for DOT/HOT */
  tick_interval: z.number().int().min(1).optional(),
});
export type SkillEffect = z.infer<typeof SkillEffectSchema>;

// ───────── Skill type ─────────
export const SkillTypeSchema = z.enum(['damage', 'heal', 'cc', 'buff', 'debuff', 'shield', 'utility']);
export type SkillType = z.infer<typeof SkillTypeSchema>;

/**
 * Skill combat shape — minimum interface F1-F7 cần (Module 1).
 * Full Skill schema (165 skill v15 với mana_cost, cooldown, target_mode, ...) ở Module 3.
 *
 * BP fixed-point convention (CLAUDE.md mục 14, R30):
 *   - scaling_bp / heal_scaling_bp: multiplier per skill level BP (10000 = ×1.0)
 *   - accuracy_mod_bp: bonus accuracy BP (positive) / penalty (negative)
 *   - penetration_bp: 0..10000 (cap PEN_CAP_TOTAL_BP)
 */
export const SkillCombatSchema = z.object({
  id: z.string(),
  type: SkillTypeSchema,
  damage_type: DamageTypeSchema.optional(),
  element: ElementSchema,
  base_damage: z.number().int().nonnegative().optional(),
  base_heal: z.number().int().nonnegative().optional(),
  scaling_bp: z.array(z.number().int().positive()).optional(),
  heal_scaling_bp: z.array(z.number().int().positive()).optional(),
  accuracy_mod_bp: z.number().int().optional(),
  penetration_bp: z.number().int().nonnegative().optional(),
  /** Mana cost per skill level (1..10). Module 3 sẽ ép required. */
  mana_cost_by_level: z.array(z.number().int().nonnegative()).optional(),
  /** Cooldown (turn) — 0 = no cooldown. */
  cooldown: z.number().int().nonnegative().optional(),
  effects: z.array(SkillEffectSchema).optional(),
});
export type SkillCombat = z.infer<typeof SkillCombatSchema>;

// ───────── Combat character (runtime instance, không phải template) ─────────
export interface CombatChar {
  id: string;
  npcId?: string;      // nếu là NPC instance, link về Template
  playerId?: string;   // nếu là player

  // Identity
  name_vi: string;
  element: Element;
  role: Role;
  tier?: Tier;         // chỉ NPC mới có

  // Level
  level: number;
  rb: Rb;

  // Stats (7 stat chính)
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  sat_luc: number;     // Attack power (physical), INT
  phap_luc: number;    // Magic power, INT
  defense: number;     // INT, used in K_DEF/(DEF+K_DEF) formula
  agility: number;     // For dodge + speed (INT)
  wisdom: number;      // For magic resist (INT)
  crit_rate: number;   // BP (2500 = 25%)
  anti_crit: number;   // BP

  // Derived (BP scale per CLAUDE.md mục 14)
  accuracy: number;    // BP (8500 = 85%)
  dodge: number;       // BP (1000 = 10%)
  shield: number;      // INT absolute (cùng scale BP, 10000 = full block)

  // State
  alive: boolean;
  cooldowns: Record<string, number>;
  cc: {
    silenced?: number;     // turn count remaining
    stunned?: number;
    frozen?: number;
    rooted?: number;
    charmed?: number;
  };
  debuffs: Array<{ type: string; value: number; remainingTurns: number }>;
  buffs: Array<{ type: string; value: number; remainingTurns: number }>;
}

// ───────── Combat context (per encounter) ─────────
export interface CombatContext {
  encounterId: string;
  turn: number;
  mode: 'pve' | 'pvp' | 'raid' | 'world_boss';
  /**
   * Single RNG (legacy / backward compat). Pipeline + F1-F7 prefer `rngStream` when available.
   * Used as fallback if `rngStream` undefined.
   */
  rng: () => number;
  /**
   * Substream RNG (FIX #1 MIGRATION). Independent per concern — adding new substream
   * KHÔNG shift existing roll. If undefined, formula fall back to `rng` (legacy mode).
   */
  rngStream?: import('./rng_stream.js').RNGStream;
  encounter: {
    boss?: CombatChar;
    addThreat: (caster: CombatChar, target: CombatChar, amount: number) => void;
  };
}

// ───────── Combat result (return từ resolveSkillCast) ─────────
export interface CombatResult {
  damage?: number;
  heal?: number;
  effects?: SkillEffect[];
  events: string[];
  error?: 'no_mana' | 'on_cooldown' | 'cc_blocked' | 'invalid_target' | 'unknown_skill';
}
