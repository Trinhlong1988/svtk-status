/**
 * SKILL TARGETING — 9 target modes (Phase 3 spec § VI).
 *
 * Modes:
 *   - self
 *   - ally          (single)
 *   - enemy         (single)
 *   - ally_team     (full party)
 *   - enemy_team    (all enemies)
 *   - aoe_circle    (max N around primary, deterministic radius via mode-specific arena)
 *   - aoe_line      (max N along line — caller provides ordered list)
 *   - summon_target (caster's summon — primary id explicit)
 *   - dead_ally     (revive target)
 *
 * Determinism:
 *   - Caller responsible for stable iteration order in chars Map (insertion order = JS spec)
 *   - resolveTargets returns array sorted by char.id (lexicographic) cho stable replay
 *   - Cap MAX_TARGET_PER_CAST hard
 */
import type { CombatChar } from './types.js';
import type { TargetMode, SkillTemplate, SkillCastRequest } from './skill_types.js';
import type { BattleField } from './combat_entity.js';
import { SkillConstants } from './skill_constants.js';

export type TargetingError =
  | 'invalid_target_id'
  | 'target_dead_for_alive_only'
  | 'target_alive_for_dead_only'
  | 'target_team_mismatch'
  | 'no_resolvable_target'
  | 'unsupported_mode';

export interface TargetingResult {
  ids: string[];
  error?: TargetingError;
}

export interface TargetingContext {
  /** Char lookup. Caller-owned. */
  chars: Map<string, CombatChar>;
  /** Caster's team membership lookup (true if same team). */
  isAlly: (a: CombatChar, b: CombatChar) => boolean;
  /** Optional battle field — required for companion/owner modes (FIX PHASE 3 § IX). */
  field?: BattleField;
  /** Reserve companion id pool for swap_trigger / reserve_companion mode. */
  reserveCompanionIds?: readonly string[];
}

/**
 * Resolve target list deterministically.
 *
 * @param request — cast request (provides primaryTargetId / resolvedTargetIds)
 * @param skill — template (target_mode + max_targets)
 * @param caster — casting char
 * @param tctx — targeting context
 */
