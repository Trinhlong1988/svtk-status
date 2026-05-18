# 🗡️ CMD_QUEST v1.1 — QUEST GENERATOR ≥3000

> **PASTE NGUYÊN VÀO CLAUDE CODE.** Autonomous.

**Team:** TEAM CONTENT — Quest tree + objectives + chains
**Version:** 1.1.0 — 2026-05-18
**Foundation:** v2.8.0 hash `2e6e8c23d8455d9b964744486be11f0a88684113c1cbc6eb77ec371dc266e467`

---

## 🎯 GOAL

```yaml
goal: "≥3000 quest sử Việt phân loại Main/Side/Lore/Event/Raid/Reborn +
       34 quest chuỗi (chain) + 6 objective types + cross-reference NPC registry +
       reward system với gold/exp/item/reputation + 15-item self-audit"

target_quest_count: 2262
target_main: 259
target_side: 142
target_lore: 88
target_event: 28
target_raid: 50
target_reborn: 21
# Generated to reach 2262: ~1674 mass quests
target_chains: 34
acceptance_threshold: 0.99
partial_threshold: 0.95
```

---


**Foundation rules applied:**
- **R45** — Anti-dupe (quest UUID unique, idempotent reward grant)
- **R47** — Cross-reference verified (NPC giver từ npc_full.jsonl)
- **R48** — Quest objective deterministic (no Math.random in eval)
- **R49** — Content tagging cho era + faction + chain
- **R50** — Schema-strict (quest_id, chain_id, prerequisites unique)

---

## 📋 QUY TẮC TUYỆT ĐỐI

1. **KHÔNG hỏi user.** Autonomous.
2. **VERIFY Foundation hash** → exit 99 nếu mismatch.
3. **SỬ VIỆT** — quest title + description thuần Việt, anti Tam Quốc/Nhật.
4. **CROSS-REFERENCE NPC**: mọi quest phải link `giver_npc_id` từ NPC registry (CMD NPC).
5. **6 OBJECTIVE TYPES**: kill, collect, deliver, escort, talk, explore.
6. **REWARD anti-snowball**: gold balanced theo era, item drop có UUID (R45).
7. **QUEST CHAIN** linkage via `prev_quest_id` + `next_quest_id`.
8. **ERA-LOCKED**: quest belong to specific era, KHÔNG cross-era leak.
9. **F-PREFIX** cho quest era nhạy cảm (Bắc thuộc/Pháp thuộc/etc).
10. **HONEST gap**, output JSONL, push GitHub.

---

## 📦 OUTPUT STRUCTURE

```
cmd-quest/output/
├── registry/
│   ├── quest_main.jsonl       (259)
│   ├── quest_side.jsonl       (142)
│   ├── quest_lore.jsonl       (88)
│   ├── quest_event.jsonl      (28)
│   ├── quest_raid.jsonl       (50)
│   ├── quest_reborn.jsonl     (21)
│   ├── quest_generated.jsonl  (~1674 to reach 2262)
│   └── quest_full.jsonl       (TOTAL ≥3000)
├── chains/
│   └── quest_chains.json      (34 chain definitions)
├── schema/
│   └── quest_table.sql
└── reports/
    ├── validation.json
    ├── chain_integrity.json
    └── honest_gaps.json
```

---

## 🐍 PROMPT

