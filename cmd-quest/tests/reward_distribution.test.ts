import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

interface Quest { quest_id: string; level_req: number; rewards: { exp: number; gold: number } }

const quests: Quest[] = readFileSync(
  'C:/Users/Administrator/Desktop/SVTK_UPLOAD_WORK/repo/cmd-quest/output/registry/quest_full.jsonl',
  'utf8'
).trim().split('\n').map((l) => JSON.parse(l));

describe('R6 — Reward distribution statistical', () => {
  it('exp and gold both positive integers', () => {
    for (const q of quests) {
      expect(Number.isInteger(q.rewards.exp), `${q.quest_id}.exp not int`).toBe(true);
      expect(q.rewards.exp).toBeGreaterThan(0);
      expect(Number.isInteger(q.rewards.gold), `${q.quest_id}.gold not int`).toBe(true);
      expect(q.rewards.gold).toBeGreaterThan(0);
    }
  });

  it('no exp z-score outlier > 3 SD from mean', () => {
    const xs = quests.map((q) => q.rewards.exp);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    const outliers = quests.filter((q) => Math.abs((q.rewards.exp - mean) / sd) > 3);
    expect(outliers, outliers.map((q) => q.quest_id).join(', ')).toEqual([]);
  });

  it('exp correlates positively with level_req (Spearman > 0.5)', () => {
    // Rank-based correlation: high level should yield high exp
    const sorted = [...quests].sort((a, b) => a.level_req - b.level_req);
    const ranks = new Map(sorted.map((q, i) => [q.quest_id, i]));
    const expRanked = [...quests].sort((a, b) => a.rewards.exp - b.rewards.exp);
    const expRanks = new Map(expRanked.map((q, i) => [q.quest_id, i]));
    let dSqSum = 0;
    for (const q of quests) {
      const d = ranks.get(q.quest_id)! - expRanks.get(q.quest_id)!;
      dSqSum += d * d;
    }
    const n = quests.length;
    const rho = 1 - (6 * dSqSum) / (n * (n * n - 1));
    expect(rho).toBeGreaterThan(0.5);
  });

  it('gold reward bounded reasonably (no quest pays > 50_000 gold)', () => {
    const richies = quests.filter((q) => q.rewards.gold > 50_000);
    expect(richies, richies.map((q) => `${q.quest_id}=${q.rewards.gold}`).join(', ')).toEqual([]);
  });
});
