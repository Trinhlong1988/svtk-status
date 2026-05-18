/**
 * COMPANION NARRATIVE RUNTIME — Phase 9 §XI.
 *
 * Narrative layer ONLY. NO combat companion runtime touch (bootstrap §XI strict).
 * Story unlock / reaction trigger / bond progression / narrative milestone.
 */
import { z } from 'zod';
import type {
  AffinityDeltaSource,
  CompanionProgressionHook,
} from './companion_progression_hook.js';
import type { CompanionAffinity, CompanionAffinityTier, QuestCharId } from './quest_types.js';
import { codepointCompare } from '../../_shared/codepoint_compare.js';

export const NarrativeMilestoneSchema = z.object({
  companion_id: z.string().regex(/^(char_|companion_)[a-z0-9_]+$/),
  /** Tier at which milestone unlocks. */
  tier_required: z.enum(['stranger', 'familiar', 'trusted', 'bonded', 'soulbound']),
  /** Milestone id — for tracking. */
  milestone_id: z.string().regex(/^milestone_[a-z0-9_]+$/),
  /** Optional dialog to trigger. */
  trigger_dialog_id: z.string().regex(/^dialog_/).optional(),
  /** Optional flag to set. */
  set_flag_id: z.string().regex(/^flag_/).optional(),
  name_vi: z.string(),
});
export type NarrativeMilestone = z.infer<typeof NarrativeMilestoneSchema>;

export interface NarrativeUnlockResult {
  companion_id: string;
  unlocked_milestones: readonly NarrativeMilestone[];
  tier_advanced: boolean;
  new_tier?: CompanionAffinityTier;
}

const TIER_ORDER: CompanionAffinityTier[] = [
  'stranger',
  'familiar',
  'trusted',
  'bonded',
  'soulbound',
];

export class CompanionNarrativeRuntime {
  private milestones = new Map<string, NarrativeMilestone[]>();
  private unlockedMilestones = new Set<string>();

  constructor(private readonly affinity: CompanionProgressionHook) {}

  registerMilestone(m: NarrativeMilestone): void {
    const list = this.milestones.get(m.companion_id) ?? [];
    list.push(m);
    list.sort(
      (a, b) =>
        TIER_ORDER.indexOf(a.tier_required) - TIER_ORDER.indexOf(b.tier_required) ||
        codepointCompare(a.milestone_id, b.milestone_id),
    );
    this.milestones.set(m.companion_id, list);
  }

  applyNarrativeDelta(
    char_id: QuestCharId,
    companion_id: QuestCharId,
    source: AffinityDeltaSource,
    delta_points: number,
    idempotency_key: string,
    ordinal: number,
  ): NarrativeUnlockResult {
    const before = this.affinity.getAffinity(char_id, companion_id);
    const result = this.affinity.applyDelta({
      char_id,
      companion_id,
      source,
      delta_points,
      idempotency_key,
      ordinal,
    });

    const unlocked: NarrativeMilestone[] = [];
    if (result.after) {
      const tier = result.after.tier;
      const list = this.milestones.get(companion_id) ?? [];
      for (const m of list) {
        const tierIdx = TIER_ORDER.indexOf(tier);
        const reqIdx = TIER_ORDER.indexOf(m.tier_required);
        const key = `${char_id}|${companion_id}|${m.milestone_id}`;
        if (tierIdx >= reqIdx && !this.unlockedMilestones.has(key)) {
          this.unlockedMilestones.add(key);
          unlocked.push(m);
        }
      }
    }

    return {
      companion_id,
      unlocked_milestones: unlocked,
      tier_advanced: result.status === 'tier_advanced',
      new_tier: result.new_tier,
    };
  }

  listUnlockedMilestones(char_id: QuestCharId, companion_id: QuestCharId): readonly string[] {
    const prefix = `${char_id}|${companion_id}|`;
    return [...this.unlockedMilestones]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .sort();
  }

  snapshot(): readonly string[] {
    return [...this.unlockedMilestones].sort();
  }

  restore(keys: readonly string[]): void {
    this.unlockedMilestones = new Set(keys);
  }

  _resetForTest(): void {
    this.milestones.clear();
    this.unlockedMilestones.clear();
  }
}