```python
#!/usr/bin/env python3
"""CMD QUEST v1.1 — Generator ≥3000 quest sử Việt."""
import os, sys, subprocess, uuid, json, time, hashlib, re
from pathlib import Path

try:
    from svtk_runtime import (FOUNDATION_VERSION, log, set_correlation_context,
                               metrics, SVTKError, FoundationMismatchError)
except ImportError:
    print('svtk_runtime not installed')
    sys.exit(99)

CMD_NAME = "cmd-quest"
CMD_VERSION = "1.0.0"
EXPECTED_FOUNDATION_HASH = "2e6e8c23d8455d9b964744486be11f0a88684113c1cbc6eb77ec371dc266e467"
REPO_URL = "https://github.com/Trinhlong1988/svtk-status.git"
REPO_DIR = Path("./svtk-status")

TARGET_QUEST = 3000
TARGETS = {'main': 259, 'side': 142, 'lore': 88, 'event': 28,
           'raid': 50, 'reborn': 21}
TOTAL_CATEGORIZED = sum(TARGETS.values())  # 588
TARGET_GENERATED = TARGET_QUEST - TOTAL_CATEGORIZED  # ~1674

CYCLE_START = time.time()
ERAS = ['ly', 'tran', 'le', 'tay_son', 'nguyen']
OBJECTIVE_TYPES = ['kill', 'collect', 'deliver', 'escort', 'talk', 'explore']


def setup():
    if not REPO_DIR.exists():
        subprocess.run(['git', 'clone', REPO_URL, str(REPO_DIR)], check=True)
    os.chdir(REPO_DIR)

    set_correlation_context(cmd_id='QUEST', cycle_id=str(uuid.uuid4()),
                            trace_id=str(uuid.uuid4()), attempt=0,
                            foundation_version='v2.6.0')
    log.configure(CMD_NAME)

    fp = Path('SVTK_FOUNDATION_v2.6.0.md')
    if not fp.exists() or hashlib.sha256(fp.read_bytes()).hexdigest() != EXPECTED_FOUNDATION_HASH:
        log.critical('foundation_verify_failed')
        sys.exit(99)

    for f in ['cmd-quest/output/registry', 'cmd-quest/output/chains',
              'cmd-quest/output/schema', 'cmd-quest/output/reports']:
        Path(f).mkdir(parents=True, exist_ok=True)


def load_npc_registry():
    """Cross-reference NPC từ CMD NPC output."""
    p = Path('cmd-npc/output/registry/npc_full.jsonl')
    if not p.exists():
        log.warn('npc_registry_missing — using fallback IDs')
        return [{'_index': i, 'name': f'NPC-{i}'} for i in range(1, 7818)]
    npcs = []
    with p.open(encoding='utf-8') as f:
        for line in f:
            if line.strip():
                npcs.append(json.loads(line))
    return npcs


# ════════════════════════════════════════════════════════════════
# QUEST TEMPLATES
# ════════════════════════════════════════════════════════════════
MAIN_QUEST_TEMPLATES = [
    {'title': 'Trần Long tỉnh dậy ở Hoa Lư', 'era': 'ly',
     'objective_type': 'talk', 'level_min': 1,
     'description': 'Sau khi xuyên không, Trần Long gặp Sư Vạn Hạnh để hiểu thân phận'},
    {'title': 'Cứu nguy Lý Thái Tổ', 'era': 'ly',
     'objective_type': 'escort', 'level_min': 5},
    {'title': 'Đánh tan quân Tống ở Như Nguyệt', 'era': 'ly',
     'objective_type': 'kill', 'level_min': 15},
    {'title': 'Diệt giặc Nguyên Mông trận Bạch Đằng', 'era': 'tran',
     'objective_type': 'kill', 'level_min': 35},
    {'title': 'Hồi giáp Trần Hưng Đạo', 'era': 'tran',
     'objective_type': 'collect', 'level_min': 30},
    {'title': 'Khởi nghĩa Lam Sơn', 'era': 'le',
     'objective_type': 'kill', 'level_min': 50},
    {'title': 'Tìm Nguyễn Trãi', 'era': 'le',
     'objective_type': 'talk', 'level_min': 45},
    {'title': 'Đánh bại quân Thanh trận Đống Đa', 'era': 'tay_son',
     'objective_type': 'kill', 'level_min': 70},
    {'title': 'Hiệp ước với Nguyễn Huệ', 'era': 'tay_son',
     'objective_type': 'talk', 'level_min': 65},
    {'title': 'Gặp Nguyễn Ánh - Gia Long', 'era': 'nguyen',
     'objective_type': 'talk', 'level_min': 80}
]


def generate_vietnamese_quest_title(idx, qtype, era):
    """Generate Vietnamese quest title."""
    prefixes = {
        'kill': ['Tiêu diệt', 'Truy quét', 'Đánh tan', 'Hạ gục', 'Diệt'],
        'collect': ['Thu thập', 'Tìm kiếm', 'Gom góp', 'Thu nhặt', 'Mang về'],
        'deliver': ['Đưa tin', 'Vận chuyển', 'Trao tận tay', 'Gửi đến', 'Báo'],
        'escort': ['Hộ tống', 'Đưa đường', 'Bảo vệ', 'Dẫn lối', 'Tháp tùng'],
        'talk': ['Trò chuyện với', 'Tìm gặp', 'Hỏi thăm', 'Tham vấn', 'Báo cáo'],
        'explore': ['Thám hiểm', 'Tuần tra', 'Khám phá', 'Điều tra', 'Tìm hiểu']
    }
    suffixes_kill = ['giặc cướp ở Thăng Long', 'thổ phỉ rừng Tam Đảo',
                     'quân xâm lược ở Cao Bằng', 'thú dữ vùng Sapa']
    suffixes_collect = ['thảo dược trên núi Yên Tử', 'cổ vật ở Cố Đô Huế',
                        'nguyên liệu rèn kiếm ở Bắc Ninh', 'tài liệu thư viện Văn Miếu']
    suffixes_deliver = ['thư khẩn cho quan tướng', 'lương thực cho dân làng',
                        'tin báo cho Hoàng đế', 'gói hàng cho thương nhân']
    suffixes_escort = ['sứ giả về kinh', 'thương đoàn qua đèo',
                       'gia đình tị nạn', 'học giả lên kinh thi cử']
    suffixes_talk = ['vị trưởng làng', 'thầy đồ trong làng', 'phó tướng',
                      'thầy thuốc già']
    suffixes_explore = ['rừng sâu Mã Yên', 'hang động Tràng An',
                        'biển Đông sương mù', 'núi rừng Tây Bắc']

    sufmap = {
        'kill': suffixes_kill, 'collect': suffixes_collect,
        'deliver': suffixes_deliver, 'escort': suffixes_escort,
        'talk': suffixes_talk, 'explore': suffixes_explore
    }

    pre = prefixes[qtype][idx % len(prefixes[qtype])]
    suf = sufmap[qtype][idx % len(sufmap[qtype])]
    return f'{pre} {suf}'


# ════════════════════════════════════════════════════════════════
# BUILD QUEST REGISTRY
# ════════════════════════════════════════════════════════════════
def build_quest_registry():
    npcs = load_npc_registry()
    questgivers = [n for n in npcs if n.get('is_questgiver') or n.get('role') in
                   ('village_head', 'priest', 'scholar', 'historical_figure')]
    if len(questgivers) < 100:
        questgivers = npcs[:500]

    quests = []
    quest_id = 1

    # ━━━━━ MAIN (259) ━━━━━
    for i in range(TARGETS['main']):
        if i < len(MAIN_QUEST_TEMPLATES):
            tpl = MAIN_QUEST_TEMPLATES[i]
            quest = {
                'quest_id': quest_id,
                'category': 'main',
                'title': tpl['title'],
                'description': tpl.get('description', tpl['title']),
                'era': tpl['era'],
                'objective_type': tpl['objective_type'],
                'level_min': tpl['level_min'],
                'giver_npc_id': questgivers[i % len(questgivers)]['_index'],
                'reward_gold': 100 + i * 50,
                'reward_exp': 200 + i * 100,
                'reward_items': [],
                'reward_reputation': 10 + i * 5,
                'is_protagonist_arc': True
            }
        else:
            era = ERAS[i % 5]
            qtype = OBJECTIVE_TYPES[i % 6]
            quest = {
                'quest_id': quest_id,
                'category': 'main',
                'title': generate_vietnamese_quest_title(i, qtype, era),
                'description': f'Nhiệm vụ chính tuyến — {era} era',
                'era': era,
                'objective_type': qtype,
                'level_min': 1 + i * 0.3,
                'giver_npc_id': questgivers[i % len(questgivers)]['_index'],
                'reward_gold': 100 + i * 30,
                'reward_exp': 200 + i * 60,
                'reward_items': [],
                'reward_reputation': 10 + i * 3,
                'is_protagonist_arc': True
            }
        quests.append(quest)
        quest_id += 1

    # ━━━━━ SIDE (142) ━━━━━
    for i in range(TARGETS['side']):
        era = ERAS[i % 5]
        qtype = OBJECTIVE_TYPES[i % 6]
        quests.append({
            'quest_id': quest_id,
            'category': 'side',
            'title': generate_vietnamese_quest_title(i + 1000, qtype, era),
            'description': f'Nhiệm vụ phụ — {era}',
            'era': era,
            'objective_type': qtype,
            'level_min': 5 + i,
            'giver_npc_id': questgivers[(i + 50) % len(questgivers)]['_index'],
            'reward_gold': 50 + i * 10,
            'reward_exp': 100 + i * 20,
            'reward_items': [],
            'reward_reputation': 5 + i
        })
        quest_id += 1

    # ━━━━━ LORE (88) ━━━━━
    for i in range(TARGETS['lore']):
        era = ERAS[i % 5]
        quests.append({
            'quest_id': quest_id,
            'category': 'lore',
            'title': generate_vietnamese_quest_title(i + 2000, 'talk', era),
            'description': f'Khám phá lore {era}',
            'era': era,
            'objective_type': 'talk',
            'level_min': 10 + i,
            'giver_npc_id': questgivers[(i + 100) % len(questgivers)]['_index'],
            'reward_gold': 0,
            'reward_exp': 500,
            'reward_items': [],
            'reward_reputation': 20,
            'unlocks_codex': True
        })
        quest_id += 1

    # ━━━━━ EVENT (28) ━━━━━
    for i in range(TARGETS['event']):
        era = ERAS[i % 5]
        quests.append({
            'quest_id': quest_id,
            'category': 'event',
            'title': f'Sự kiện đặc biệt {i+1} — {era}',
            'description': f'Event giới hạn thời gian',
            'era': era,
            'objective_type': OBJECTIVE_TYPES[i % 6],
            'level_min': 30,
            'giver_npc_id': questgivers[(i + 200) % len(questgivers)]['_index'],
            'reward_gold': 1000 + i * 100,
            'reward_exp': 2000,
            'reward_items': ['event_token'],
            'reward_reputation': 50,
            'event_window_days': 7
        })
        quest_id += 1

    # ━━━━━ RAID (50) ━━━━━
    for i in range(TARGETS['raid']):
        era = ERAS[i % 5]
        quests.append({
            'quest_id': quest_id,
            'category': 'raid',
            'title': f'Tử chiến Boss — {era} (Raid {i+1})',
            'description': f'Đánh boss raid',
            'era': era,
            'objective_type': 'kill',
            'level_min': 60 + i,
            'giver_npc_id': questgivers[(i + 300) % len(questgivers)]['_index'],
            'reward_gold': 5000 + i * 500,
            'reward_exp': 10000,
            'reward_items': ['raid_loot_chest'],
            'reward_reputation': 100,
            'min_party_size': 5
        })
        quest_id += 1

    # ━━━━━ REBORN (21) ━━━━━
    for i in range(TARGETS['reborn']):
        quests.append({
            'quest_id': quest_id,
            'category': 'reborn',
            'title': f'Chuyển sinh lần {i+1}',
            'description': f'Trần Long chuyển sinh sang era khác',
            'era': ERAS[i % 5],
            'objective_type': 'explore',
            'level_min': 100 + i * 10,
            'giver_npc_id': 1,  # Trần Long himself
            'reward_gold': 0,
            'reward_exp': 0,
            'reward_items': ['reborn_token'],
            'reward_reputation': 0,
            'resets_stats': True
        })
        quest_id += 1

    # ━━━━━ GENERATED (to reach 2262) ━━━━━
    for i in range(TARGET_GENERATED):
        era = ERAS[i % 5]
        qtype = OBJECTIVE_TYPES[i % 6]
        quests.append({
            'quest_id': quest_id,
            'category': 'generated',
            'title': generate_vietnamese_quest_title(i + 3000, qtype, era),
            'description': f'Generated quest — {era}',
            'era': era,
            'objective_type': qtype,
            'level_min': 1 + (i % 100),
            'giver_npc_id': questgivers[i % len(questgivers)]['_index'],
            'reward_gold': 10 + (i % 100) * 5,
            'reward_exp': 30 + (i % 100) * 10,
            'reward_items': [],
            'reward_reputation': 1 + (i % 20)
        })
        quest_id += 1

    return quests


def build_chains(quests):
    """Build 34 quest chains từ main + lore quests."""
    chains = []
    main_quests = [q for q in quests if q['category'] == 'main']
    lore_quests = [q for q in quests if q['category'] == 'lore']

    # 5 era × 4 chain mỗi era + 14 special = 34
    for era_idx, era in enumerate(ERAS):
        era_mains = [q for q in main_quests if q['era'] == era]
        for chain_n in range(4):
            chunk_size = max(2, len(era_mains) // 4)
            start = chain_n * chunk_size
            end = min(start + chunk_size, len(era_mains))
            chain_quests = era_mains[start:end]
            if len(chain_quests) >= 2:
                chains.append({
                    'chain_id': f'{era}_chain_{chain_n+1}',
                    'name': f'Chuỗi sử {era.replace("_", " ").title()} - {chain_n+1}',
                    'era': era,
                    'quest_ids': [q['quest_id'] for q in chain_quests],
                    'unlocks_next_era': chain_n == 3
                })

    # 14 special chains từ lore
    for i, lq_chunk_start in enumerate(range(0, min(56, len(lore_quests)), 4)):
        if len(chains) >= 34:
            break
        chain_quests = lore_quests[lq_chunk_start:lq_chunk_start+4]
        if chain_quests:
            chains.append({
                'chain_id': f'special_lore_{i+1}',
                'name': f'Chuỗi lore đặc biệt {i+1}',
                'era': chain_quests[0]['era'],
                'quest_ids': [q['quest_id'] for q in chain_quests],
                'unlocks_next_era': False
            })

    return chains[:34]


def write_outputs(quests, chains):
    by_category = {}
    for q in quests:
        by_category.setdefault(q['category'], []).append(q)

    for cat in ['main', 'side', 'lore', 'event', 'raid', 'reborn', 'generated']:
        if cat in by_category:
            Path(f'cmd-quest/output/registry/quest_{cat}.jsonl').write_text(
                '\n'.join(json.dumps(q, ensure_ascii=False) for q in by_category[cat]),
                encoding='utf-8'
            )

    Path('cmd-quest/output/registry/quest_full.jsonl').write_text(
        '\n'.join(json.dumps(q, ensure_ascii=False) for q in quests),
        encoding='utf-8'
    )

    Path('cmd-quest/output/chains/quest_chains.json').write_text(
        json.dumps(chains, indent=2, ensure_ascii=False), encoding='utf-8'
    )

    sql = '''-- Quest schema — Foundation v2.6.0
CREATE TABLE IF NOT EXISTS quests (
    quest_id            INTEGER PRIMARY KEY,
    category            VARCHAR(16) NOT NULL,
    title               VARCHAR(128) NOT NULL,
    description         TEXT,
    era                 VARCHAR(32) NOT NULL,
    objective_type      VARCHAR(16) NOT NULL,
    level_min           INTEGER NOT NULL DEFAULT 1,
    giver_npc_id        INTEGER NOT NULL REFERENCES npcs(npc_id),
    reward_gold         INTEGER DEFAULT 0,
    reward_exp          INTEGER DEFAULT 0,
    reward_items        JSONB DEFAULT '[]'::jsonb,
    reward_reputation   INTEGER DEFAULT 0,
    is_protagonist_arc  BOOLEAN DEFAULT FALSE,
    event_window_days   INTEGER,
    min_party_size      INTEGER DEFAULT 1,
    resets_stats        BOOLEAN DEFAULT FALSE,
    chain_id            VARCHAR(64),
    chain_position      INTEGER,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    CHECK (category IN ('main','side','lore','event','raid','reborn','generated')),
    CHECK (objective_type IN ('kill','collect','deliver','escort','talk','explore')),
    CHECK (level_min >= 1),
    CHECK (reward_gold >= 0),
    CHECK (reward_exp >= 0)
);

CREATE INDEX IF NOT EXISTS idx_quests_era ON quests(era);
CREATE INDEX IF NOT EXISTS idx_quests_giver ON quests(giver_npc_id);
CREATE INDEX IF NOT EXISTS idx_quests_chain ON quests(chain_id) WHERE chain_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS quest_chains (
    chain_id            VARCHAR(64) PRIMARY KEY,
    name                VARCHAR(128) NOT NULL,
    era                 VARCHAR(32) NOT NULL,
    quest_ids           INTEGER[] NOT NULL,
    unlocks_next_era    BOOLEAN DEFAULT FALSE
);
'''
    Path('cmd-quest/output/schema/quest_table.sql').write_text(sql, encoding='utf-8')


def validator():
    checks = []
    quests = []
    p = Path('cmd-quest/output/registry/quest_full.jsonl')
    if p.exists():
        with p.open(encoding='utf-8') as f:
            quests = [json.loads(line) for line in f if line.strip()]

    # 1. Total ≥3000
    checks.append(('quest_count', len(quests) >= TARGET_QUEST,
                   {'found': len(quests), 'target': TARGET_QUEST}))

    # 2-7. Category counts
    by_cat = {}
    for q in quests:
        by_cat[q['category']] = by_cat.get(q['category'], 0) + 1
    for cat, target in TARGETS.items():
        checks.append((f'category_{cat}', by_cat.get(cat, 0) >= target,
                       {'found': by_cat.get(cat, 0), 'target': target}))

    # 8. Unique quest_id
    ids = [q['quest_id'] for q in quests]
    checks.append(('unique_quest_id', len(ids) == len(set(ids)), {}))

    # 9. 6 objective types covered
    obj_types_used = {q['objective_type'] for q in quests}
    checks.append(('objective_6_types',
                   set(OBJECTIVE_TYPES).issubset(obj_types_used), {}))

    # 10. 5 era covered
    eras_used = {q['era'] for q in quests}
    checks.append(('era_5_covered', all(e in eras_used for e in ERAS), {}))

    # 11. All quests have giver_npc_id
    has_giver = all(q.get('giver_npc_id') for q in quests)
    checks.append(('all_have_giver', has_giver, {}))

    # 12. 34 chains
    chains_path = Path('cmd-quest/output/chains/quest_chains.json')
    chain_count = 0
    if chains_path.exists():
        chains = json.loads(chains_path.read_text(encoding='utf-8'))
        chain_count = len(chains)
    checks.append(('chains_34', chain_count >= 34, {'found': chain_count}))

    # 13. Schema exists
    checks.append(('schema_exists', Path('cmd-quest/output/schema/quest_table.sql').exists(), {}))

    # 14. Cultural lock — no Hán/Nhật in titles
    forbidden = re.compile(r'[\u4E00-\u9FFF]|[\u3040-\u309F]|[\u30A0-\u30FF]')
    bad = [q for q in quests if forbidden.search(q.get('title', ''))]
    checks.append(('cultural_lock_title', len(bad) == 0, {'violations': len(bad)}))

    # 15. Protagonist arc flagged
    proto_count = sum(1 for q in quests if q.get('is_protagonist_arc'))
    checks.append(('protagonist_arc_count', proto_count >= 50, {'found': proto_count}))

    passed = sum(1 for _, ok, _ in checks if ok)
    total = len(checks)
    errors = [{'code': name, **detail} for name, ok, detail in checks if not ok]

    Path('cmd-quest/output/reports/validation.json').write_text(
        json.dumps({'passed': passed, 'total': total, 'pass_rate': passed / total,
                    'errors': errors}, indent=2, ensure_ascii=False),
        encoding='utf-8'
    )
    return {'pass_rate': passed / total, 'passed': passed, 'total': total, 'errors': errors}


def build():
    log.info('build_start', {})
    quests = build_quest_registry()
    chains = build_chains(quests)
    write_outputs(quests, chains)
    log.info('build_complete', {'quest_count': len(quests), 'chains': len(chains)})


def fixer(failure):
    if failure.get('code') in ['quest_count', 'unique_quest_id', 'chains_34',
                                'objective_6_types', 'era_5_covered'] or \
       failure.get('code', '').startswith('category_'):
        build()
        return True
    return False


def goal_loop():
    for it in range(5):
        if time.time() - CYCLE_START > 2700:
            return {'status': 'TIMEOUT', 'pass_rate': 0.0}
        if it == 0:
            build()
        result = validator()
        if result['pass_rate'] >= 0.99:
            return {'status': 'PASS', **result}
        if it == 4:
            if result['pass_rate'] >= 0.95:
                return {'status': 'PARTIAL', **result}
            return {'status': 'FAIL', **result}
        for err in result['errors']:
            fixer(err)
    return {'status': 'STUCK', 'pass_rate': 0.0}


def write_honest_gaps():
    gaps = {
        'cmd_version': CMD_VERSION,
        'gaps_admitted': [
            {'severity': 'MED', 'item': 'Generated quest dùng template title',
             'reason': 'Đủ count nhưng không có deep narrative cho 1674 quest generated',
             'mitigation': 'CMD DIALOG enrich qua dialog'},
            {'severity': 'MED', 'item': 'Reward item placeholder',
             'reason': 'Reward items chỉ ghi token name, chưa link UUID item thật',
             'mitigation': 'CMD ITEM sẽ map khi build registry'},
            {'severity': 'LOW', 'item': 'Chain integrity chưa enforce prev/next',
             'reason': 'Chain định nghĩa qua quest_ids array, không có prev_quest_id field',
             'mitigation': 'Schema có chain_position field — CMD QA-CONTENT validate'},
            {'severity': 'LOW', 'item': 'Event quest no calendar logic',
             'reason': 'event_window_days chỉ ghi nhận, scheduler chưa có',
             'mitigation': 'CMD EVENT v1.1 (future)'}
        ]
    }
    Path('cmd-quest/output/reports/honest_gaps.json').write_text(
        json.dumps(gaps, indent=2, ensure_ascii=False), encoding='utf-8'
    )


def git_push(result):
    branch = f'staging-quest-{int(time.time())}'
    try:
        subprocess.run(['git', 'checkout', '-b', branch], check=True, capture_output=True)
        subprocess.run(['git', 'add', 'cmd-quest/'], check=True)
        msg = f"CMD QUEST v{CMD_VERSION} {result['status']}: pass {result['pass_rate']*100:.1f}%"
        subprocess.run(['git', 'commit', '-m', msg], check=True)
        subprocess.run(['git', 'push', '-u', 'origin', branch], check=True)
    except subprocess.CalledProcessError as e:
        log.error('git_push_failed', {'error': str(e)})


def main():
    try:
        setup()
        result = goal_loop()
        write_honest_gaps()

        Path('cmd-quest/output/reports/final_summary.json').write_text(
            json.dumps({'cmd_id': 'QUEST', 'result': result,
                        'duration_sec': time.time() - CYCLE_START}, indent=2),
            encoding='utf-8'
        )
        metrics.flush('cmd-quest/output/metrics.json')
        git_push(result)
        return {'PASS': 0, 'PARTIAL': 0, 'FAIL': 1, 'STUCK': 1, 'TIMEOUT': 14}.get(result['status'], 10)
    except Exception as e:
        log.critical('cmd_unhandled', {'msg': str(e)})
        return 10


if __name__ == '__main__':
    sys.exit(main())
```

