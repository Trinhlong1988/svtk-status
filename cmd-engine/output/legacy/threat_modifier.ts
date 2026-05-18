/**
 * THREAT MODIFIER REGISTRY — Phase 4 § VI.
 *
 * Generic role/tag-based modifier. NO hardcoded class logic.
 * Tank +200% baseline; Healer +50% heal-only; Assassin -30% all.
 *
 * Composes deterministic order: role default → tag overrides (data-driven).
 */
import type { Role } from './types.js';
import type { ThreatGenerationSource, ThreatModifierEntry } from './threat_types.js';
import { ThreatConstants } from './threat_constants.js';

class ThreatModifierRegistryImpl {
  private byRole = new Map<Role, ThreatModifierEntry[]>();
  private byTag = new Map<string, ThreatModifierEntry[]>();

  register(entry: ThreatModifierEntry): void {
    if (entry.role) {
      let list = this.byRole.get(entry.role);
      if (!list) { list = []; this.byRole.set(entry.role, list); }
      list.push(entry);
    } else if (entry.tag) {
      let list = this.byTag.get(entry.tag);
      if (!list) { list = []; this.byTag.set(entry.tag, list); }
      list.push(entry);
    } else {
      throw new Error('[ThreatModifierRegistry] entry needs role OR tag');
    }
  }

  registerAll(entries: readonly ThreatModifierEntry[]): void {
    for (const e of entries) this.register(e);
  }

  /** Resolve effective multiplier BP for actor's (role, tags, source). Stable order. */
  resolveMultBP(role: Role, tags: readonly string[], source: ThreatGenerationSource): number {
    let mult = 10000;     // baseline ×1.0
    // Role match first
    for (const e of this.byRole.get(role) ?? []) {
      if (e.restrictSource && e.restrictSource !== source) continue;
      mult = composeBP(mult, e.multBP);
    }
    // Then tags (sorted to ensure deterministic order)
    const sortedTags = [...tags].sort();
    for (const tag of sortedTags) {
      for (const e of this.byTag.get(tag) ?? []) {
        if (e.restrictSource && e.restrictSource !== source) continue;
        mult = composeBP(mult, e.multBP);
      }
    }
    return mult;
  }

  size(): number {
    let n = 0;
    for (const list of this.byRole.values()) n += list.length;
    for (const list of this.byTag.values()) n += list.length;
    return n;
  }

  _reset(): void {
    this.byRole.clear();
    this.byTag.clear();
  }
}

/** Compose 2 BP multipliers: combined = a × b / 10000. INT-only. */
function composeBP(a: number, b: number): number {
  return Math.floor((a * b) / 10000);
}

export const threatModifierRegistry = new ThreatModifierRegistryImpl();

/**
 * Default modifier set — installed at boot. Data-driven via ThreatConstants.
 * Caller can extend by registering tag-based entries.
 */
export function registerDefaultThreatModifiers(): void {
  threatModifierRegistry.registerAll([
    { role: 'Tank',      multBP: ThreatConstants.ROLE_TANK_THREAT_MOD_BP },
    { role: 'Healer',    multBP: ThreatConstants.ROLE_HEALER_THREAT_MOD_BP, restrictSource: 'heal' },
    { role: 'DPS_VL',    multBP: ThreatConstants.ROLE_DPS_VL_THREAT_MOD_BP },
    { role: 'DPS_PH',    multBP: ThreatConstants.ROLE_DPS_PH_THREAT_MOD_BP },
    { role: 'Support',   multBP: ThreatConstants.ROLE_SUPPORT_THREAT_MOD_BP },
    { role: 'Control',   multBP: ThreatConstants.ROLE_CONTROL_THREAT_MOD_BP },
    { role: 'Summoner',  multBP: ThreatConstants.ROLE_SUMMONER_THREAT_MOD_BP },
    { tag: 'assassin',   multBP: ThreatConstants.ASSASSIN_TAG_THREAT_MOD_BP },
  ]);
}
