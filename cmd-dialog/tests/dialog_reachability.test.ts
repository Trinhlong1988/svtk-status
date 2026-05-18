import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

interface Branch { choice: string; next: string }
interface Node { id: string; speaker: string; text: string; branches?: Branch[]; terminal?: boolean; on_enter?: { effect?: string; quest_id?: string } }
interface Tree { dialog_id: string; quest_id: string; giver_npc_id: number; nodes: Node[] }

function bfsReachable(tree: Tree, startId: string): Set<string> {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const visited = new Set<string>();
  const queue: string[] = [startId];
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const n = byId.get(id);
    if (!n) continue;
    for (const b of n.branches ?? []) if (!visited.has(b.next)) queue.push(b.next);
  }
  return visited;
}

describe('R3 — Dialog tree reachability', () => {
  const trees: Tree[] = readFileSync(
    'C:/Users/Administrator/Desktop/SVTK_UPLOAD_WORK/repo/cmd-dialog/output/registry/dialog_tree.jsonl',
    'utf8'
  ).trim().split('\n').map((l) => JSON.parse(l));

  it('every node reachable from intro (no orphan)', () => {
    const orphans: string[] = [];
    for (const t of trees) {
      const reachable = bfsReachable(t, 'intro');
      for (const n of t.nodes) {
        if (!reachable.has(n.id)) orphans.push(`${t.dialog_id}:${n.id}`);
      }
    }
    expect(orphans, orphans.slice(0, 10).join('\n')).toEqual([]);
  });

  it('every branch.next resolves to a real node id', () => {
    const dangling: string[] = [];
    for (const t of trees) {
      const ids = new Set(t.nodes.map((n) => n.id));
      for (const n of t.nodes) {
        for (const b of n.branches ?? []) {
          if (!ids.has(b.next)) dangling.push(`${t.dialog_id}:${n.id}.${b.choice}→${b.next}`);
        }
      }
    }
    expect(dangling, dangling.slice(0, 10).join('\n')).toEqual([]);
  });

  it('every accept node has on_enter with matching quest_id', () => {
    const bad: string[] = [];
    for (const t of trees) {
      const accept = t.nodes.find((n) => n.id === 'accept');
      if (!accept) { bad.push(`${t.dialog_id}: no accept node`); continue; }
      if (!accept.on_enter || accept.on_enter.effect !== 'quest_accept' || accept.on_enter.quest_id !== t.quest_id) {
        bad.push(`${t.dialog_id}: accept on_enter malformed`);
      }
    }
    expect(bad, bad.slice(0, 5).join('\n')).toEqual([]);
  });

  it('terminal nodes (accept/decline) have no outgoing branches', () => {
    const bad: string[] = [];
    for (const t of trees) {
      for (const n of t.nodes) {
        if (n.terminal && (n.branches?.length ?? 0) > 0) bad.push(`${t.dialog_id}:${n.id} terminal+branches`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });
});