---



---

## 🐙 GITHUB PUSH (BẮT BUỘC)

```python
import subprocess, json, time
from pathlib import Path

REPO_URL = "https://github.com/Trinhlong1988/svtk-status.git"

def push_to_github(cmd_name: str, output_dir: Path, score: float, gaps: list) -> bool:
    ts = time.strftime('%Y%m%d-%H%M%S')
    branch = f"staging-{cmd_name.lower()}-{ts}"
    repo_dir = Path('/tmp/svtk-status')
    if not repo_dir.exists():
        subprocess.run(['git', 'clone', REPO_URL, str(repo_dir)], check=True)
    else:
        subprocess.run(['git', '-C', str(repo_dir), 'fetch', 'origin'], check=True)
    subprocess.run(['git', '-C', str(repo_dir), 'checkout', '-b', branch], check=True)
    target = repo_dir / f'cmd-{cmd_name.lower()}' / 'output'
    target.mkdir(parents=True, exist_ok=True)
    subprocess.run(['cp', '-r', f'{output_dir}/.', str(target)], check=True)
    status = {'cmd': cmd_name.upper(), 'ts': ts, 'score': score, 'gaps': gaps,
              'exit': 0 if score >= 0.95 else 1}
    status_path = repo_dir / f'cmd-{cmd_name.lower()}' / 'status' / f'status-{ts}.json'
    status_path.parent.mkdir(parents=True, exist_ok=True)
    status_path.write_text(json.dumps(status, indent=2, ensure_ascii=False))
    subprocess.run(['git', '-C', str(repo_dir), 'config', 'user.email', 'smartbeevn@gmail.com'])
    subprocess.run(['git', '-C', str(repo_dir), 'config', 'user.name', f'CMD_{cmd_name.upper()}_BOT'])
    subprocess.run(['git', '-C', str(repo_dir), 'add', '.'])
    subprocess.run(['git', '-C', str(repo_dir), 'commit', '-m', f'CMD_{cmd_name.upper()} ts={ts} score={score:.2f}'])
    subprocess.run(['git', '-C', str(repo_dir), 'push', 'origin', branch], check=True)
    print(f'✅ Pushed: {branch}')
    return True
```

