// R7 — fuzz quest generator with 10 different seeds, run all 13 rules per seed.
// Bug found if ANY seed produces ANY rule violation.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const NPC_PATH = join(REPO, 'cmd-npc', 'existing', 'NPC_438.jsonl');
const npcs = readFileSync(NPC_PATH, 'utf8').trim().split('\n').map(JSON.parse);
const givers = npcs.filter(n => n.can_give_quest === true);
const all_npc_ids = npcs.map(n => n._index);
const npcById = new Map(npcs.map(n => [n._index, n]));

const CHAINS = [
  { id: 'SVTK_CHAIN_HONG_BANG',    era: 'f1', name: 'Hồng Bàng',    count: 18, level_range: [1, 15] },
  { id: 'SVTK_CHAIN_AU_LAC',       era: 'f1', name: 'Âu Lạc',       count: 18, level_range: [10, 25] },
  { id: 'SVTK_CHAIN_BAC_THUOC',    era: 'g1', name: 'Bắc thuộc',    count: 19, level_range: [20, 40] },
  { id: 'SVTK_CHAIN_NGO_DINH_LE',  era: 'g1', name: 'Ngô-Đinh-Tiền Lê', count: 19, level_range: [35, 55] },
  { id: 'SVTK_CHAIN_LY',           era: 'g1', name: 'Lý',           count: 19, level_range: [50, 70] },
  { id: 'SVTK_CHAIN_TRAN',         era: 'g1', name: 'Trần',         count: 19, level_range: [60, 80] },
  { id: 'SVTK_CHAIN_LE_SO',        era: 'g1', name: 'Lê Sơ',        count: 19, level_range: [70, 90] },
  { id: 'SVTK_CHAIN_TAY_SON',      era: 'g1', name: 'Tây Sơn',      count: 19, level_range: [80, 99] },
];

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

function generate(seedBase) {
  const out = [];
  let seq = 101;
  for (const chain of CHAINS) {
    let prevLevel = 0;
    const eraGivers = givers.filter(g => g.era === chain.era);
    const pool = eraGivers.length > 0 ? eraGivers : givers;
    for (let i = 0; i < chain.count; i++) {
      const r = rng((seq + seedBase) * 1009);
      const giver = pool[i % pool.length];
      const cat = CATEGORIES[Math.floor(r() * CATEGORIES.length)];
      const objCount = 1 + Math.floor(r() * 3);
      const objectives = [];
      for (let j = 0; j < objCount; j++) {
        const type = OBJECTIVE_TYPES[Math.floor(r() * OBJECTIVE_TYPES.length)];
        const target = all_npc_ids[Math.floor(r() * all_npc_ids.length)];
        const o = { type, target_npc_id: target };
        if (type === 'kill_count' || type === 'collect') o.count = 3 + Math.floor(r() * 8);
        objectives.push(o);
      }
      const [lo, hi] = chain.level_range;
      const span = chain.count > 1 ? (hi - lo) / (chain.count - 1) : 0;
      const baseLevel = lo + Math.round(span * i);
      const jitter = Math.floor(r() * 2);
      let levelReq = Math.min(hi, baseLevel + jitter);
      if (levelReq < prevLevel) levelReq = prevLevel;
      prevLevel = levelReq;

      const expReward = 100 * levelReq + Math.floor(r() * 500);
      const goldReward = 50 * levelReq + Math.floor(r() * 200);
      const prerequisites = i === 0 ? [] : [`SVTK_Q_${String(seq - 1).padStart(4, '0')}`];
      out.push({
        quest_id: `SVTK_Q_${String(seq++).padStart(4, '0')}`,
        chain_id: chain.id, chain_position: i, era: chain.era,
        giver_npc_id: giver._index, level_req: levelReq,
        prerequisites, objectives,
        rewards: { exp: expReward, gold: goldReward, items: [] },
        dialog_tree_ref: `DLG_${chain.id}_${i}`,
      });
    }
  }
  return out;
}

function scan(out) {
  const byId = new Map(out.map(q => [q.quest_id, q]));
  const v = { B1: 0, B2: 0, B3: 0, B4: 0, B5: 0, B6: 0, B7: 0 };
  const ids = new Set();
  const drefs = new Set();
  for (const q of out) {
    if (q.chain_position === 0 && q.prerequisites.length > 0) v.B1++;
    if (q.chain_position > 0 && q.prerequisites.length === 0) v.B1++;
    for (const pre of q.prerequisites) {
      const pq = byId.get(pre);
      if (!pq) { v.B1++; continue; }
      if (pq.chain_id !== q.chain_id) v.B1++;
      if (pq.chain_position !== q.chain_position - 1) v.B1++;
      if (pq.level_req > q.level_req) v.B2++;
    }
    for (const o of q.objectives)
      if ((o.type === 'kill_count' || o.type === 'collect') && (o.count === undefined || o.count <= 0)) v.B4++;
    if (q.rewards.exp <= 0 || q.rewards.gold <= 0) v.B5++;
    if (q.rewards.exp > 1_000_000 || q.rewards.gold > 50_000) v.B5++;
    if (ids.has(q.quest_id)) v.B3++; ids.add(q.quest_id);
    if (drefs.has(q.dialog_tree_ref)) v.B6++; drefs.add(q.dialog_tree_ref);
    const n = npcById.get(q.giver_npc_id);
    if (!n || !n.can_give_quest) v.B7++;
  }
  return v;
}

const seeds = [0, 1, 7, 13, 42, 1337, 99991, 271828, 1414213, 31415926];
let totalViolations = 0;
for (const s of seeds) {
  const out = generate(s);
  const v = scan(out);
  const sum = Object.values(v).reduce((a, b) => a + b, 0);
  totalViolations += sum;
  console.log(`seed=${s.toString().padStart(9)} count=${out.length} violations=${sum} (${JSON.stringify(v)})`);
}
console.log(`\nTotal violations across 10 seeds × ${seeds.length * 150} quests = ${totalViolations}`);
process.exit(totalViolations > 0 ? 1 : 0);
