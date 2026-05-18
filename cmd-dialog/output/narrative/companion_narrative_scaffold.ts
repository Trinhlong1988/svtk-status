/**
 * COMPANION NARRATIVE SCAFFOLD — Phase 10 §IX.
 *
 * Bond progression + narrative unlock + region-based interaction milestones.
 * Scaffold data for CompanionNarrativeRuntime.
 *
 * Narrative layer ONLY — does NOT touch combat companion runtime.
 */
import type { NarrativeMilestone } from './companion_narrative_runtime.js';

const COMPANIONS = [
  'yet_kieu', 'tran_binh_trong', 'ly_thuong_kiet',
  'phung_hung', 'an_tu_cong_chua', 'sao_la',
];
const TIERS: { tier: 'familiar' | 'trusted' | 'bonded' | 'soulbound'; suffix: string }[] = [
  { tier: 'familiar', suffix: 'first_meeting' },
  { tier: 'trusted', suffix: 'bond_test' },
  { tier: 'bonded', suffix: 'shared_struggle' },
  { tier: 'soulbound', suffix: 'eternal_oath' },
];

export function generateCompanionNarrativeScaffold(): readonly NarrativeMilestone[] {
  const milestones: NarrativeMilestone[] = [];
  for (const c of COMPANIONS) {
    for (const t of TIERS) {
      milestones.push({
        companion_id: `companion_${c}_p_01`,
        tier_required: t.tier,
        milestone_id: `milestone_${c}_${t.suffix}`,
        trigger_dialog_id: `dialog_${c}_${t.suffix}`,
        set_flag_id: `flag_main_companion_${c}_${t.tier}`,
        name_vi: `${c.replace(/_/g, ' ')} — ${t.suffix.replace(/_/g, ' ')}`,
      });
    }
  }
  return milestones;
}