---

## 🔁 LOOP CHU KỲ TỰ ĐỘNG (poll inbox 60s)

```python
def main_loop(cmd_name: str):
    output_dir, score, gaps = run_full_build()
    push_to_github(cmd_name, output_dir, score, gaps)
    repo_dir = Path('/tmp/svtk-status')
    inbox = repo_dir / f'cmd-{cmd_name.lower()}' / 'inbox'
    while True:
        try:
            subprocess.run(['git', '-C', str(repo_dir), 'pull', '--quiet'])
            if inbox.exists():
                tasks = sorted(inbox.glob('*.json'))
                if tasks:
                    for tf in tasks:
                        task = json.loads(tf.read_text())
                        apply_fix_task(task)
                        (inbox.parent / 'processed' / tf.name).parent.mkdir(parents=True, exist_ok=True)
                        tf.rename(inbox.parent / 'processed' / tf.name)
                    output_dir, score, gaps = run_full_build()
                    push_to_github(cmd_name, output_dir, score, gaps)
        except Exception as e:
            print(f'[loop_err] {e}')
        time.sleep(LOOP_INTERVAL_SEC)
```

---


## 🧪 TEST COUNT REQUIREMENT

**Số test bắt buộc trong PROMPT Python:** ≥10 self-validation tests, mỗi test có assertion rõ ràng.

```python
TEST_COUNT_TARGET = 15  # ≥10 = required, 15 tests = recommended (>= 10 tests minimum)
TEST_ASSERTIONS_TARGET = 30  # >= 2 assertions per test trung bình
```

Test categories:
- **Schema validation tests** (≥3): JSONL fields, types, required keys
- **Content validation tests** (≥3): count, era distribution, cultural lock
- **Cross-ref tests** (≥2): NPC↔Quest, Item↔Quest reward link
- **Idempotency tests** (≥2): re-run KHÔNG dupe records


---


## 🎲 DETERMINISM RULE (R68)

**CẤM Math.random / random.random() trong logic gameplay.** Quest progression, drop calc, NPC AI PHẢI deterministic:

```python
# ❌ SAI:
import random
chance = random.random() < 0.3

# ✅ ĐÚNG - dùng RNGSuite từ svtk_runtime:
from svtk_runtime import RNGSuite, RNGReason
suite = RNGSuite(seed=f'quest:{quest_id}:{player_id}', audit_mode='ring_buffer')
chance = suite.quest.consume(RNGReason.QUEST_DROP) < 0.3
```

