/**
 * COMPANION AFFINITY STORE — Implementation (Phase 8 Contract #5).
 *
 * Affinity tier transitions. Isolation lock per FIX #8 (no combat_runtime / combat_entity import).
 */
import type {
  AffinityApplyResult,
  AffinityDeltaContext,
  AffinityTierThreshold,
  CompanionProgressionHook,
  CompanionProgressionSnapshot,
} from './companion_progression_hook.js';
import type {
  CompanionAffinity,
  CompanionAffinityTier,
  QuestCharId,
} from './quest_types.js';
import { codepointCompare } from '../../_shared/codepoint_compare.js';

const FORBIDDEN_IMPORTS = ['companion_runtime', 'combat_entity', 'threat_engine'];

const DEFAULT_THRESHOLDS: AffinityTierThreshold[] = [
  { tier: 'stranger', min_points: 0, max_points_exclusive: 1000 },
  { tier: 'familiar', min_points: 1000, max_points_exclusive: 3000 },
  { tier: 'trusted', min_points: 3000, max_points_exclusive: 7000 },
  { tier: 'bonded', min_points: 7000, max_points_exclusive: 15000 },
  { tier: 'soulbound', min_points: 15000 },
];

export class CompanionAffinityStore implements CompanionProgressionHook {
  private store = new Map<string, CompanionAffinity>();
  private thresholds: readonly AffinityTierThreshold[] = DEFAULT_THRESHOLDS;
  private idempotencyKeys = new Set<string>();
  private soulboundCapPerChar = 3;

  setSoulboundCap(cap: number): void {
    this.soulboundCapPerChar = cap;
  }

  applyDelta(ctx: AffinityDeltaContext): AffinityApplyResult {
    this.assertIsolation('applyDelta');

    if (this.idempotencyKeys.has(ctx.idempotency_key)) {
      return {
        status: 'duplicate',
        char_id: ctx.char_id,
        companion_id: ctx.companion_id,
        should_emit_unlock_event: false,
        ordinal: ctx.ordinal,
        reason: 'idempotency_key already committed',
      };
    }

    const key = this.affinityKey(ctx.char_id, ctx.companion_id);
    const current =
      this.store.get(key) ??
      ({
        char_id: ctx.char_id,
        companion_id: ctx.companion_id,
        tier: 'stranger' as CompanionAffinityTier,
        points: 0,
        next_tier_threshold: this.thresholdFor('familiar').min_points,
        last_bond_ordinal: 0,
      } as CompanionAffinity);

    const newPoints = Math.max(0, current.points + ctx.delta_points);
    const newTier = this.tierForPoints(newPoints);

    // Soulbound cap check
    if (newTier === 'soulbound' && current.tier !== 'soulbound') {
      const soulboundCount = [...this.store.values()].filter(
        (a) => a.char_id === ctx.char_id && a.tier === 'soulbound',
      ).length;
      if (soulboundCount >= this.soulboundCapPerChar) {
        return {
          status: 'cap_per_char_reached',
          char_id: ctx.char_id,
          companion_id: ctx.companion_id,
          before: current,
          should_emit_unlock_event: false,
          ordinal: ctx.ordinal,
          reason: `Soulbound cap ${this.soulboundCapPerChar} reached for char ${ctx.char_id}`,
        };
      }
    }

    const nextThreshold = this.nextThresholdFor(newTier);
    const after: CompanionAffinity = {
      char_id: ctx.char_id,
      companion_id: ctx.companion_id,
      tier: newTier,
      points: newPoints,
      next_tier_threshold: nextThreshold,
      last_bond_ordinal: ctx.ordinal,
    };

    this.store.set(key, after);
    this.idempotencyKeys.add(ctx.idempotency_key);

    if (newPoints === current.points && newTier === current.tier) {
      return {
        status: 'no_change',
        char_id: ctx.char_id,
        companion_id: ctx.companion_id,
        before: current,
        after,
        should_emit_unlock_event: false,
        ordinal: ctx.ordinal,
      };
    }

    const tierAdvanced = this.tierIndex(newTier) > this.tierIndex(current.tier);
    const tierDemoted = this.tierIndex(newTier) < this.tierIndex(current.tier);

    return {
      status: tierAdvanced ? 'tier_advanced' : tierDemoted ? 'tier_demoted' : 'applied',
      char_id: ctx.char_id,
      companion_id: ctx.companion_id,
      before: current,
      after,
      new_tier: tierAdvanced ? newTier : undefined,
      should_emit_unlock_event: tierAdvanced,
      ordinal: ctx.ordinal,
    };
  }

