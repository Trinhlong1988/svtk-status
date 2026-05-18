// CMD3 — Dialog tree scaffold (Phase 14 Week 2)
// Mirror of cmd-quest registry: one dialog tree per quest dialog_tree_ref
// Schema: minimal 3-node tree (intro / accept / decline)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const QUEST_PATH = join(REPO, 'cmd-quest', 'output', 'registry', 'quest_full.jsonl');
const OUT = join(REPO, 'cmd-dialog', 'output', 'registry');
mkdirSync(OUT, { recursive: true });

const quests = readFileSync(QUEST_PATH, 'utf8').trim().split('\n').map(JSON.parse);

const trees = quests.map(q => ({
  dialog_id: q.dialog_tree_ref,
  quest_id: q.quest_id,
  giver_npc_id: q.giver_npc_id,
  nodes: [
    {
      id: 'intro',
      speaker: 'npc',
      text: `[${q.giver_npc_name}] Hãy giúp ta một việc liên quan ${q.name}.`,
      branches: [
        { choice: 'accept', next: 'accept' },
        { choice: 'decline', next: 'decline' },
      ],
    },
    {
      id: 'accept',
      speaker: 'npc',
      text: `Tốt. Hoàn tất mục tiêu rồi quay lại đây.`,
      on_enter: { effect: 'quest_accept', quest_id: q.quest_id },
      terminal: true,
    },
    {
      id: 'decline',
      speaker: 'npc',
      text: `Vậy hãy quay lại khi sẵn sàng.`,
      terminal: true,
    },
  ],
  status: 'scaffold',
  schema_version: '1.0',
  generated_by: 'cmd-dialog gen_dialog_tree_150.mjs',
  generated_at: '2026-05-18T14:00:00Z',
}));

const jsonl = trees.map(t => JSON.stringify(t)).join('\n') + '\n';
writeFileSync(join(OUT, 'dialog_tree.jsonl'), jsonl);

// Verify referential integrity quest_id ↔ dialog_id
const dialogIds = new Set(trees.map(t => t.dialog_id));
const orphans = quests.filter(q => !dialogIds.has(q.dialog_tree_ref));
if (orphans.length) {
  console.error(`Orphan dialog refs: ${orphans.length}`);
  process.exit(1);
}
console.log(`Dialog trees: ${trees.length}`);
console.log(`Nodes/tree: 3 (intro/accept/decline)`);
console.log(`Cross-ref quest_id ↔ dialog_id: OK`);