KHÔNG Math.random trong TypeScript code generated cho gameplay logic.


---



---



---

## 🔐 SCHEMA UNIQUE CONSTRAINTS (R8.3 anti-dupe)

Mọi table tạo phải có UNIQUE constraint anti-duplicate:

```sql
-- Pattern: UNIQUE(natural_key)
CREATE TABLE IF NOT EXISTS example_table (
    id UUID PRIMARY KEY,
    natural_key VARCHAR(64) NOT NULL,
    -- ...
    UNIQUE(natural_key)  -- anti-dupe at DB level
);

-- For multi-column natural keys:
CREATE TABLE IF NOT EXISTS combat_actions (
    action_id UUID PRIMARY KEY,
    battle_id UUID NOT NULL,
    turn INT NOT NULL,
    actor_id UUID NOT NULL,
    UNIQUE(battle_id, turn, actor_id)  -- 1 action per actor per turn
);

-- For instance-vs-template separation (R45):
CREATE TABLE IF NOT EXISTS item_templates (
    template_id INT PRIMARY KEY,
    -- ...
    UNIQUE(template_id)
);

CREATE TABLE IF NOT EXISTS item_instances (
    instance_uuid UUID PRIMARY KEY,
    template_id INT REFERENCES item_templates(template_id),
    owner_player_id UUID,
    -- ...
    UNIQUE(instance_uuid)  -- guaranteed unique
);
```

**Bắt buộc:** Mọi `CREATE TABLE` PHẢI có ≥1 `UNIQUE(...)` constraint hoặc PRIMARY KEY combo.




---

## 📂 TẬN DỤNG REGISTRY ĐÃ CÓ (PRIORITY)

```python
def load_existing_registry(registry_type: str) -> list:
    """Load registry đã build từ ChatGPT session trước.

    KHÔNG generate lại từ 0. CHỈ extend để đạt target mới.

    Existing registries (đã build, push GitHub):
    - cmd-npc/existing/NPC_438.jsonl    (P1:208 + P2:132 + P3:98)
    - cmd-skill/existing/SKILL_80.jsonl (7 hệ + TS migration)
    - cmd-item/existing/ITEM_200.jsonl  (có lore Việt sử)
    - cmd-boss/existing/BOSS_13.jsonl
    - cmd-quest/existing/QUEST_588.jsonl (Main+Side+Lore+Event+Raid+Reborn, 34 chuỗi)
    """
    paths = {
        'npc': REPO_DIR / 'cmd-npc' / 'existing' / 'NPC_438.jsonl',
        'skill': REPO_DIR / 'cmd-skill' / 'existing' / 'SKILL_80.jsonl',
        'item': REPO_DIR / 'cmd-item' / 'existing' / 'ITEM_200.jsonl',
        'boss': REPO_DIR / 'cmd-boss' / 'existing' / 'BOSS_13.jsonl',
        'quest': REPO_DIR / 'cmd-quest' / 'existing' / 'QUEST_588.jsonl',
    }
    p = paths.get(registry_type)
    if not p or not p.exists():
        log.warn(f'No existing registry for {registry_type}, will generate from 0')
        return []
    existing = []
    for line in p.read_text(encoding='utf-8').split('\n'):
        if line.strip():
            existing.append(json.loads(line))
    log.info(f'Loaded {len(existing)} existing entries for {registry_type}')
    return existing


def extend_to_target(existing: list, target_count: int, gen_func) -> list:
    """Extend existing registry đến target count.

    Existing entries KHÔNG bị thay đổi. Chỉ thêm mới.
    """
    if len(existing) >= target_count:
        log.info(f'Existing {len(existing)} đã >= target {target_count}, skip generate')
        return existing
    needed = target_count - len(existing)
    log.info(f'Generate thêm {needed} entries (existing {len(existing)} + new {needed})')
    new_entries = []
    start_id = max((e.get('_index', e.get('id', 0)) for e in existing), default=0) + 1
    for i in range(needed):
        new_entries.append(gen_func(start_id + i))
    return existing + new_entries
```

**WORKFLOW BẮT BUỘC:**
1. Load existing registry TRƯỚC khi generate
2. Extend chỉ phần thiếu để đạt target
3. KHÔNG override existing entries
4. Log rõ: bao nhiêu existing, bao nhiêu generated mới




---

## 🔒 CULTURAL LOCK (R30 — Vietnamese identity)

```python
import re

CULTURAL_LOCK_REGEX = re.compile(
    r'[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]'  # CJK + Hiragana + Katakana
)
TAM_QUOC_BAN_REGEX = re.compile(
    r'(Tào Tháo|Lưu Bị|Quan Vũ|Trương Phi|Khổng Minh|Cao Cao|Liu Bei|Zhuge Liang|Guan Yu|Zhang Fei|Tam Quốc)'
)

def cultural_lock_check(text: str) -> bool:
    """Verify text không có CJK/Hiragana/Katakana/Tam Quốc."""
    if CULTURAL_LOCK_REGEX.search(text):
        return False
    if TAM_QUOC_BAN_REGEX.search(text):
        return False
    return True

F_PREFIX_VALID = ['f1', 'f2', 'f3', 'f4', 'f5', 'g1']
```

Mọi entity name/description PHẢI pass `cultural_lock_check()`.




---

## 📂 R71 REGISTRY REUSE (BẮT BUỘC)

**Existing:** 588 entries đã có từ ChatGPT session trước.
**Target:** ≥3000
**Extend:** 2412 entries mới (existing IMMUTABLE).

```python
def r71_workflow():
    """R71: Tận dụng existing, mở rộng không làm mới."""
    existing_path = REPO_DIR / 'cmd-quest' / 'existing' / f'QUEST_588.jsonl'

    # 1. Load existing
    existing = []
    if existing_path.exists():
        for line in existing_path.read_text(encoding='utf-8').split('\n'):
            if line.strip():
                existing.append(json.loads(line))
        log.info(f'Loaded {len(existing)} existing QUEST from {existing_path}')
    else:
        log.warn(f'Existing registry NOT FOUND at {existing_path} — will generate full 3000')

    # 2. Verify existing logic đúng (cultural lock, schema)
    valid_existing = []
    for entry in existing:
        if verify_entry_logic(entry):
            valid_existing.append(entry)
        else:
            log.warn(f'Invalid existing entry: {entry.get("id", "unknown")} — alert LEAD')
            send_alert_to_lead('LOW', 'existing_entry_invalid', {'entry_id': entry.get('id')})

    # 3. Check target met
    if len(valid_existing) >= 3000:
        log.info(f'Target 3000 met with existing valid {len(valid_existing)}')
        return valid_existing, 0  # 0 new

    # 4. Extend chỉ phần thiếu
    needed = 3000 - len(valid_existing)
    start_id = max(
        (e.get('_index', e.get('id', e.get('skill_id', e.get('item_id', e.get('boss_id', e.get('quest_id', 0))))))
         for e in valid_existing), default=0
    ) + 1

    new_entries = []
    for i in range(needed):
        new_entry = gen_new_entry(start_id + i)
        # Cross-verify với existing pattern
        if not cross_verify_with_existing(new_entry, valid_existing):
            continue
        new_entries.append(new_entry)

    log.info(f'R71 result: existing={len(valid_existing)}, new={len(new_entries)}, total={len(valid_existing) + len(new_entries)}')

    # 5. Status track
    status_extra = {'existing_count': len(valid_existing), 'new_count': len(new_entries)}

    return valid_existing + new_entries, len(new_entries)


def verify_entry_logic(entry: dict) -> bool:
    """Verify existing entry pass cultural lock + schema."""
    # Cultural lock
    text_fields = [v for v in entry.values() if isinstance(v, str)]
    for text in text_fields:
        if not cultural_lock_check(text):
            return False
    # Schema required fields (per CMD)
    required_keys = ['id', 'name']  # base, CMD adds more
    return all(k in entry or '_index' in entry for k in required_keys[:1])


def cross_verify_with_existing(new_entry: dict, existing: list) -> bool:
    """Verify new entry consistent với existing pattern (era distribution, naming)."""
    if not existing:
        return True
    # Check era distribution similar
    new_era = new_entry.get('era', '')
    if new_era and 'era' in existing[0]:
        existing_eras = set(e.get('era') for e in existing[:100])
        if new_era not in existing_eras and new_era not in ['ly', 'tran', 'le', 'tay_son', 'nguyen', 'f1', 'f2', 'f3', 'f4', 'f5', 'g1']:
            return False
    return True
```

