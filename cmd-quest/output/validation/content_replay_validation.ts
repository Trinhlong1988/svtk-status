/**
 * CONTENT REPLAY VALIDATION — Phase 10 §XIII.
 *
 * Verify same replay = same progression result.
 * Track: progression order / world-state change / faction / region / reward ordering.
 */
import { z } from 'zod';
import type { FullProgressionSnapshot, ProgressionReplayRuntime, ReplayMismatchReport } from './progression_replay_runtime.js';

export interface ReplayValidationResult {
  total_replays: number;
  passed: boolean;
  divergent_replay_indices: readonly number[];
  divergent_field_summary: Readonly<Record<string, number>>;
  reports: readonly ReplayMismatchReport[];
}

export class ContentReplayValidation {
  constructor(private readonly replay: ProgressionReplayRuntime) {}

  /**
   * Run N replays of the same snapshot. Verify all produce identical output.
   *
   * @param baseSnapshot — initial state
   * @param replay_count — number of replay iterations
   */
  verifyReplayConsistency(
    baseSnapshot: FullProgressionSnapshot,
    replay_count: number,
  ): ReplayValidationResult {
    const divergentIndices: number[] = [];
    const fieldSummary: Record<string, number> = {};
    const reports: ReplayMismatchReport[] = [];

    const referenceJson = JSON.stringify(baseSnapshot);
    for (let i = 0; i < replay_count; i++) {
      this.replay.restore(baseSnapshot);
      const reproduced = this.replay.snapshot(baseSnapshot.ordinal);
      const reproducedJson = JSON.stringify(reproduced);
      if (referenceJson !== reproducedJson) {
        divergentIndices.push(i);
        const diag = this.replay.diagnoseMismatch(baseSnapshot, reproduced);
        reports.push(diag);
        for (const f of diag.divergent_fields) {
          fieldSummary[f] = (fieldSummary[f] ?? 0) + 1;
        }
      }
    }

    return {
      total_replays: replay_count,
      passed: divergentIndices.length === 0,
      divergent_replay_indices: divergentIndices,
      divergent_field_summary: fieldSummary,
      reports,
    };
  }

  /**
   * Snapshot diff helper — given 2 snapshots, return divergent ordering categories.
   */
  diffOrdering(
    a: FullProgressionSnapshot,
    b: FullProgressionSnapshot,
  ): {
    quest_order_match: boolean;
    world_state_match: boolean;
    companion_affinity_match: boolean;
    reward_ledger_match: boolean;
    region_unlock_match: boolean;
  } {
    return {
      quest_order_match: JSON.stringify(a.quest_progress) === JSON.stringify(b.quest_progress),
      world_state_match: JSON.stringify(a.world_state) === JSON.stringify(b.world_state),
      companion_affinity_match:
        JSON.stringify(a.companion_affinity) === JSON.stringify(b.companion_affinity),
      reward_ledger_match: JSON.stringify(a.reward_ledger) === JSON.stringify(b.reward_ledger),
      region_unlock_match:
        JSON.stringify(a.world_state.flags.filter((f) => f.namespace === 'region')) ===
        JSON.stringify(b.world_state.flags.filter((f) => f.namespace === 'region')),
    };
  }
}
