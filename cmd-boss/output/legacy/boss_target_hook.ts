/**
 * BOSS TARGET HOOK — pluggable AI target policy (FIX PHASE 4 #4 HIGH).
 *
 * Boss AI (Phase 5/7) MUST NOT rewrite threat engine. Instead, register a
 * TargetPolicyHook that resolveTarget consults BEFORE highest_threat default.
 *
 * Hook ordering (already in threat_resolver.ts):
 *   1. taunt_override          (always wins, even over scripted)
 *   2. scripted_override       (boss script forces target)
 *   3. mechanic_override       (boss mechanic — vd "lowest hp")
 *   4. highest_threat (default + hysteresis)
 *   5. nearest_threat          (when distanceMap + contested)
 *   6. anti_exploit_fallback   (top.threat = 0)
 *
 * This module provides HELPER builders + standard policies (bait/healer-punish/weighted)
 * that produce scriptedTargetId / mechanicTargetId for the resolver context.
 */
import type { ThreatEntryV2 } from '../../../cmd-engine/output/legacy/threat_types.js';
import { sortedByThreat } from '../../../cmd-engine/output/legacy/threat_table.js';
import type { RNG } from '../../../cmd-engine/output/legacy/rng.js';

export type BossTargetPolicyKind =
  | 'highest_threat'        // (default — no override needed)
  | 'weighted_threat'       // probabilistic by threat weight
  | 'scripted_target'       // explicit id from boss script
  | 'mechanic_lowest_hp'    // mechanic: pick lowest hp
  | 'mechanic_furthest'     // mechanic: pick farthest entity
  | 'bait_target'           // bait: pick 2nd-highest (bait trap)
  | 'healer_punish'         // target healers (filter by role tag)
  | 'random_weight'         // pure random eligible
  | 'anti_exploit_only';    // only kicks in when top.threat = 0

export interface BossTargetPolicy {
  kind: BossTargetPolicyKind;
  /** Optional explicit target (for scripted_target). */
  scriptedTargetId?: string;
  /** Optional hp lookup (for mechanic_lowest_hp). */
  hpOf?: (entityId: string) => number;
  /** Optional distance lookup (for mechanic_furthest). */
  distanceOf?: (entityId: string) => number;
  /** Optional role/tag filter (for healer_punish). */
  tagFilter?: (entityId: string) => boolean;
  /** Optional RNG (for weighted/random — rng_ai_threat substream). */
  rng?: RNG;
}

export interface PolicyOutcome {
  targetId?: string;
  via: BossTargetPolicyKind;
}

/**
 * Apply policy. Returns target id (or undefined → fallback to resolver default).
 *
 * Pure: no mutation. Caller passes result via TargetResolveContext.scriptedTargetId
 * or mechanicTargetId.
 */
export function applyBossTargetPolicy(
  policy: BossTargetPolicy,
  table: Map<string, ThreatEntryV2>,
  isEligible?: (id: string) => boolean,
): PolicyOutcome {
  const eligible = sortedByThreat(table).filter((e) => isEligible?.(e.attackerId) ?? true);
  if (eligible.length === 0) return { via: policy.kind };

  switch (policy.kind) {
    case 'highest_threat':
      return { via: 'highest_threat' };    // resolver default — no override

    case 'scripted_target':
      if (policy.scriptedTargetId && (isEligible?.(policy.scriptedTargetId) ?? true)) {
        return { targetId: policy.scriptedTargetId, via: 'scripted_target' };
      }
      return { via: 'scripted_target' };

    case 'mechanic_lowest_hp': {
      if (!policy.hpOf) return { via: policy.kind };
      let best = eligible[0]!;
      let bestHp = policy.hpOf(best.attackerId);
      for (const e of eligible) {
        const hp = policy.hpOf(e.attackerId);
        if (hp < bestHp || (hp === bestHp && e.attackerId < best.attackerId)) {
          best = e;
          bestHp = hp;
        }
      }
      return { targetId: best.attackerId, via: 'mechanic_lowest_hp' };
    }

    case 'mechanic_furthest': {
      if (!policy.distanceOf) return { via: policy.kind };
      let best = eligible[0]!;
      let bestDist = policy.distanceOf(best.attackerId);
      for (const e of eligible) {
        const d = policy.distanceOf(e.attackerId);
        if (d > bestDist || (d === bestDist && e.attackerId < best.attackerId)) {
          best = e;
          bestDist = d;
        }
      }
      return { targetId: best.attackerId, via: 'mechanic_furthest' };
    }

    case 'bait_target': {
      if (eligible.length < 2) return { via: 'bait_target' };
      return { targetId: eligible[1]!.attackerId, via: 'bait_target' };
    }

    case 'healer_punish': {
      if (!policy.tagFilter) return { via: 'healer_punish' };
      const healer = eligible.find((e) => policy.tagFilter!(e.attackerId));
      if (healer) return { targetId: healer.attackerId, via: 'healer_punish' };
      return { via: 'healer_punish' };
    }

    case 'random_weight': {
      if (!policy.rng) return { via: 'random_weight' };
      const idx = Math.floor(policy.rng() * eligible.length);
      const safeIdx = Math.min(idx, eligible.length - 1);
      return { targetId: eligible[safeIdx]!.attackerId, via: 'random_weight' };
    }

    case 'weighted_threat': {
      if (!policy.rng) return { via: 'weighted_threat' };
      const total = eligible.reduce((s, e) => s + Math.max(1, e.threat), 0);
      const pick = Math.floor(policy.rng() * total);
      let acc = 0;
      for (const e of eligible) {
        acc += Math.max(1, e.threat);
        if (pick < acc) return { targetId: e.attackerId, via: 'weighted_threat' };
      }
      return { targetId: eligible[eligible.length - 1]!.attackerId, via: 'weighted_threat' };
    }

    case 'anti_exploit_only':
      if (eligible[0]!.threat === 0 && eligible.length > 1) {
        return { targetId: eligible[1]!.attackerId, via: 'anti_exploit_only' };
      }
      return { via: 'anti_exploit_only' };
  }

  return { via: policy.kind };
}