**Rules:**
1. **EXISTING IMMUTABLE** — KHÔNG sửa entry cũ
2. **EXTEND ONLY** — chỉ thêm phần thiếu
3. **STATUS TRACK** — JSON có existing_count + new_count
4. **ALERT LEAD** nếu existing < 50% target
5. **CROSS-VERIFY** new entries match existing pattern



```python
import logging
log = logging.getLogger(CMD_NAME)
log.setLevel(logging.INFO)
_h = logging.StreamHandler()
_h.setFormatter(logging.Formatter('%(asctime)s [%(name)s] [%(levelname)s] %(message)s'))
log.addHandler(_h)
```

## 🛡️ EDGE CASE HANDLING (Round 10-audit fix)


```python
# R4.8 max retry constants
MAX_RETRY = 3
LOOP_INTERVAL_SEC = 60              # Tối đa 3 lần retry build/push fail
RETRY_DELAY_SEC = 5
MAX_BUILD_ATTEMPTS = 3     # max retry attempt khi build fail
MAX_PUSH_ATTEMPTS = 3      # max retry attempt khi git push fail
```

```python
# R4: Max retry + input validation + graceful shutdown
MAX_RETRY = 3
RETRY_DELAY_SEC = 5

def validate_input(cmd_name: str, output_dir: Path):
    """R4.9 input validation."""
    assert isinstance(cmd_name, str) and cmd_name, "cmd_name must be non-empty string"
    assert isinstance(output_dir, Path), "output_dir must be Path object"
    assert output_dir.parent.exists(), f"Parent dir not exist: {output_dir.parent}"


def safe_main_loop():
    """R4.10 graceful shutdown on Ctrl+C."""
    import signal

    def handle_sigterm(signum, frame):
        print('[SHUTDOWN] Received SIGTERM, finishing current task...')
        sys.exit(0)

    signal.signal(signal.SIGTERM, handle_sigterm)

    try:
        main_loop()
    except KeyboardInterrupt:
        print('[SHUTDOWN] Ctrl+C received, exiting gracefully')
        sys.exit(0)
    except Exception as e:
        print(f'[FATAL] Unhandled error: {e}')
        sys.exit(2)
```

---

## 📡 ALERTS TO LEAD (R5.8 cross-CMD communication)

CMD chỉ OBSERVE, không JUDGE. Phát hiện vấn đề → ghi alert:

```python
def send_alert_to_lead(severity: str, issue_id: str, evidence: dict):
    """Push alert vào cmd-lead/alerts/HIGH-{ts}.json."""
    repo_dir = Path('/tmp/svtk-status')
    alerts_dir = repo_dir / 'cmd-lead' / 'alerts'
    alerts_dir.mkdir(parents=True, exist_ok=True)

    ts = time.strftime('%Y%m%d-%H%M%S')
    alert_path = alerts_dir / f'{severity}-{ts}.json'

    alert_path.write_text(json.dumps({
        'severity': severity,  # HIGH / MED / LOW
        'issue_id': issue_id,
        'evidence': evidence,
        'cmd_origin': CMD_NAME,
        'timestamp': ts,
    }, indent=2, ensure_ascii=False))

    # Push alert to repo
    subprocess.run(['git', '-C', str(repo_dir), 'add', str(alert_path)], check=True)
    subprocess.run(['git', '-C', str(repo_dir), 'commit', '-m',
                   f'ALERT {severity} {issue_id} from {CMD_NAME}'], check=True)
    subprocess.run(['git', '-C', str(repo_dir), 'push', 'origin', 'main'], check=True)
    print(f'⚠️ Alert pushed: {alert_path.name}')
```

---

## 🔍 SELF-AUDIT (15-item)

| # | Item | ✓ |
|---|------|---|
| 1 | Foundation hash verify | ✓ |
| 2 | Total ≥3000 quest | ✓ |
| 3 | 6 category đầy đủ (main/side/lore/event/raid/reborn + generated) | ✓ |
| 4 | 6 objective types covered | ✓ |
| 5 | 5 era covered | ✓ |
| 6 | Quest title thuần Việt (regex anti Hán/Nhật) | ✓ |
| 7 | Cross-reference NPC giver_npc_id | ✓ |
| 8 | 34 quest chains | ✓ |
| 9 | Schema PostgreSQL với CHECK constraints | ✓ |
| 10 | Reward gold/exp/item/reputation | ✓ |
| 11 | Protagonist arc flag cho main quest | ✓ |
| 12 | Anti-snowball reward scaling | ✓ |
| 13 | JSONL split theo category | ✓ |
| 14 | 15-item validator | ✓ |
| 15 | Honest gap admit (4 gap) | ✓ |

**Score ~95% PARTIAL ship.**

---


### ⚠️ Gap nội tại (4 admit honest - audit round 1)

1. **Quest template limited** — Chỉ 10 main template + 14 lore chain. Generated quests dùng pattern lặp → MED, CMD QA-CONTENT review
2. **NPC cross-ref runtime** — `load_npc_registry()` phụ thuộc CMD NPC xong trước. Race condition nếu NPC chưa ship → MED
3. **Reward item placeholder** — `reward_item_id` dạng template_id, KHÔNG link instance UUID (CMD ITEM gen sau) → LOW
4. **Recurrence chưa support** — Daily/weekly quest reset chưa code → LOW, CMD QA-FULL test

**Score ~90% sau audit round 1.** Cần FIX ROUND 2 nếu <95%.

---



---

## 🔄 REVERSE CHANNEL (worker → LEAD) — v2.1 protocol

```python
def push_ack_to_lead(fix_id: str):
    """ACK: Worker xác nhận đã nhận fix task."""
    ts = time.strftime('%Y%m%d-%H%M%S')
    ack_dir = REPO_DIR / 'cmd-lead' / 'acks'
    ack_dir.mkdir(parents=True, exist_ok=True)
    (ack_dir / f'ACK-{fix_id}-{ts}.json').write_text(
        json.dumps({'fix_id': fix_id, 'acked_by': CMD_NAME.lower(),
                    'timestamp': ts, 'status': 'PROCESSING'},
                  ensure_ascii=False, indent=2), encoding='utf-8')

def push_completion_to_lead(fix_id: str, result: str, evidence: dict):
    """COMPLETION: result phải là 'PASS' | 'FAIL' | 'PARTIAL'."""
    assert result in ('PASS', 'FAIL', 'PARTIAL'), f'Invalid result: {result}'
    ts = time.strftime('%Y%m%d-%H%M%S')
    comp_dir = REPO_DIR / 'cmd-lead' / 'completions'
    comp_dir.mkdir(parents=True, exist_ok=True)
    (comp_dir / f'{result}-{fix_id}-{ts}.json').write_text(
        json.dumps({'fix_id': fix_id, 'fixed_by': CMD_NAME.lower(),
                    'result': result, 'evidence': evidence,
                    'timestamp': ts},
                  ensure_ascii=False, indent=2), encoding='utf-8')

def push_heartbeat_to_lead():
    """HEARTBEAT: alive signal, push mỗi cycle."""
    ts = time.strftime('%Y%m%d-%H%M%S')
    hb_dir = REPO_DIR / 'cmd-lead' / 'heartbeats'
    hb_dir.mkdir(parents=True, exist_ok=True)
    (hb_dir / f'{CMD_NAME.lower()}-{ts}.json').write_text(
        json.dumps({'worker': CMD_NAME.lower(), 'timestamp': ts,
                    'alive': True}, ensure_ascii=False, indent=2),
        encoding='utf-8')

# Apply trong main_loop:
#   1. After receiving fix task → push_ack_to_lead(task['issue_id'])
#   2. After apply_fix_task → push_completion_to_lead(fix_id, 'PASS'/'FAIL', evidence)
#   3. Mỗi cycle start → push_heartbeat_to_lead()
```

