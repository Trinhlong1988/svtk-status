// CMD3 — Dialog tree generator v1.1 (Phase 14)
// One dialog tree per quest in quest_full.jsonl (v1.9 schema: title, description, giver_npc_name).
// Supersedes gen_dialog_tree_150.mjs (kept as historical scaffold).
// Schema: 3-node tree (intro / accept / decline) — minimal contract for cmd-engine wire.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const QUEST_PATH = join(REPO, 'cmd-quest', 'output', 'registry', 'quest_full.jsonl');
const OUT = join(REPO, 'cmd-dialog', 'output', 'registry');
const REPORT_DIR = join(REPO, 'cmd-dialog', 'output', 'reports');
mkdirSync(OUT, { recursive: true });
mkdirSync(REPORT_DIR, { recursive: true });

const quests = readFileSync(QUEST_PATH, 'utf8').trim().split('\n').map(JSON.parse);

const NOW = '2026-05-19T03:00:00Z';
const GEN_TAG = 'cmd-dialog gen_dialog_tree_v11.mjs';
const SCHEMA_VERSION = '1.1';

// v1.9 quest registry: 150 legacy_scaffold quests carry dialog_tree_ref,
// the other 2850 generated quests have dialog_tree_ref=null. Fallback:
// compute deterministic DLG_Q_<quest_id> for those — 1:1 with quest_id.
const trees = quests.map((q) => {
  const giverName = q.giver_npc_name || `NPC_${q.giver_npc_id}`;
  const subject = q.title || q.description || `quest ${q.quest_id}`;
  const dialogId = q.dialog_tree_ref
    || `DLG_Q_${String(q.quest_id).padStart(5, '0')}`;
  return {
    dialog_id: dialogId,
    quest_id: q.quest_id,
    quest_uid_legacy: q.quest_uid_legacy ?? null,
    giver_npc_id: q.giver_npc_id,
    giver_scene_id: q.giver_scene_id ?? null,
    era: q.era,
    chain_id: q.chain_id ?? null,
    nodes: [
      {
        id: 'intro',
        speaker: 'npc',
        text: `[${giverName}] Hãy giúp ta một việc liên quan ${subject}.`,
        branches: [
          { choice: 'accept', next: 'accept' },
          { choice: 'decline', next: 'decline' },
        ],
      },
      {
        id: 'accept',
        speaker: 'npc',
        text: 'Tốt. Hoàn tất mục tiêu rồi quay lại đây.',
        on_enter: { effect: 'quest_accept', quest_id: q.quest_id },
        terminal: true,
      },
      {
        id: 'decline',
        speaker: 'npc',
        text: 'Vậy hãy quay lại khi sẵn sàng.',
        terminal: true,
      },
    ],
    status: 'scaffold',
    schema_version: SCHEMA_VERSION,
    generated_by: GEN_TAG,
    generated_at: NOW,
  };
});

// LF-only write per v1.9 rule
const jsonl = trees.map((t) => JSON.stringify(t)).join('\n') + '\n';
writeFileSync(join(OUT, 'dialog_tree.jsonl'), jsonl);

// Audit
const dialogIds = new Set(trees.map((t) => t.dialog_id));
if (dialogIds.size !== trees.length) {
  const dupCount = trees.length - dialogIds.size;
  console.error(`FAIL: duplicate dialog_id count=${dupCount}`);
  process.exit(1);
}
// Orphan check only over quests that DO carry an explicit dialog_tree_ref
// (the 150 legacy scaffold). Generated quests use DLG_Q_<id> fallback by
// construction so they cannot orphan.
const orphans = quests.filter(
  (q) => q.dialog_tree_ref && !dialogIds.has(q.dialog_tree_ref)
);
if (orphans.length) {
  console.error(`FAIL: orphan explicit dialog refs=${orphans.length}`);
  process.exit(1);
}
const undefText = trees.filter((t) =>
  t.nodes.some((n) => n.text && (n.text.includes('undefined') || n.text.includes('[null]')))
);
if (undefText.length) {
  console.error(`FAIL: undefined/null in intro text count=${undefText.length}`);
  process.exit(1);
}

const summary = {
  schema_version: SCHEMA_VERSION,
  generated_by: GEN_TAG,
  generated_at: NOW,
  quest_input_count: quests.length,
  dialog_tree_count: trees.length,
  unique_dialog_id: dialogIds.size,
  orphan_quest_refs: orphans.length,
  undefined_text_lines: undefText.length,
  nodes_per_tree: 3,
  total_node_lines: trees.length * 3,
};

writeFileSync(
  join(REPORT_DIR, 'dialog_tree_summary.json'),
  JSON.stringify(summary, null, 2) + '\n'
);

console.log(`Dialog trees: ${trees.length}`);
console.log(`Nodes/tree: 3 → total node lines: ${trees.length * 3}`);
console.log(`Cross-ref quest_id ↔ dialog_id: OK`);
console.log(`Summary: cmd-dialog/output/reports/dialog_tree_summary.json`);
