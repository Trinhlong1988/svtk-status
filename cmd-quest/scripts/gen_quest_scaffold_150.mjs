// CMD3 — Quest scaffold generator (Phase 14 Week 2)
// Target: 150 quest scaffold mới (extend 100 existing → 250 total)
// Cross-ref: cmd-npc/existing/NPC_438.jsonl
// Deterministic: seeded by quest_id

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const NPC_PATH = join(REPO, 'cmd-npc', 'existing', 'NPC_438.jsonl');
const OUT_DIR = join(REPO, 'cmd-quest', 'output', 'registry');
mkdirSync(OUT_DIR, { recursive: true });

const npcs = readFileSync(NPC_PATH, 'utf8').trim().split('\n').map(JSON.parse);
const givers = npcs.filter(n => n.can_give_quest === true);
const all_npc_ids = npcs.map(n => n._index);

// 8 sử Việt chains
const CHAINS = [
  { id: 'SVTK_CHAIN_HONG_BANG',    era: 'f1', name: 'Hồng Bàng — Khởi nguyên',         count: 18, level_range: [1, 15] },
  { id: 'SVTK_CHAIN_AU_LAC',       era: 'f1', name: 'Âu Lạc — Thục Phán',              count: 18, level_range: [10, 25] },
  { id: 'SVTK_CHAIN_BAC_THUOC',    era: 'g1', name: 'Bắc thuộc — Hai Bà Trưng',        count: 19, level_range: [20, 40] },
  { id: 'SVTK_CHAIN_NGO_DINH_LE',  era: 'g1', name: 'Ngô-Đinh-Tiền Lê',                count: 19, level_range: [35, 55] },
  { id: 'SVTK_CHAIN_LY',           era: 'g1', name: 'Lý — Đại Việt khai cơ',           count: 19, level_range: [50, 70] },
  { id: 'SVTK_CHAIN_TRAN',         era: 'g1', name: 'Trần — Ba lần đánh Mông Cổ',      count: 19, level_range: [60, 80] },
  { id: 'SVTK_CHAIN_LE_SO',        era: 'g1', name: 'Lê Sơ — Lam Sơn khởi nghĩa',      count: 19, level_range: [70, 90] },
  { id: 'SVTK_CHAIN_TAY_SON',      era: 'g1', name: 'Tây Sơn — Quang Trung đại phá',   count: 19, level_range: [80, 99] },
];
const TOTAL = CHAINS.reduce((s, c) => s + c.count, 0);
if (TOTAL !== 150) throw new Error(`Chain sum ${TOTAL} ≠ 150`);

// Deterministic PRNG (mulberry32)
function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const CATEGORIES = ['main', 'main', 'main', 'side', 'side', 'lore'];
const OBJECTIVE_TYPES = ['talk_to', 'kill_count', 'collect', 'deliver', 'escort', 'explore'];

function pickGiver(chain, idx) {
  const eraGivers = givers.filter(g => g.era === chain.era);
  const pool = eraGivers.length > 0 ? eraGivers : givers;
  return pool[idx % pool.length];
}