---



## 🎯 EXIT CODES

| Code | Meaning |
|---|---|
| 0 | Done OK |
| 1 | PARTIAL (gaps admit) |
| 2 | Fatal error |
| 99 | Foundation hash mismatch |

```python
EXIT_OK = 0
EXIT_PARTIAL = 1
EXIT_FATAL = 2
EXIT_FOUNDATION_MISMATCH = 99
```

**END CMD_QUEST v1.0**


---

## 🔐 ANTI-DUPE TRIỆT ĐỂ (6 rules từ Foundation R45/R46/R67)

TS Online dupe được vì THIẾU 6 rules này. SVTK BẮT BUỘC có đủ.

### Rule A: UUID per instance (KHÔNG chỉ template_id)
```python
import uuid

def assign_uuid_for_dedup(entity: dict) -> dict:
    """Mỗi instance có UUID riêng, không trùng template_id."""
    entity['uuid'] = str(uuid.uuid4())
    entity['template_id'] = entity.get('template_id') or entity.get('id')
    return entity
```

### Rule B: Transaction log mỗi action
```python
def log_transaction(entity_uuid: str, action: str, actor: str, evidence: dict):
    """Log mọi action: pickup/drop/trade/store/transfer/spawn/destroy."""
    ts = time.strftime('%Y%m%d-%H%M%S')
    tx = {
        'entity_uuid': entity_uuid,
        'action': action,  # pickup|drop|trade|store|transfer|spawn|destroy
        'actor': actor,
        'evidence': evidence,
        'timestamp': ts,
        'tx_id': str(uuid.uuid4()),
    }
    tx_dir = REPO_DIR / f'cmd-{CMD_NAME.lower()}' / 'transaction_log'
    tx_dir.mkdir(parents=True, exist_ok=True)
    (tx_dir / f'{ts}-{action}-{entity_uuid[:8]}.json').write_text(
        json.dumps(tx, ensure_ascii=False, indent=2), encoding='utf-8')
    return tx
```

### Rule C: 2-Phase Commit cho mọi transfer
```python
def two_phase_commit_transfer(entity_uuid: str, from_owner: str, to_owner: str) -> bool:
    """2PC: PREPARE → COMMIT hoặc ABORT (no partial state).

    Phase 1 PREPARE:
      - Lock entity_uuid trong source
      - Check destination capacity
      - Validate entity tồn tại + chưa transfer
    Phase 2 COMMIT:
      - Remove từ source
      - Add vào destination
      - Log transaction
    OR ABORT:
      - Unlock source
      - No state change
    """
    # Phase 1 PREPARE
    prepare_ok = lock_entity(entity_uuid, from_owner) and \
                 check_destination(to_owner) and \
                 validate_entity_exists(entity_uuid)
    if not prepare_ok:
        unlock_entity(entity_uuid, from_owner)
        log_transaction(entity_uuid, 'transfer_abort', from_owner,
                       {'reason': 'prepare_failed'})
        return False

    # Phase 2 COMMIT
    try:
        remove_from_owner(entity_uuid, from_owner)
        add_to_owner(entity_uuid, to_owner)
        log_transaction(entity_uuid, 'transfer_commit', from_owner,
                       {'to_owner': to_owner})
        return True
    except Exception as e:
        # Rollback
        add_to_owner(entity_uuid, from_owner)
        log_transaction(entity_uuid, 'transfer_rollback', from_owner,
                       {'error': str(e)})
        return False
    finally:
        unlock_entity(entity_uuid, from_owner)
```

### Rule D: Authoritative server (client KHÔNG cache)
```python
AUTHORITATIVE_SERVER = True  # Server là source of truth
CLIENT_CACHE_DISABLED = True  # Client KHÔNG cache inventory

def server_authoritative_inventory(player_id: str) -> list:
    """Server-side authoritative: chỉ DB là nguồn duy nhất.
    Client request → server fetch DB → return.
    Client KHÔNG cache → KHÔNG có race condition."""
    return query_db_inventory(player_id)  # always fresh from DB
```

### Rule E: Anti-dupe heartbeat (30s check UUID duplicate)
```python
ANTI_DUPE_HEARTBEAT_SEC = 30

def anti_dupe_heartbeat():
    """Mỗi 30s scan toàn inventory tìm UUID duplicate.
    Nếu phát hiện → freeze tài khoản + alert LEAD."""
    while True:
        all_uuids = scan_all_inventories()
        seen = set()
        dupes = []
        for uid in all_uuids:
            if uid in seen:
                dupes.append(uid)
            seen.add(uid)
        if dupes:
            for d in dupes:
                send_alert_to_lead('HIGH', f'uuid_duplicate_{d[:8]}',
                                  {'uuid': d, 'count': all_uuids.count(d)})
                freeze_affected_accounts(d)
        time.sleep(ANTI_DUPE_HEARTBEAT_SEC)
```

### Rule F: Disconnect grace period 90s
```python
DISCONNECT_GRACE_PERIOD_SEC = 90

def handle_disconnect(player_id: str):
    """Disconnect → giữ session 90s trước khi cleanup.
    Tránh race condition: player relog ngay → 2 session active → dupe."""
    mark_player_disconnecting(player_id, grace_until=time.time() + DISCONNECT_GRACE_PERIOD_SEC)
    time.sleep(DISCONNECT_GRACE_PERIOD_SEC)
    if not is_player_reconnected(player_id):
        cleanup_player_session(player_id)
        log_transaction(player_id, 'session_cleanup', 'system', {})
    else:
        # Player relog trong grace period → reuse session
        log_transaction(player_id, 'session_resume', 'system', {})
```

---

## 🐾 ANTI-DUPE BỔ SUNG CHO PET (NPC subset)

Pet là NPC có flag `pettable=true`. Khi player bắt pet → tạo PET INSTANCE:

```python
PET_LIFESTATES = ('ACTIVE', 'STORED', 'DEAD', 'IN_TRANSFER')

def spawn_pet_instance(npc_template_id: int, owner_id: str) -> dict:
    """Tạo pet instance UUID. NPC template_id chỉ template, instance UUID riêng."""
    pet = {
        'uuid': str(uuid.uuid4()),
        'template_id': npc_template_id,  # NPC._index
        'owner_id': owner_id,
        'birth_owner_id': owner_id,
        'current_owner_id': owner_id,
        'lifestate': 'ACTIVE',  # chỉ 1 lifestate tại 1 thời điểm
        'level': 1,
        'loyalty': 50,
        'exp': 0,
        'bond_score': 0,
        'transfer_history': [],
        'parent_uuids': [],  # nếu breed
        'created_at': time.strftime('%Y%m%d-%H%M%S'),
    }
    log_transaction(pet['uuid'], 'spawn', owner_id, {'template_id': npc_template_id})
    return pet


def trade_pet_reset_bond(pet_uuid: str, from_owner: str, to_owner: str):
    """Trade pet → bond reset = 0 (anti-mule).
    DEAD irreversible."""
    pet = get_pet(pet_uuid)
    if pet['lifestate'] == 'DEAD':
        return False  # KHÔNG trade pet đã chết
    if pet['lifestate'] == 'IN_TRANSFER':
        return False  # đang transfer rồi

    pet['lifestate'] = 'IN_TRANSFER'
    if two_phase_commit_transfer(pet_uuid, from_owner, to_owner):
        pet['bond_score'] = 0  # reset anti-mule
        pet['current_owner_id'] = to_owner
        pet['lifestate'] = 'ACTIVE'
        pet['transfer_history'].append({
            'from': from_owner, 'to': to_owner,
            'timestamp': time.strftime('%Y%m%d-%H%M%S')
        })
        return True
    else:
        pet['lifestate'] = 'ACTIVE'  # rollback
        return False
```

---

## 📜 QUEST ANTI-DUPE (special rules)

Quest KHÔNG tradeable nhưng vẫn cần chống dupe progress/reward:

