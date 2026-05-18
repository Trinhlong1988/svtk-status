/**
 * SKILL REGISTRY — plug-in pattern Phase 3.
 *
 * `SkillRegistry.get(skillId)` Map dispatch. Anti-hardcode: thêm skill mới = JSON
 * data + 1 register entry, KHÔNG đụng resolver/validator/cooldown/mana.
 *
 * NO if(skillId === 'fireball') anywhere — registry dispatch only.
 */
import type { SkillTemplate } from './skill_types.js';
import { SkillTemplateSchema } from './skill_types.js';

class SkillRegistryImpl {
  private skills = new Map<string, SkillTemplate>();

  /** Register a skill template. Throws on duplicate id. */
  register(skill: SkillTemplate): void {
    const parsed = SkillTemplateSchema.safeParse(skill);
    if (!parsed.success) {
      throw new Error(`[SkillRegistry] schema FAIL for skill '${skill.id}':\n${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
    if (this.skills.has(skill.id)) {
      throw new Error(`[SkillRegistry] duplicate skill id '${skill.id}'`);
    }
    this.skills.set(skill.id, parsed.data);
  }

  /** Bulk register. */
  registerAll(skills: readonly SkillTemplate[]): void {
    for (const s of skills) this.register(s);
  }

  /** Get skill template. Returns undefined if not registered. */
  get(skillId: string): SkillTemplate | undefined {
    return this.skills.get(skillId);
  }

  /** Get or throw. */
  getOrThrow(skillId: string): SkillTemplate {
    const s = this.skills.get(skillId);
    if (!s) throw new Error(`[SkillRegistry] no skill registered for id '${skillId}'`);
    return s;
  }

  has(skillId: string): boolean {
    return this.skills.has(skillId);
  }

  /** All registered skill ids (for diagnostics + AI selector). */
  allIds(): readonly string[] {
    return [...this.skills.keys()];
  }

  /** Filter by tag — for AI/combo lookup (NOT in hot-path; use sparingly). */
  filterByAITag(tag: string): readonly SkillTemplate[] {
    const out: SkillTemplate[] = [];
    for (const s of this.skills.values()) {
      if (s.ai_tags?.includes(tag)) out.push(s);
    }
    return out;
  }

  filterByComboInputTag(tag: string): readonly SkillTemplate[] {
    const out: SkillTemplate[] = [];
    for (const s of this.skills.values()) {
      if (s.combo_input_tags?.includes(tag)) out.push(s);
    }
    return out;
  }

  /** Test-only — clear all skills. */
  _reset(): void {
    this.skills.clear();
  }

  size(): number {
    return this.skills.size;
  }
}

export const skillRegistry = new SkillRegistryImpl();
export type SkillRegistry = SkillRegistryImpl;