function buildQuest(seq, chain, posInChain) {
  const r = rng(seq * 1009);
  const giver = pickGiver(chain, posInChain);
  const cat = CATEGORIES[Math.floor(r() * CATEGORIES.length)];
  const objCount = 1 + Math.floor(r() * 3); // 1-3 obj
  const objectives = [];
  for (let i = 0; i < objCount; i++) {
    const type = OBJECTIVE_TYPES[Math.floor(r() * OBJECTIVE_TYPES.length)];
    const target = all_npc_ids[Math.floor(r() * all_npc_ids.length)];
    const o = { type, target_npc_id: target };
    if (type === 'kill_count' || type === 'collect') o.count = 3 + Math.floor(r() * 8);
    objectives.push(o);
  }
  // Level monotonic non-decreasing across chain: linear interpolate lo→hi by chain_position,
  // then add small upward-only jitter so consecutive quests can match but never invert.
  const [lo, hi] = chain.level_range;
  const span = chain.count > 1 ? (hi - lo) / (chain.count - 1) : 0;
  const baseLevel = lo + Math.round(span * posInChain);
  const jitter = Math.floor(r() * 2); // 0 or 1
  const levelReq = Math.min(hi, baseLevel + jitter);
  const expReward = 100 * levelReq + Math.floor(r() * 500);
  const goldReward = 50 * levelReq + Math.floor(r() * 200);
  const prerequisites = posInChain === 0
    ? []
    : [`SVTK_Q_${String(seq - 1).padStart(4, '0')}`];

  return {
    quest_id: `SVTK_Q_${String(seq).padStart(4, '0')}`,
    name: `${chain.name} — Hồi ${posInChain + 1}`,
    chain_id: chain.id,
    chain_position: posInChain,
    category: cat,
    era: chain.era,
    giver_npc_id: giver._index,
    giver_npc_name: giver.name,
    giver_scene_id: giver.sceneId,
    level_req: levelReq,
    prerequisites,
    objectives,
    rewards: { exp: expReward, gold: goldReward, items: [] },
    dialog_tree_ref: `DLG_${chain.id}_${posInChain}`,
    status: 'scaffold',
    schema_version: '1.0',
    generated_by: 'cmd-quest gen_quest_scaffold_150.mjs',
    generated_at: '2026-05-18T14:00:00Z',
  };
}

const out = [];
let seq = 101; // 100 existing in xlsx → start at 101
for (const chain of CHAINS) {
  let prevLevel = 0;
  for (let i = 0; i < chain.count; i++) {
    const q = buildQuest(seq++, chain, i);
    if (q.level_req < prevLevel) q.level_req = prevLevel; // monotonic non-decreasing
    prevLevel = q.level_req;
    out.push(q);
  }
}

const jsonl = out.map(q => JSON.stringify(q)).join('\n') + '\n';
writeFileSync(join(OUT_DIR, 'quest_full.jsonl'), jsonl);

// Per-category split
const byCat = { main: [], side: [], lore: [] };
for (const q of out) byCat[q.category].push(q);
for (const [cat, arr] of Object.entries(byCat)) {
  writeFileSync(
    join(OUT_DIR, `quest_${cat}.jsonl`),
    arr.map(q => JSON.stringify(q)).join('\n') + '\n'
  );
}

// Per-chain split
const byChain = {};
for (const q of out) (byChain[q.chain_id] = byChain[q.chain_id] || []).push(q);
mkdirSync(join(REPO, 'cmd-quest', 'output', 'chains'), { recursive: true });
for (const [cid, arr] of Object.entries(byChain)) {
  writeFileSync(
    join(REPO, 'cmd-quest', 'output', 'chains', `${cid}.jsonl`),
    arr.map(q => JSON.stringify(q)).join('\n') + '\n'
  );
}

// Cross-ref verify
const referencedGivers = new Set(out.map(q => q.giver_npc_id));
const referencedTargets = new Set(out.flatMap(q => q.objectives.map(o => o.target_npc_id)));
const npcIds = new Set(all_npc_ids);
const orphanGivers = [...referencedGivers].filter(id => !npcIds.has(id));
const orphanTargets = [...referencedTargets].filter(id => !npcIds.has(id));

console.log(`Total quests: ${out.length}`);
console.log(`By category: main=${byCat.main.length} side=${byCat.side.length} lore=${byCat.lore.length}`);
console.log(`By chain: ${Object.entries(byChain).map(([k, v]) => `${k}=${v.length}`).join(' ')}`);
console.log(`Referenced givers: ${referencedGivers.size}/${givers.length}`);
console.log(`Orphan givers: ${orphanGivers.length} | Orphan targets: ${orphanTargets.length}`);
if (orphanGivers.length || orphanTargets.length) {
  process.exit(1);
}
console.log('CROSS-REF OK');