  getAffinity(char_id: QuestCharId, companion_id: QuestCharId): CompanionAffinity {
    const key = this.affinityKey(char_id, companion_id);
    return (
      this.store.get(key) ?? {
        char_id,
        companion_id,
        tier: 'stranger',
        points: 0,
        next_tier_threshold: this.thresholdFor('familiar').min_points,
        last_bond_ordinal: 0,
      }
    );
  }

  listCompanionsForChar(char_id: QuestCharId): readonly CompanionAffinity[] {
    return [...this.store.values()]
      .filter((a) => a.char_id === char_id)
      .sort((a, b) => codepointCompare(a.companion_id, b.companion_id));
  }

  registerThresholds(thresholds: readonly AffinityTierThreshold[]): void {
    if (this.thresholds !== DEFAULT_THRESHOLDS) {
      throw new Error('Thresholds already registered');
    }
    this.thresholds = thresholds.slice();
  }

  snapshot(ordinal: number): CompanionProgressionSnapshot {
    return {
      schema_version: 1,
      affinities: [...this.store.values()].sort((a, b) =>
        codepointCompare(a.char_id, b.char_id) || codepointCompare(a.companion_id, b.companion_id),
      ),
      ordinal,
    };
  }

  restore(snapshot: CompanionProgressionSnapshot): void {
    if (snapshot.schema_version !== 1) {
      throw new Error(`Schema version mismatch: ${snapshot.schema_version}`);
    }
    this.store.clear();
    for (const a of snapshot.affinities) {
      const key = this.affinityKey(a.char_id, a.companion_id);
      this.store.set(key, a);
    }
  }

  assertIsolation(call_site: string): void {
    // FIX #8 — isolation lock. This is a defense-in-depth assertion.
    // Real enforcement also via lint rule banning imports.
    for (const forbidden of FORBIDDEN_IMPORTS) {
      if (call_site.includes(forbidden)) {
        throw new Error(`Isolation violation: call_site '${call_site}' references forbidden '${forbidden}'`);
      }
    }
  }

  _resetForTest(): void {
    this.store.clear();
    this.idempotencyKeys.clear();
    this.thresholds = DEFAULT_THRESHOLDS;
    this.soulboundCapPerChar = 3;
  }

  private affinityKey(char_id: QuestCharId, companion_id: QuestCharId): string {
    return `${char_id}|${companion_id}`;
  }

  private tierForPoints(points: number): CompanionAffinityTier {
    for (const t of this.thresholds) {
      const max = t.max_points_exclusive;
      if (points >= t.min_points && (max === undefined || points < max)) return t.tier;
    }
    return 'stranger';
  }

  private thresholdFor(tier: CompanionAffinityTier): AffinityTierThreshold {
    const t = this.thresholds.find((x) => x.tier === tier);
    if (!t) throw new Error(`No threshold for tier ${tier}`);
    return t;
  }

  private nextThresholdFor(currentTier: CompanionAffinityTier): number {
    const order: CompanionAffinityTier[] = [
      'stranger',
      'familiar',
      'trusted',
      'bonded',
      'soulbound',
    ];
    const idx = order.indexOf(currentTier);
    if (idx === -1 || idx === order.length - 1) {
      return this.thresholdFor(currentTier).min_points;
    }
    const nextTier = order[idx + 1]!;
    return this.thresholdFor(nextTier).min_points;
  }

  private tierIndex(tier: CompanionAffinityTier): number {
    const order: CompanionAffinityTier[] = [
      'stranger',
      'familiar',
      'trusted',
      'bonded',
      'soulbound',
    ];
    return order.indexOf(tier);
  }
}
