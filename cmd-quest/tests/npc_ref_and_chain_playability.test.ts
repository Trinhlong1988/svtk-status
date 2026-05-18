import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

interface Quest {
  quest_id: string; chain_id: string; chain_position: number;
  giver_npc_id: number; giver_npc_name: string; giver_scene_id: number;
  level_req: number; prerequisites: string[];
  objectives: { type: string; target_npc_id: number; count?: number }[];
}
interface Npc { _index: number; name: string; sceneId: number; can_give_quest: boolean }

const npcs: Npc[] = readFileSync(
  'C:/Users/Administrator/Desktop/SVTK_UPLOAD_WORK/repo/cmd-npc/existing/NPC_438.jsonl',
  'utf8'
).trim().split('\n').map((l) => JSON.parse(l));

const quests: Quest[] = readFileSync(
  'C:/Users/Administrator/Desktop/SVTK_UPLOAD_WORK/repo/cmd-quest/output/registry/quest_full.jsonl',
  'utf8'
).trim().split('\n').map((l) => JSON.parse(l));

const npcById = new Map(npcs.map((n) => [n._index, n]));

describe('R4 — NPC strict reference', () => {
  it('every giver_npc_id resolves AND has can_give_quest=true', () => {
    const fails: string[] = [];
    for (const q of quests) {
      const n = npcById.get(q.giver_npc_id);
      if (!n) { fails.push(`${q.quest_id} giver=${q.giver_npc_id} not in NPC db`); continue; }
      if (!n.can_give_quest) fails.push(`${q.quest_id} giver=${n.name} can_give_quest=false`);
    }
    expect(fails).toEqual([]);
  });

  it('giver_npc_name + giver_scene_id match NPC db snapshot', () => {
    const fails: string[] = [];
    for (const q of quests) {
      const n = npcById.get(q.giver_npc_id)!;
      if (n.name !== q.giver_npc_name) fails.push(`${q.quest_id} name mismatch`);
      if (n.sceneId !== q.giver_scene_id) fails.push(`${q.quest_id} scene mismatch`);
    }
    expect(fails).toEqual([]);
  });

  it('every objective.target_npc_id resolves', () => {
    const fails: string[] = [];
    for (const q of quests) {
      for (const o of q.objectives) {
        if (!npcById.has(o.target_npc_id)) fails.push(`${q.quest_id} target ${o.target_npc_id} ghost`);
      }
    }
    expect(fails).toEqual([]);
  });
});

describe('R5 — Chain playability simulation', () => {
  const byChain = new Map<string, Quest[]>();
  for (const q of quests) (byChain.get(q.chain_id) ?? byChain.set(q.chain_id, []).get(q.chain_id)!).push(q);
  for (const arr of byChain.values()) arr.sort((a, b) => a.chain_position - b.chain_position);
  const byId = new Map(quests.map((q) => [q.quest_id, q]));

  it('simulator can traverse each chain pos 0 → end without prereq violation', () => {
    const fails: string[] = [];
    for (const [cid, chain] of byChain.entries()) {
      const completed = new Set<string>();
      let playerLevel = 1;
      for (let i = 0; i < chain.length; i++) {
        const q = chain[i];
        if (q.chain_position !== i) {
          fails.push(`${cid}: position gap at idx ${i} pos=${q.chain_position}`);
          break;
        }
        for (const pre of q.prerequisites) {
          if (!completed.has(pre)) {
            fails.push(`${cid} ${q.quest_id}: prereq ${pre} not completed`);
            break;
          }
          const pq = byId.get(pre)!;
          if (pq.level_req > q.level_req) {
            fails.push(`${cid} ${q.quest_id} L${q.level_req}: prereq ${pre} L${pq.level_req} HIGHER`);
            break;
          }
        }
        playerLevel = Math.max(playerLevel, q.level_req);
        if (playerLevel < q.level_req) {
          fails.push(`${cid} ${q.quest_id}: player L${playerLevel} < req L${q.level_req}`);
          break;
        }
        completed.add(q.quest_id);
      }
    }
    expect(fails, fails.slice(0, 5).join('\n')).toEqual([]);
  });

  it('every chain has at least 5 quests (playable depth)', () => {
    const shorts: string[] = [];
    for (const [cid, chain] of byChain.entries()) {
      if (chain.length < 5) shorts.push(`${cid}=${chain.length}`);
    }
    expect(shorts).toEqual([]);
  });
});
