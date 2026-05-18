/**
 * COMBO/TRIGGER SYSTEM (Phase 3 spec § XII).
 *
 * Registry-driven, deterministic, extensible. NO hardcoded combo logic.
 *
 * Architecture:
 *   - ComboRule registry: input tag set → output skill cast(s)
 *   - When skill resolve emits combo_output_tags, combo engine match against
 *     registry, queue triggered output skills (with depth tracking)
 *   - Recursion guard: MAX_COMBO_DEPTH (anti-loop burn→wind→explosion→burn→...)
 *
 * Examples (data-driven):
 *   { id: 'fire_wind', input: ['burn', 'wind'], output: 'svtk_skill_explosion', depth: 1 }
 *   { id: 'frost_crit', input: ['freeze', 'crit'], output: 'svtk_skill_shatter', depth: 1 }
 */
import { z } from 'zod';
import type { ComboTag, SkillCastRequest } from './skill_types.js';
import { SkillConstants } from './skill_constants.js';

export const ComboRuleSchema = z.object({
  /** Unique combo rule id. */
  id: z.string().min(1).max(64),
  /** Input tags ALL required (AND condition). */
  input_tags: z.array(z.string()).min(1).max(4),
  /** Output skill ids cast as result. */
  output_skill_ids: z.array(z.string()).min(1).max(8),
  /** Cooldown turns (combo cannot trigger again from same caster within window). */
  cooldown_turns: z.number().int().nonnegative().default(0),
  /** Tag emitted when combo fires (for cascade combo). */
  emits_tag: z.string().optional(),
});
export type ComboRule = z.infer<typeof ComboRuleSchema>;

class ComboRegistryImpl {
  private rules = new Map<string, ComboRule>();
  /** Index by input tag for fast lookup: tag → rules containing tag. */
  private byInputTag = new Map<string, Set<string>>();

  register(rule: ComboRule): void {
    const parsed = ComboRuleSchema.safeParse(rule);
    if (!parsed.success) {
      throw new Error(`[ComboRegistry] schema FAIL '${rule.id}':\n${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
    if (this.rules.has(rule.id)) {
      throw new Error(`[ComboRegistry] duplicate combo rule id '${rule.id}'`);
    }
    this.rules.set(rule.id, parsed.data);
    for (const tag of rule.input_tags) {
      let set = this.byInputTag.get(tag);
      if (!set) { set = new Set(); this.byInputTag.set(tag, set); }
      set.add(rule.id);
    }
  }

  registerAll(rules: readonly ComboRule[]): void {
    for (const r of rules) this.register(r);
  }

  get(id: string): ComboRule | undefined { return this.rules.get(id); }
  size(): number { return this.rules.size; }
  allIds(): readonly string[] { return [...this.rules.keys()]; }

  /** Get rules potentially triggered by a tag set (subset that contains at least 1 input tag). */
  candidatesFor(presentTags: ReadonlySet<string>): readonly ComboRule[] {
    const seen = new Set<string>();
    const out: ComboRule[] = [];
    for (const tag of presentTags) {
      const ids = this.byInputTag.get(tag);
      if (!ids) continue;
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const rule = this.rules.get(id);
        if (rule) out.push(rule);
      }
    }
    // Stable sort by rule.id (replay determinism)
    out.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return out;
  }

  _reset(): void {
    this.rules.clear();
    this.byInputTag.clear();
  }
}

export const comboRegistry = new ComboRegistryImpl();
export type ComboRegistry = ComboRegistryImpl;

/**
 * Combo cooldown state per caster — prevent same combo from firing repeatedly.
 */
export interface ComboCooldownState {
  perRule: Map<string, number>;
}

export function createComboCooldownState(): ComboCooldownState {
  return { perRule: new Map() };
}

export function tickComboCooldown(state: ComboCooldownState): void {
  for (const [k, v] of state.perRule) {
    if (v <= 1) state.perRule.delete(k);
    else state.perRule.set(k, v - 1);
  }
}

export interface ComboTriggerOutcome {
  triggered: ComboRule[];
  /** Output cast requests to enqueue (caller resolves recursively with depth+1). */
  outputs: Array<{ rule: ComboRule; outputSkillId: string }>;
  /** Skipped due to cooldown. */
  skippedCooldown: ComboRule[];
  /** Skipped due to depth limit. */
  skippedDepth: ComboRule[];
}

/**
 * Match present tags against registry. Returns rules that fully satisfied input AND
 * not on cooldown AND under max depth.
 *
 * @param presentTags  — tags currently active in encounter (combo input candidates)
 * @param currentDepth — recursion depth (0 = root cast)
 * @param cooldownState — caster's combo cooldowns
 */
export function evaluateCombos(
  presentTags: ReadonlySet<string>,
  currentDepth: number,
  cooldownState: ComboCooldownState,
): ComboTriggerOutcome {
  const triggered: ComboRule[] = [];
  const outputs: Array<{ rule: ComboRule; outputSkillId: string }> = [];
  const skippedCooldown: ComboRule[] = [];
  const skippedDepth: ComboRule[] = [];

  if (currentDepth >= SkillConstants.MAX_COMBO_DEPTH) {
    // Depth-limited at entry — return empty (no candidates evaluated).
    return { triggered, outputs, skippedCooldown, skippedDepth };
  }

  const candidates = comboRegistry.candidatesFor(presentTags);
  for (const rule of candidates) {
    // ALL input tags must be present (AND condition)
    if (!rule.input_tags.every((t) => presentTags.has(t))) continue;
    // Cooldown
    if ((cooldownState.perRule.get(rule.id) ?? 0) > 0) {
      skippedCooldown.push(rule);
      continue;
    }
    // Depth (additional output expansion check)
    if (currentDepth + 1 >= SkillConstants.MAX_COMBO_DEPTH) {
      skippedDepth.push(rule);
      continue;
    }
    triggered.push(rule);
    if (rule.cooldown_turns > 0) cooldownState.perRule.set(rule.id, rule.cooldown_turns);
    for (const out of rule.output_skill_ids.slice(0, SkillConstants.MAX_COMBO_OUTPUT_PER_RULE)) {
      outputs.push({ rule, outputSkillId: out });
    }
  }
  return { triggered, outputs, skippedCooldown, skippedDepth };
}

/**
 * Build combo-derived cast request. Caller resolveSkillCast with this request.
 */
export function buildComboCastRequest(
  rootCasterId: string,
  outputSkillId: string,
  primaryTargetId: string | undefined,
  triggerTag: ComboTag,
  sourceSkillId: string,
  newDepth: number,
  level: number,
): SkillCastRequest {
  return {
    skillId: outputSkillId,
    casterId: rootCasterId,
    primaryTargetId,
    level,
    comboContext: {
      triggerTag,
      sourceSkillId,
      depth: newDepth,
    },
  };
}