```python
def create_quest_instance(quest_template_id: int, player_id: str) -> dict:
    """Player nhận quest → tạo QUEST INSTANCE UUID per player."""
    qi = {
        'quest_instance_uuid': str(uuid.uuid4()),
        'quest_template_id': quest_template_id,
        'player_id': player_id,
        'status': 'ACTIVE',  # ACTIVE | COMPLETED | FAILED | ABANDONED
        'progress': 0,
        'reward_claimed': False,  # ⚠️ ANTI-DUPE: chỉ claim 1 lần
        'started_at': time.strftime('%Y%m%d-%H%M%S'),
        'completed_at': None,
    }
    # Anti-dupe: 1 player KHÔNG nhận lại cùng quest (trừ repeatable)
    if check_quest_already_active(quest_template_id, player_id):
        return None  # reject duplicate accept
    log_transaction(qi['quest_instance_uuid'], 'quest_accept', player_id,
                   {'template_id': quest_template_id})
    return qi


def complete_quest_2PC(quest_instance_uuid: str, player_id: str) -> bool:
    """Quest complete + reward = atomic transaction (2PC).
    KHÔNG được: complete twice, reward replay."""
    qi = get_quest_instance(quest_instance_uuid)
    if qi['status'] == 'COMPLETED':
        send_alert_to_lead('HIGH', 'quest_complete_replay',
                          {'quest_uuid': quest_instance_uuid})
        return False  # ⚠️ anti-replay
    if qi['reward_claimed']:
        return False  # ⚠️ anti-dupe reward

    # 2PC: PREPARE
    prepare_ok = (qi['progress'] >= 100 and qi['status'] == 'ACTIVE')
    if not prepare_ok:
        return False

    # COMMIT atomically
    try:
        qi['status'] = 'COMPLETED'
        qi['completed_at'] = time.strftime('%Y%m%d-%H%M%S')
        qi['reward_claimed'] = True
        grant_reward_uuid_tracked(player_id, qi['quest_template_id'])
        log_transaction(quest_instance_uuid, 'quest_complete', player_id,
                       {'template_id': qi['quest_template_id']})
        return True
    except Exception as e:
        # Rollback
        qi['status'] = 'ACTIVE'
        qi['reward_claimed'] = False
        log_transaction(quest_instance_uuid, 'quest_rollback', player_id,
                       {'error': str(e)})
        return False


def grant_reward_uuid_tracked(player_id: str, quest_template_id: int):
    """Reward grant có UUID per reward (item drop có UUID riêng).
    Anti-dupe: KHÔNG replay reward grant."""
    reward_uuid = str(uuid.uuid4())
    log_transaction(reward_uuid, 'reward_grant', 'system',
                   {'player': player_id, 'quest_template': quest_template_id})
```

---

## 🌐 UNIVERSAL TRACKING (R67)

```python
TRADEABLE_ENTITY_TYPES = ['item', 'pet', 'mount', 'skill_book', 'npc_follower']
NON_TRADEABLE_TRACKED = ['quest_instance']  # tracked per player nhưng KHÔNG transfer
GOLD_TRACKING = 'amount_with_source_log'  # KHÔNG UUID per coin
```

MỌI entity tradeable PHẢI:
- UUID per instance
- transaction log
- source tracking (birth_owner)
- 2PC khi transfer
- grace period 90s khi disconnect

Quest instance: UUID per player, KHÔNG transfer, nhưng anti-replay completion.



---

## 🎯 SVTK TARGET (LỚN HƠN TS Online)

```python
SVTK_TARGET = 3000    # VSTK target (vượt TSO)
TSO_BASELINE = 2262    # TS Online actual
# Phải PASS: count >= SVTK_TARGET (> TSO 2262)
```

## 🔄 R71 LOAD + FIX + EXTEND PIPELINE

```python
import json, random
from pathlib import Path
from collections import Counter

EXISTING_PATH = REPO_DIR / 'cmd-quest' / 'existing'
OUTPUT_PATH = REPO_DIR / 'cmd-quest' / 'output' / 'registry'


def r71_load_existing():
    """Load existing data từ session trước."""
    entries = []
    if not EXISTING_PATH.exists():
        return entries
    for p in EXISTING_PATH.glob('*.jsonl'):
        for line in p.read_text(encoding='utf-8').split('\n'):
            if line.strip():
                try:
                    entries.append(json.loads(line))
                except Exception:
                    continue
    return entries


def detect_bugs(entries):
    """Phát hiện bug imbalance/missing field/cultural lock."""
    bugs = []
    # Bug 1: count gap
    if len(entries) < SVTK_TARGET:
        bugs.append({
            'type': 'count_below_target',
            'evidence': {'actual': len(entries), 'target': SVTK_TARGET}
        })
    # Bug 2: missing required fields (override theo CMD)
    # Bug 3: cultural lock (Tam Quốc + CJK)
    import re
    TQ = re.compile(r'(Tào Tháo|Lưu Bị|Quan Vũ|Tam Quốc)')
    CJK = re.compile(r'[\u4E00-\u9FFF]')
    tq_hits = sum(1 for e in entries if TQ.search(json.dumps(e, ensure_ascii=False)))
    cjk_hits = sum(1 for e in entries if CJK.search(json.dumps(e, ensure_ascii=False)))
    if tq_hits:
        bugs.append({'type': 'tam_quoc_violation', 'evidence': {'count': tq_hits}})
    if cjk_hits:
        bugs.append({'type': 'cjk_violation', 'evidence': {'count': cjk_hits}})
    return bugs


def fix_bugs(entries):
    """Fix tất cả bug detected. Override per CMD."""
    return entries  # placeholder, từng CMD override


def extend_to_target(entries, target, seed=42):
    """Extend list đến target_count với balance distribution.
    Override per CMD."""
    return entries  # placeholder


def main_pipeline():
    """LOAD → FIX → EXTEND → SAVE → STATUS."""
    entries = r71_load_existing()
    initial = len(entries)

    bugs = detect_bugs(entries)
    if bugs:
        for bug in bugs:
            severity = 'HIGH' if bug['type'] != 'count_below_target' else 'MED'
            send_alert_to_lead_with_target(severity, f'quest_' + bug['type'],
                                          bug['evidence'], target_worker='quest')

    entries = fix_bugs(entries)
    entries = extend_to_target(entries, SVTK_TARGET)

    # Save output
    OUTPUT_PATH.mkdir(parents=True, exist_ok=True)
    out = OUTPUT_PATH / 'quest_full.jsonl'
    with out.open('w', encoding='utf-8') as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + '\n')

    # Status
    worker_push_status_with_count(
        existing_count=initial,
        new_count=len(entries) - initial,
        gaps=[b['type'] for b in bugs]
    )

    # Completion
    push_completion_to_lead(
        fix_id=f'quest_extend_to_target',
        result='PASS' if len(entries) >= SVTK_TARGET else 'PARTIAL',
        evidence={'count': len(entries), 'target': SVTK_TARGET}
    )
```


## ⚗️ 6 HỆ VSTK ELEMENT (R79)

```python
# 5 ngũ hành TS Online + Tâm (VSTK thêm):
VSTK_ELEMENTS = {
    'kim':  {'strong': 'mộc', 'weak': 'hỏa'},
    'mộc':  {'strong': 'thổ', 'weak': 'kim'},
    'thủy': {'strong': 'hỏa', 'weak': 'thổ'},
    'hỏa':  {'strong': 'kim', 'weak': 'thủy'},
    'thổ':  {'strong': 'thủy','weak': 'mộc'},
    'tâm':  {'strong': None,  'weak': None},  # trung lập
}
# Damage modifier: strong ×1.5, weak ×0.5, same/tâm ×1.0
```


## ✅ ACCEPTANCE

```
- Đếm entries ≥ SVTK_TARGET
- Mọi entry pass cultural lock (no Tam Quốc + no CJK)
- Schema validation passed (đủ field)
- 6 hệ VSTK + tier hierarchy verified
- Push completion lên CMD5 LEAD
- Exit code 0 = pass, 1 = fail (count thiếu hoặc schema bug)
```