export function resolveTargets(
  request: SkillCastRequest,
  skill: SkillTemplate,
  caster: CombatChar,
  tctx: TargetingContext,
): TargetingResult {
  const cap = Math.min(
    skill.max_targets ?? SkillConstants.MAX_TARGET_PER_CAST,
    SkillConstants.MAX_TARGET_PER_CAST,
  );

  switch (skill.target_mode) {
    case 'self':
      return { ids: [caster.id] };

    case 'ally': {
      const id = request.primaryTargetId;
      if (!id) return { ids: [], error: 'invalid_target_id' };
      const t = tctx.chars.get(id);
      if (!t) return { ids: [], error: 'invalid_target_id' };
      if (!t.alive) return { ids: [], error: 'target_dead_for_alive_only' };
      if (!tctx.isAlly(caster, t)) return { ids: [], error: 'target_team_mismatch' };
      return { ids: [id] };
    }

    case 'enemy': {
      const id = request.primaryTargetId;
      if (!id) return { ids: [], error: 'invalid_target_id' };
      const t = tctx.chars.get(id);
      if (!t) return { ids: [], error: 'invalid_target_id' };
      if (!t.alive) return { ids: [], error: 'target_dead_for_alive_only' };
      if (tctx.isAlly(caster, t)) return { ids: [], error: 'target_team_mismatch' };
      return { ids: [id] };
    }

    case 'ally_team': {
      const out: string[] = [];
      for (const c of tctx.chars.values()) {
        if (c.alive && tctx.isAlly(caster, c)) out.push(c.id);
      }
      out.sort();
      return { ids: out.slice(0, cap) };
    }

    case 'enemy_team': {
      const out: string[] = [];
      for (const c of tctx.chars.values()) {
        if (c.alive && !tctx.isAlly(caster, c)) out.push(c.id);
      }
      out.sort();
      return { ids: out.slice(0, cap) };
    }

    case 'aoe_circle': {
      // Caller MUST pre-resolve target list (server-authoritative geometry).
      // resolvedTargetIds[] = pre-validated by spatial query subsystem (Module 6).
      const list = request.resolvedTargetIds ?? [];
      const out: string[] = [];
      for (const id of list) {
        const c = tctx.chars.get(id);
        if (c?.alive && !tctx.isAlly(caster, c)) out.push(id);
      }
      out.sort();
      return { ids: out.slice(0, Math.min(cap, SkillConstants.TARGET_AOE_MAX_HITS)) };
    }

    case 'aoe_line': {
      // Caller pre-resolved. Order preserved (line direction matters for visual but
      // we sort by id for determinism — combat resolution order independent of visual).
      const list = request.resolvedTargetIds ?? [];
      const out: string[] = [];
      for (const id of list) {
        const c = tctx.chars.get(id);
        if (c?.alive && !tctx.isAlly(caster, c)) out.push(id);
      }
      out.sort();
      return { ids: out.slice(0, Math.min(cap, SkillConstants.TARGET_LINE_MAX_HITS)) };
    }

    case 'summon_target': {
      const id = request.primaryTargetId;
      if (!id) return { ids: [], error: 'invalid_target_id' };
      const t = tctx.chars.get(id);
      if (!t) return { ids: [], error: 'invalid_target_id' };
      // Summon may be living NPC owned by caster — relaxed alive check.
      return { ids: [id] };
    }

    case 'dead_ally': {
      const id = request.primaryTargetId;
      if (!id) return { ids: [], error: 'invalid_target_id' };
      const t = tctx.chars.get(id);
      if (!t) return { ids: [], error: 'invalid_target_id' };
      if (t.alive) return { ids: [], error: 'target_alive_for_dead_only' };
      if (!tctx.isAlly(caster, t)) return { ids: [], error: 'target_team_mismatch' };
      return { ids: [id] };
    }

    // ─── FIX PHASE 3 § IX — companion-aware modes ───
    case 'companion': {
      // Caster's companion (PET/SUMMON owned by caster).
      if (!tctx.field) return { ids: [], error: 'no_resolvable_target' };
      const compId = tctx.field.companionOf.get(caster.id);
      if (!compId) return { ids: [], error: 'no_resolvable_target' };
      const compEntity = tctx.field.entitiesById.get(compId);
      if (!compEntity?.char.alive) return { ids: [], error: 'target_dead_for_alive_only' };
      return { ids: [compId] };
    }

    case 'owner': {
      // Caster IS companion → resolve owner.
      if (!tctx.field) return { ids: [], error: 'no_resolvable_target' };
      const ownerId = tctx.field.ownerOf.get(caster.id);
      if (!ownerId) return { ids: [], error: 'no_resolvable_target' };
      const ownerEntity = tctx.field.entitiesById.get(ownerId);
      if (!ownerEntity?.char.alive) return { ids: [], error: 'target_dead_for_alive_only' };
      return { ids: [ownerId] };
    }

    case 'owner_and_companion': {
      // Pair: caster + their companion (or caster + owner if caster is companion).
      if (!tctx.field) return { ids: [caster.id] };
      const out = new Set<string>([caster.id]);
      const compId = tctx.field.companionOf.get(caster.id);
      if (compId && tctx.field.entitiesById.get(compId)?.char.alive) out.add(compId);
      const ownerId = tctx.field.ownerOf.get(caster.id);
      if (ownerId && tctx.field.entitiesById.get(ownerId)?.char.alive) out.add(ownerId);
      const sorted = [...out].sort();
      return { ids: sorted };
    }

    case 'reserve_companion': {
      // Reserve pool — returns first valid alive id.
      const reserves = tctx.reserveCompanionIds ?? [];
      for (const id of reserves) {
        const c = tctx.chars.get(id);
        if (c?.alive) return { ids: [id] };
      }
      return { ids: [], error: 'no_resolvable_target' };
    }
  }

  return { ids: [], error: 'unsupported_mode' };
}

/** Default isAlly — same playerId or both NPC = ally. Caller may override. */
export function defaultIsAlly(a: CombatChar, b: CombatChar): boolean {
  if (a.playerId && b.playerId) return a.playerId === b.playerId;
  if (a.npcId && b.npcId) return true;
  return false;
}

/** Stable lexicographic sort key — replay-safe. */
export function targetingExportKey(mode: TargetMode, ids: readonly string[]): string {
  return `${mode}:${[...ids].sort().join(',')}`;
}
