/**
 * STANDARD HANDLERS — 11 BẮT BUỘC effect type per CLAUDE.md mục 8 + Phase 2 spec.
 *
 * Each handler implements:
 *   - type: EffectType identity
 *   - category, drGroup, stackBehavior
 *   - onApply / onTick / onRemove (any subset, all optional)
 *
 * Pure direct mutation per R33 — no abstraction in hot-path.
 * NO if(type === ...) anywhere — registry dispatch only.
 *
 * Register via `registerStandardHandlers()` at boot time.
 */
import type { EffectHandler, StatusEffect, EffectHandlerContext } from '../status_types.js';
import type { CombatChar } from '../types.js';
import { StatusConstants } from '../status_constants.js';

// ─────────────────────────────────────────────────────────
// 1. DOT (burn / poison / bleed grouped)
// ─────────────────────────────────────────────────────────
const dotHandler: EffectHandler = {
  type: 'dot',
  category: 'DOT',
  drGroup: 'dot',
  stackBehavior: 'capped',
  onTick(target: CombatChar, eff: StatusEffect, _ctx: EffectHandlerContext) {
    const dmg = eff.amount * eff.stacks;
    target.hp = Math.max(0, target.hp - dmg);
  },
};

// ─────────────────────────────────────────────────────────
// 2. HOT (regen / heal aura)
// ─────────────────────────────────────────────────────────
const hotHandler: EffectHandler = {
  type: 'hot',
  category: 'HOT',
  drGroup: 'hot',
  stackBehavior: 'capped',
  onTick(target, eff, _ctx) {
    const heal = eff.amount * eff.stacks;
    target.hp = Math.min(target.maxHp, target.hp + heal);
  },
};

// ─────────────────────────────────────────────────────────
// 3. SHIELD (absorb pool)
// ─────────────────────────────────────────────────────────
const shieldHandler: EffectHandler = {
  type: 'shield',
  category: 'DEFENSIVE',
  drGroup: 'none',
  stackBehavior: 'strongest',
  onApply(target, eff, _ctx) {
    target.shield = Math.max(target.shield, eff.amount);
  },
  onRemove(target, eff, _ctx) {
    if (target.shield <= eff.amount) {
      target.shield = 0;
    }
  },
};

// ─────────────────────────────────────────────────────────
// 4. TAUNT (forced target — Module 4 ThreatService consumes)
// ─────────────────────────────────────────────────────────
const tauntHandler: EffectHandler = {
  type: 'taunt',
  category: 'THREAT_CONTROL',
  drGroup: 'none',
  stackBehavior: 'refresh',
};

// ─────────────────────────────────────────────────────────
// 5. SILENCE (cannot cast skill)
// ─────────────────────────────────────────────────────────
const silenceHandler: EffectHandler = {
  type: 'silence',
  category: 'SOFT_CC',
  drGroup: 'soft_cc',
  stackBehavior: 'refresh',
  onApply(target, eff, _ctx) {
    target.cc.silenced = (target.cc.silenced ?? 0) + eff.remainingTurns;
  },
  onRemove(target, _eff, _ctx) {
    target.cc.silenced = undefined;
  },
};

// ─────────────────────────────────────────────────────────
// 6. FREEZE (skip turn)
// ─────────────────────────────────────────────────────────
const freezeHandler: EffectHandler = {
  type: 'freeze',
  category: 'HARD_CC',
  drGroup: 'hard_cc',
  stackBehavior: 'refresh',
  onApply(target, eff, _ctx) {
    target.cc.frozen = (target.cc.frozen ?? 0) + eff.remainingTurns;
  },
  onRemove(target, _eff, _ctx) {
    target.cc.frozen = undefined;
  },
};

// ─────────────────────────────────────────────────────────
// 7. STUN
// ─────────────────────────────────────────────────────────
const stunHandler: EffectHandler = {
  type: 'stun',
  category: 'HARD_CC',
  drGroup: 'hard_cc',
  stackBehavior: 'refresh',
  onApply(target, eff, _ctx) {
    target.cc.stunned = (target.cc.stunned ?? 0) + eff.remainingTurns;
  },
  onRemove(target, _eff, _ctx) {
    target.cc.stunned = undefined;
  },
};

// ─────────────────────────────────────────────────────────
// 8. CLEANSE (instant — Module 2 cleanse.ts handles)
// ─────────────────────────────────────────────────────────
const cleanseHandler: EffectHandler = {
  type: 'cleanse',
  category: 'SUPPORT',
  drGroup: 'none',
  stackBehavior: 'unique',
};

// ─────────────────────────────────────────────────────────
// 9. ANTI_HEAL (reduce healing received — F-2 calcHeal reads)
// ─────────────────────────────────────────────────────────
const antiHealHandler: EffectHandler = {
  type: 'anti_heal',
  category: 'SUPPORT',
  drGroup: 'soft_cc',
  stackBehavior: 'refresh',
};

// ─────────────────────────────────────────────────────────
// 10. REFLECT (% damage return — pipeline subscriber phase post_resolve)
// ─────────────────────────────────────────────────────────
const reflectHandler: EffectHandler = {
  type: 'reflect',
  category: 'DEFENSIVE',
  drGroup: 'none',
  stackBehavior: 'strongest',
};

// ─────────────────────────────────────────────────────────
// 11. SUMMON_LINK (summon hold threat — Module 4 reads)
// ─────────────────────────────────────────────────────────
const summonLinkHandler: EffectHandler = {
  type: 'summon_link',
  category: 'THREAT_CONTROL',
  drGroup: 'none',
  stackBehavior: 'unique',
};

// ─────────────────────────────────────────────────────────
// Public registration
// ─────────────────────────────────────────────────────────

import { effectRegistry } from '../effect_registry.js';

export const STANDARD_HANDLERS: readonly EffectHandler[] = [
  dotHandler,
  hotHandler,
  shieldHandler,
  tauntHandler,
  silenceHandler,
  freezeHandler,
  stunHandler,
  cleanseHandler,
  antiHealHandler,
  reflectHandler,
  summonLinkHandler,
];

export function registerStandardHandlers(): void {
  effectRegistry._reset();
  effectRegistry.registerAll(STANDARD_HANDLERS);
}

void StatusConstants;
