/**
 * NPC REGISTRY — plug-in pattern (Phase 5).
 *
 * `NpcRegistry.get(npcId)` Map dispatch. Anti-hardcode: thêm NPC mới = JSON
 * data + 1 register entry, KHÔNG đụng combat/spawn/encounter pipelines.
 *
 * NO if(monsterId === "wolf") anywhere.
 */
import type { NpcTemplate, NpcTier } from './npc_types.js';
import { NpcTemplateSchema } from './npc_types.js';
import { resistancesForTier } from './npc_tier.js';

class NpcRegistryImpl {
  private templates = new Map<string, NpcTemplate>();
  private byTier = new Map<NpcTier, Set<string>>();
  private byFaction = new Map<string, Set<string>>();
  private byTag = new Map<string, Set<string>>();

  register(template: NpcTemplate): void {
    const parsed = NpcTemplateSchema.safeParse(template);
    if (!parsed.success) {
      throw new Error(`[NpcRegistry] schema FAIL '${template.npc_id}':\n${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
    const t = parsed.data;
    // Tier skills cap check
    const cap = resistancesForTier(t.tier).maxSkills;
    if (t.skill_ids.length > cap) {
      throw new Error(`[NpcRegistry] '${t.npc_id}' has ${t.skill_ids.length} skills > tier cap ${cap}`);
    }
    if (this.templates.has(t.npc_id)) {
      throw new Error(`[NpcRegistry] duplicate npc_id '${t.npc_id}'`);
    }
    this.templates.set(t.npc_id, t);
    addToBucket(this.byTier, t.tier, t.npc_id);
    addToBucket(this.byFaction, t.faction, t.npc_id);
    for (const tag of t.ai_tags ?? []) addToBucket(this.byTag, tag, t.npc_id);
  }

  registerAll(templates: readonly NpcTemplate[]): void {
    for (const t of templates) this.register(t);
  }

  get(npcId: string): NpcTemplate | undefined {
    return this.templates.get(npcId);
  }

  getOrThrow(npcId: string): NpcTemplate {
    const t = this.templates.get(npcId);
    if (!t) throw new Error(`[NpcRegistry] no NPC '${npcId}'`);
    return t;
  }

  has(npcId: string): boolean {
    return this.templates.has(npcId);
  }

  size(): number {
    return this.templates.size;
  }

  allIds(): readonly string[] {
    return [...this.templates.keys()];
  }

  filterByTier(tier: NpcTier): readonly NpcTemplate[] {
    const ids = this.byTier.get(tier) ?? new Set();
    return [...ids].sort().map((id) => this.templates.get(id)!).filter(Boolean);
  }

  filterByFaction(faction: string): readonly NpcTemplate[] {
    const ids = this.byFaction.get(faction) ?? new Set();
    return [...ids].sort().map((id) => this.templates.get(id)!).filter(Boolean);
  }

  filterByTag(tag: string): readonly NpcTemplate[] {
    const ids = this.byTag.get(tag) ?? new Set();
    return [...ids].sort().map((id) => this.templates.get(id)!).filter(Boolean);
  }

  _reset(): void {
    this.templates.clear();
    this.byTier.clear();
    this.byFaction.clear();
    this.byTag.clear();
  }
}

function addToBucket<K>(map: Map<K, Set<string>>, key: K, value: string): void {
  let set = map.get(key);
  if (!set) { set = new Set(); map.set(key, set); }
  set.add(value);
}

export const npcRegistry = new NpcRegistryImpl();
export type NpcRegistry = NpcRegistryImpl;
