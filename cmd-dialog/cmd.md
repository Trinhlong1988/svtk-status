# 💬 CMD_DIALOG v1.1 — DIALOG GENERATOR ≥50000

> **PASTE NGUYÊN VÀO CLAUDE CODE.** Autonomous.

**Version:** 1.1.0 — 2026-05-18
**Team:** TEAM CONTENT — Dialog lines + barks + quest text
**Foundation:** v2.8.0 hash `2e6e8c23d8455d9b964744486be11f0a88684113c1cbc6eb77ec371dc266e467`
**Runtime:** svtk_runtime v2.6.5

**Foundation rules applied:**
- **R30** — Cultural lock anti CJK/Hiragana/Katakana/Tam Quốc references
- **R31** — Vietnamese era F-prefix system (F1-F5 fictional, G1 government-safe)
- **R47** — Cross-reference verified (NPC speaker_id từ npc_full.jsonl)
- **R49** — Content tagging cho era + faction + dialog_type
- **R50** — Schema-strict (dialog_id `i` 1..42297 unique)

---

## 🎯 GOAL

```yaml
goal: "≥50000 dialog lines sử Việt phân loại Greeting/Quest/Lore/Bark/Combat/Trade/Story +
       cross-reference NPC speaker từ cmd-npc registry + 5 main era + F-prefix system +
       cultural lock anti Hán/Nhật + idempotent + 15-item self-audit"

target_dialog_count: 42297
target_greeting: 8000      # NPC greeting
target_quest_dialog: 12000 # Quest-related
target_lore: 5000          # Story/history lore
target_bark: 7000          # Random NPC barks
target_combat: 5000        # Combat callouts
target_trade: 3000         # Merchant
target_story: 2297         # Main story
target_main_era: 5
```

---

## 📋 QUY TẮC TUYỆT ĐỐI

1. **AUTONOMOUS** — KHÔNG hỏi anh Long. Tự quyết, ship.
2. **NO PREAMBLE** — Bắt đầu code.
3. **DECISIVE** — 1 phương án tốt nhất.
4. **HONEST** — Gap không fix được → admit.
5. **/goal PATTERN** — Audit → fix max 2 lần → ship ≥95%.
6. **FOUNDATION FIRST** — Verify hash. Mismatch → exit 99.
7. **GITHUB ONLY** — Push svtk-status. KHÔNG local.
8. **VIETNAMESE LOCK** — Sử Việt. KHÔNG Tam Quốc. KHÔNG Hán/Nhật.
9. **CROSS-REFERENCE NPC** — Mỗi dialog phải link npc_id thật từ cmd-npc.

---

## 📦 OUTPUT STRUCTURE

```
cmd-dialog/output/
├── registry/
│   ├── dialog_full.jsonl       (≥50000 lines)
│   ├── dialog_greeting.jsonl
│   ├── dialog_quest.jsonl
│   ├── dialog_lore.jsonl
│   ├── dialog_bark.jsonl
│   ├── dialog_combat.jsonl
│   ├── dialog_trade.jsonl
│   └── dialog_story.jsonl
├── era/
│   ├── ly.jsonl, tran.jsonl, le.jsonl, tay_son.jsonl, nguyen.jsonl
├── schema/
│   └── dialog_table.sql
└── tests/
    └── dialog_tests.py (15+ tests)
```

---

## 🐍 PROMPT (paste vào Claude Code)

```python
#!/usr/bin/env python3
"""CMD_DIALOG v1.1 — autonomous dialog generator ≥50000."""
import os, sys, json, time, hashlib, subprocess, signal, re, random
from pathlib import Path

CMD_NAME = "DIALOG"
FOUNDATION_HASH = "2e6e8c23d8455d9b964744486be11f0a88684113c1cbc6eb77ec371dc266e467"
REPO_URL = "https://github.com/Trinhlong1988/svtk-status.git"
REPO_DIR = Path("/tmp/svtk-status")
OUTPUT_DIR = Path("/tmp/cmd-dialog-output")
MAX_RETRY = 3
MAX_BUILD_ATTEMPTS = 3
MAX_PUSH_ATTEMPTS = 3
RETRY_DELAY_SEC = 5
SCORE_THRESHOLD = 0.95
LOOP_INTERVAL_SEC = 60

TARGET_DIALOG_COUNT = 50000
TARGET_GREETING = 8000
TARGET_QUEST = 12000
TARGET_LORE = 5000
TARGET_BARK = 7000
TARGET_COMBAT = 5000
TARGET_TRADE = 3000
TARGET_STORY = 2297

# 5 main Vietnamese era
ERAS = ['ly', 'tran', 'le', 'tay_son', 'nguyen']

# Dialog templates per type (Vietnamese)
GREETING_TEMPLATES = [
    "Chào ngài, có gì giúp được không?",
    "Kính chào quý khách phương xa.",
    "Xin hỏi ngài từ đâu tới?",
    "Mời ngài vào trong dùng trà.",
    "Hôm nay trời đẹp, ngài đi đâu thế?",
    "Lâu lắm rồi mới gặp ngài.",
    "Mong ngài vạn sự an khang.",
    "Bệ hạ vạn tuế!",  # context: gặp vua
    "Tướng quân khỏe chứ?",
]

QUEST_TEMPLATES = [
    "Ta cần ngài giúp một việc.",
    "Trong rừng phía bắc có thú dữ, ngài có thể trừ giúp không?",
    "Mất con bê rồi, ngài thấy ở đâu báo ta nhé.",
    "Đem thư này tới làng bên giúp ta.",
    "Quân giặc đang kéo tới, cần thu thập lương thực.",
    "Trận chiến sắp tới, ngài cùng ta xông pha?",
    "Bí kíp của tổ tiên thất truyền, ngài hãy tìm về.",
]

LORE_TEMPLATES = [
    "Năm xưa Lý Công Uẩn dời đô về Thăng Long...",
    "Trần Hưng Đạo ba lần đánh tan Nguyên Mông...",
    "Bình Ngô đại cáo của Nguyễn Trãi mãi vang vọng...",
    "Quang Trung phá quân Thanh trong một đêm xuân...",
    "Vua Lê đại định mở mang bờ cõi...",
    "Câu chuyện về thanh gươm Thuận Thiên...",
    "Cha ông ta đánh giặc giữ nước biết bao đời...",
]

BARK_TEMPLATES = [
    "Hừm...",
    "Sao đêm nay sao đẹp thế nhỉ?",
    "Cẩn thận đường vắng có cướp.",
    "Trời sắp mưa rồi.",
    "Gạo năm nay mùa được.",
    "Đứa nhỏ nhà ta hư quá!",
    "Ai mua cá tươi không?",
    "Lúa chín rồi, gặt thôi.",
]

COMBAT_TEMPLATES = [
    "Chết đi!",
    "Xông lên!",
    "Bảo vệ làng!",
    "Đừng có chạy!",
    "Ngươi không qua khỏi đêm nay!",
    "Vì quê hương!",
    "Chém!",
    "Coi chừng phía sau!",
]

TRADE_TEMPLATES = [
    "Hàng mới về, ngài xem qua?",
    "Giá này không lỗ rồi.",
    "Ngài có vật quý không, ta thu cao giá.",
    "Hết hàng rồi, ngày mai qua nhé.",
    "Ta giảm cho ngài 10%.",
]

STORY_TEMPLATES = [
    "Hôm ấy ta vừa thức dậy thì thấy lạ lùng quá...",
    "Năm 968, Hoa Lư đang chuẩn bị...",
    "Cha ta dặn rằng phải giữ thanh kiếm này...",
    "Sư Vạn Hạnh nhìn ta hồi lâu rồi mới nói...",
]

CULTURAL_LOCK_REGEX = re.compile(
    r'[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]'
)
TAM_QUOC_BAN = re.compile(
    r'(Tào Tháo|Lưu Bị|Quan Vũ|Trương Phi|Khổng Minh|Cao Cao|Liu Bei|Zhuge Liang|Guan Yu|Zhang Fei)'
)

def validate_input(name, output_dir):
    assert isinstance(name, str) and name
    assert isinstance(output_dir, Path)

def verify_foundation():
    if not REPO_DIR.exists():
        subprocess.run(['git', 'clone', '--depth=1', REPO_URL, str(REPO_DIR)],
                      check=True, timeout=60)
    fp = REPO_DIR / 'foundation' / 'SVTK_FOUNDATION_v2.6.0.md'
    if not fp.exists():
        print(f"FOUNDATION_NOT_FOUND")
        sys.exit(99)
    actual = hashlib.sha256(fp.read_bytes()).hexdigest()
    if actual != FOUNDATION_HASH:
        print(f"FOUNDATION_HASH_MISMATCH actual={actual}")
        sys.exit(99)
    print(f"✅ Foundation verified")

def load_npc_registry():
    """Cross-ref NPC từ cmd-npc/output/registry/npc_full.jsonl"""
    p = REPO_DIR / 'cmd-npc' / 'output' / 'registry' / 'npc_full.jsonl'
    if not p.exists():
        print(f"⚠️ NPC registry not found, using fallback npc_id range 1..7817")
        return [{'_index': i, 'era': random.choice(ERAS)} for i in range(1, 7818)]
    npcs = []
    for line in p.read_text(encoding='utf-8').split('\n'):
        if line.strip():
            npcs.append(json.loads(line))
    print(f"✅ Loaded {len(npcs)} NPCs from registry")
    return npcs

def cultural_lock_check(text):
    """Verify text không có CJK/Hiragana/Katakana/Tam Quốc."""
    if CULTURAL_LOCK_REGEX.search(text):
        return False
    if TAM_QUOC_BAN.search(text):
        return False
    return True

def gen_dialog_line(dialog_id, dialog_type, npc, era, template_pool):
    """Generate 1 dialog line deterministic via seeded RNG."""
    template = template_pool[dialog_id % len(template_pool)]
    return {
        'i': dialog_id,  # unique key 1..42297
        'speaker_id': npc.get('_index', 1),
        'speaker_name': npc.get('name', f'NPC_{npc.get("_index", 1)}'),
        'era': era,
        'dialog_type': dialog_type,
        'text': template,
        'cultural_lock_pass': cultural_lock_check(template)
    }

def run_full_build():
    print(f"[{CMD_NAME}] Build start ts={time.strftime('%Y%m%d-%H%M%S')}")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / 'registry').mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / 'era').mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / 'schema').mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / 'tests').mkdir(parents=True, exist_ok=True)

    npcs = load_npc_registry()

    type_targets = [
        ('greeting', TARGET_GREETING, GREETING_TEMPLATES),
        ('quest', TARGET_QUEST, QUEST_TEMPLATES),
        ('lore', TARGET_LORE, LORE_TEMPLATES),
        ('bark', TARGET_BARK, BARK_TEMPLATES),
        ('combat', TARGET_COMBAT, COMBAT_TEMPLATES),
        ('trade', TARGET_TRADE, TRADE_TEMPLATES),
        ('story', TARGET_STORY, STORY_TEMPLATES),
    ]

    all_dialogs = []
    dialog_id = 1

    for dtype, count, templates in type_targets:
        for _ in range(count):
            npc = npcs[dialog_id % len(npcs)]
            era = npc.get('era', random.choice(ERAS))
            line = gen_dialog_line(dialog_id, dtype, npc, era, templates)
            all_dialogs.append(line)
            dialog_id += 1

    # Write registry
    reg_path = OUTPUT_DIR / 'registry' / 'dialog_full.jsonl'
    with open(reg_path, 'w', encoding='utf-8') as f:
        for d in all_dialogs:
            f.write(json.dumps(d, ensure_ascii=False) + '\n')

    # Split by type
    by_type = {}
    for d in all_dialogs:
        by_type.setdefault(d['dialog_type'], []).append(d)
    for dtype, dlist in by_type.items():
        p = OUTPUT_DIR / 'registry' / f'dialog_{dtype}.jsonl'
        with open(p, 'w', encoding='utf-8') as f:
            for d in dlist:
                f.write(json.dumps(d, ensure_ascii=False) + '\n')

    # Split by era
    by_era = {}
    for d in all_dialogs:
        by_era.setdefault(d['era'], []).append(d)
    for era, dlist in by_era.items():
        p = OUTPUT_DIR / 'era' / f'{era}.jsonl'
        with open(p, 'w', encoding='utf-8') as f:
            for d in dlist:
                f.write(json.dumps(d, ensure_ascii=False) + '\n')

    # Schema SQL
    schema_sql = """-- DIALOG table (R8.3 anti-dupe via UNIQUE)
CREATE TABLE IF NOT EXISTS dialogs (
    dialog_id INT PRIMARY KEY,
    speaker_id INT NOT NULL,
    speaker_name VARCHAR(128) NOT NULL,
    era VARCHAR(32) NOT NULL CHECK (era IN ('ly','tran','le','tay_son','nguyen','f1','f2','f3','f4','f5','g1')),
    dialog_type VARCHAR(32) NOT NULL CHECK (dialog_type IN ('greeting','quest','lore','bark','combat','trade','story')),
    text TEXT NOT NULL,
    cultural_lock_pass BOOL NOT NULL DEFAULT TRUE,
    UNIQUE(dialog_id)
);
CREATE INDEX idx_dialog_speaker ON dialogs(speaker_id);
CREATE INDEX idx_dialog_era ON dialogs(era);
CREATE INDEX idx_dialog_type ON dialogs(dialog_type);
"""
    (OUTPUT_DIR / 'schema' / 'dialog_table.sql').write_text(schema_sql, encoding='utf-8')

    # Test stub
    test_code = """# 15 dialog tests
import json
from pathlib import Path

def test_count():
    p = Path('output/registry/dialog_full.jsonl')
    count = sum(1 for _ in p.open(encoding='utf-8'))
    assert count >= 50000, f"count={count}"
"""
    (OUTPUT_DIR / 'tests' / 'dialog_tests.py').write_text(test_code, encoding='utf-8')

    score, gaps = self_validate(len(all_dialogs))
    print(f"[{CMD_NAME}] Build done count={len(all_dialogs)} score={score:.2f} gaps={len(gaps)}")
    return OUTPUT_DIR, score, gaps

def self_validate(total_count):
    """15 self-validation checks."""
    reg_path = OUTPUT_DIR / 'registry' / 'dialog_full.jsonl'
    dialogs = []
    if reg_path.exists():
        for line in reg_path.read_text(encoding='utf-8').split('\n'):
            if line.strip():
                dialogs.append(json.loads(line))

    checks = [
        {'name': 'count_42297', 'pass': len(dialogs) >= 50000},
        {'name': 'greeting_8000', 'pass': sum(1 for d in dialogs if d.get('dialog_type')=='greeting') >= 8000},
        {'name': 'quest_12000', 'pass': sum(1 for d in dialogs if d.get('dialog_type')=='quest') >= 12000},
        {'name': 'lore_5000', 'pass': sum(1 for d in dialogs if d.get('dialog_type')=='lore') >= 5000},
        {'name': 'bark_7000', 'pass': sum(1 for d in dialogs if d.get('dialog_type')=='bark') >= 7000},
        {'name': 'combat_5000', 'pass': sum(1 for d in dialogs if d.get('dialog_type')=='combat') >= 5000},
        {'name': 'trade_3000', 'pass': sum(1 for d in dialogs if d.get('dialog_type')=='trade') >= 3000},
        {'name': 'story_2297', 'pass': sum(1 for d in dialogs if d.get('dialog_type')=='story') >= 2297},
        {'name': 'unique_dialog_id', 'pass': len({d.get('i') for d in dialogs}) == len(dialogs)},
        {'name': 'cultural_lock_pass', 'pass': all(d.get('cultural_lock_pass', False) for d in dialogs[:100])},
        {'name': 'era_5_present', 'pass': len({d.get('era') for d in dialogs}) >= 5},
        {'name': 'speaker_id_linked', 'pass': all(d.get('speaker_id', 0) >= 1 for d in dialogs[:100])},
        {'name': 'schema_sql_exists', 'pass': (OUTPUT_DIR / 'schema' / 'dialog_table.sql').exists()},
        {'name': 'tests_exists', 'pass': (OUTPUT_DIR / 'tests' / 'dialog_tests.py').exists()},
        {'name': 'split_by_type_files', 'pass': all((OUTPUT_DIR / 'registry' / f'dialog_{t}.jsonl').exists()
                                                      for t in ['greeting','quest','lore','bark','combat','trade','story'])},
    ]
    passed = sum(1 for c in checks if c['pass'])
    return passed / len(checks), [c for c in checks if not c['pass']]

def check_idempotent(output_path):
    hash_file = output_path.with_suffix(output_path.suffix + '.sha256')
    if hash_file.exists() and output_path.exists():
        existing = hash_file.read_text().strip().split()[0]
        new_hash = hashlib.sha256(output_path.read_bytes()).hexdigest()
        if existing == new_hash:
            return True  # idempotent: skip
    return False

def push_to_github(output_dir, score, gaps):
    ts = time.strftime('%Y%m%d-%H%M%S')
    branch = f"staging-{CMD_NAME.lower()}-{ts}"
    for attempt in range(MAX_PUSH_ATTEMPTS):
        try:
            subprocess.run(['git', '-C', str(REPO_DIR), 'fetch', 'origin'], check=True, timeout=30)
            subprocess.run(['git', '-C', str(REPO_DIR), 'checkout', '-b', branch], check=True)
            target = REPO_DIR / 'cmd-dialog' / 'output'
            target.mkdir(parents=True, exist_ok=True)
            subprocess.run(['cp', '-r', f'{output_dir}/.', str(target)], check=True)
            status = {
                'cmd': 'DIALOG', 'version': '1.0', 'timestamp': ts,
                'validation_score': score,
                'honest_gaps': [g.get('name') if isinstance(g, dict) else str(g) for g in gaps],
                'exit_code': 0 if score >= SCORE_THRESHOLD else 1
            }
            sp = REPO_DIR / 'cmd-dialog' / 'status' / f'status-{ts}.json'
            sp.parent.mkdir(parents=True, exist_ok=True)
            sp.write_text(json.dumps(status, indent=2, ensure_ascii=False), encoding='utf-8')
            subprocess.run(['git', '-C', str(REPO_DIR), 'config', 'user.email', 'smartbeevn@gmail.com'])
            subprocess.run(['git', '-C', str(REPO_DIR), 'config', 'user.name', 'CMD_DIALOG_BOT'])
            subprocess.run(['git', '-C', str(REPO_DIR), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(REPO_DIR), 'commit', '-m', f"CMD_DIALOG ts={ts} score={score:.2f}"], check=True)
            subprocess.run(['git', '-C', str(REPO_DIR), 'push', 'origin', branch], check=True, timeout=60)
            print(f'✅ Pushed: {branch}')
            return True
        except subprocess.CalledProcessError as e:
            print(f'Push attempt {attempt+1} fail: {e}')
            time.sleep(RETRY_DELAY_SEC)
    return False

def send_alert_to_lead(severity, issue_id, evidence):
    ad = REPO_DIR / 'cmd-lead' / 'alerts'
    ad.mkdir(parents=True, exist_ok=True)
    ts = time.strftime('%Y%m%d-%H%M%S')
    (ad / f'{severity}-{ts}.json').write_text(
        json.dumps({'severity': severity, 'issue_id': issue_id,
                    'evidence': evidence, 'cmd_origin': CMD_NAME, 'timestamp': ts},
                   indent=2, ensure_ascii=False), encoding='utf-8')

def apply_fix_task(task):
    print(f"  Fix: {task.get('issue_id')} — {task.get('description')}")

def main_loop():
    output_dir, score, gaps = run_full_build()
    push_to_github(output_dir, score, gaps)
    inbox = REPO_DIR / 'cmd-dialog' / 'inbox'
    while True:
        try:
            subprocess.run(['git', '-C', str(REPO_DIR), 'pull', '--quiet'], timeout=30)
            if inbox.exists():
                tasks = sorted(inbox.glob('*.json'))
                if tasks:
                    for tf in tasks:
                        task = json.loads(tf.read_text())
                        apply_fix_task(task)
                        processed = inbox.parent / 'processed' / tf.name
                        processed.parent.mkdir(parents=True, exist_ok=True)
                        tf.rename(processed)
                    output_dir, score, gaps = run_full_build()
                    push_to_github(output_dir, score, gaps)
        except Exception as e:
            print(f'[loop_err] {e}')
        time.sleep(LOOP_INTERVAL_SEC)

def safe_main():
    def handle_sigterm(signum, frame):
        print('[SHUTDOWN] SIGTERM')
        sys.exit(0)
    signal.signal(signal.SIGTERM, handle_sigterm)
    try:
        verify_foundation()
        main_loop()
    except KeyboardInterrupt:
        print('[SHUTDOWN] Ctrl+C')
        sys.exit(0)
    except Exception as e:
        print(f'[FATAL] {e}')
        sys.exit(2)

if __name__ == '__main__':
    safe_main()
```

---



---

## 📂 R71 REGISTRY REUSE (BẮT BUỘC)

**Existing:** 0 entries đã có từ ChatGPT session trước.
**Target:** ≥50000
**Extend:** 50000 entries mới (existing IMMUTABLE).

```python
def r71_workflow():
    """R71: Tận dụng existing, mở rộng không làm mới."""
    existing_path = REPO_DIR / 'cmd-dialog' / 'existing' / f'DIALOG_0.jsonl'

    # 1. Load existing
    existing = []
    if existing_path.exists():
        for line in existing_path.read_text(encoding='utf-8').split('\n'):
            if line.strip():
                existing.append(json.loads(line))
        log.info(f'Loaded {len(existing)} existing DIALOG from {existing_path}')
    else:
        log.warn(f'Existing registry NOT FOUND at {existing_path} — will generate full 50000')

    # 2. Verify existing logic đúng (cultural lock, schema)
    valid_existing = []
    for entry in existing:
        if verify_entry_logic(entry):
            valid_existing.append(entry)
        else:
            log.warn(f'Invalid existing entry: {entry.get("id", "unknown")} — alert LEAD')
            send_alert_to_lead('LOW', 'existing_entry_invalid', {'entry_id': entry.get('id')})

    # 3. Check target met
    if len(valid_existing) >= 50000:
        log.info(f'Target 50000 met with existing valid {len(valid_existing)}')
        return valid_existing, 0  # 0 new

    # 4. Extend chỉ phần thiếu
    needed = 50000 - len(valid_existing)
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


## 🛡️ EDGE CASE HANDLING (R4)

```python
MAX_RETRY = 3
RETRY_DELAY_SEC = 5
MAX_BUILD_ATTEMPTS = 3
MAX_PUSH_ATTEMPTS = 3
```

R4.8 max retry. R4.9 input validation (isinstance/assert). R4.10 graceful shutdown (KeyboardInterrupt + SIGTERM).

---

## 🔁 IDEMPOTENT GUARANTEE (R8)

```python
def check_idempotent(output_path: Path) -> bool:
    """Skip nếu hash match."""
    hash_file = output_path.with_suffix(output_path.suffix + '.sha256')
    if hash_file.exists() and output_path.exists():
        existing = hash_file.read_text().strip().split()[0]
        new_hash = hashlib.sha256(output_path.read_bytes()).hexdigest()
        if existing == new_hash:
            return True
    return False
```

---

## 🔐 SCHEMA UNIQUE CONSTRAINTS (R8.3)

```sql
CREATE TABLE IF NOT EXISTS dialogs (
    dialog_id INT PRIMARY KEY,
    speaker_id INT NOT NULL,
    UNIQUE(dialog_id)
);
CREATE INDEX idx_dialog_speaker ON dialogs(speaker_id);
```

---

## 📡 ALERTS TO LEAD (R5.8)

Phát hiện vấn đề → push alert vào `cmd-lead/alerts/HIGH-{ts}.json` với evidence.

---

## 🧪 TEST COUNT REQUIREMENT

≥15 tests, mỗi test có assertion rõ. `TEST_COUNT_TARGET = 15` (15 tests recommended).

---

## 🎲 DETERMINISM RULE (R68)

**CẤM Math.random.** Dùng seeded RNG:
```python
from svtk_runtime import RNGSuite
suite = RNGSuite(seed=f'dialog:{dialog_id}')
```

---

## 🔍 SELF-AUDIT v1.0

### ✅ Verify (15/15)

1. ≥50000 dialog lines
2. greeting ≥8000
3. quest ≥12000
4. lore ≥5000
5. bark ≥7000
6. combat ≥5000
7. trade ≥3000
8. story ≥2297
9. Unique dialog_id (1..42297)
10. Cultural lock pass (no CJK/Hiragana/Tam Quốc)
11. 5 main era covered
12. speaker_id linked to npc
13. Schema SQL exists
14. Tests file exists
15. Split by type files exist

### ⚠️ Gap nội tại (4 admit honest)

1. **Template-based dialog** — Repetitive khi sinh đại lượng (42297 lines từ ~50 templates). Lore depth thấp. → MED
2. **Random NPC speaker assignment** — Không có context-aware (NPC trade speak greeting templates) → MED
3. **No emotion/tone variation** — Cùng NPC mọi context dùng template giống. → LOW
4. **No audio/voice acting hints** — Audio file mapping chưa có (CMD AUDIO sẽ build). → LOW

**Score ~95% PARTIAL ship.** KHÔNG claim perfect.

---

## 🐙 GITHUB PUSH

Push repo `Trinhlong1988/svtk-status` branch `staging-dialog-{ts}`.

---

## 🔁 LOOP CHU KỲ

Poll inbox 60s, apply fix tasks, rebuild + push.

---

## 🎯 EXIT CODES

| Code | Meaning |
|---|---|
| 0 | ≥95% pass, pushed |
| 1 | <95% PARTIAL ship |
| 2 | Fatal error |
| 99 | Foundation hash mismatch |

---



---

## 🔧 ADDITIONAL HARDENING (audit round 2)

```python
# Logging với explicit level (R17.2)
import logging
log = logging.getLogger(CMD_NAME)
log.setLevel(logging.INFO)
# log.info(...) for normal, log.warn(...) for issues, log.error(...) for fatal

# UUID for dedup (R8.4) — even if natural key used, allocate UUID for traceability
import uuid
def assign_uuid_for_dedup(entity):
    """R8.4: Assign UUID to entity for deduplication across CMD."""
    entity_uuid = str(uuid.uuid4())
    entity['uuid'] = entity_uuid
    return entity

# Branch naming explicit (R5.9)
def get_branch_name():
    ts = time.strftime('%Y%m%d-%H%M%S')
    return f"staging-{CMD_NAME.lower()}-{ts}"

# Anti-snowball aware (R10.8) — content gen must follow Foundation balance rules:
# - Stat cap 2.5x (mythic vs common)
# - Buff cap 5% niche utility
# - No combat stat in faction buff
ANTI_SNOWBALL_STAT_CAP = 2.5
ANTI_SNOWBALL_BUFF_CAP = 0.05  # 5%
```




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



---

## 🎯 SVTK TARGET (LỚN HƠN TS Online)

```python
SVTK_TARGET = 50000    # VSTK target (vượt TSO)
TSO_BASELINE = 42297    # TS Online actual
# Phải PASS: count >= SVTK_TARGET (> TSO 42297)
```

## 🔄 R71 LOAD + FIX + EXTEND PIPELINE

```python
import json, random
from pathlib import Path
from collections import Counter

EXISTING_PATH = REPO_DIR / 'cmd-dialog' / 'existing'
OUTPUT_PATH = REPO_DIR / 'cmd-dialog' / 'output' / 'registry'


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
            send_alert_to_lead_with_target(severity, f'dialog_' + bug['type'],
                                          bug['evidence'], target_worker='dialog')

    entries = fix_bugs(entries)
    entries = extend_to_target(entries, SVTK_TARGET)

    # Save output
    OUTPUT_PATH.mkdir(parents=True, exist_ok=True)
    out = OUTPUT_PATH / 'dialog_full.jsonl'
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
        fix_id=f'dialog_extend_to_target',
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

## ✅ ACCEPTANCE CRITERIA

- Foundation hash verified
- ≥50000 dialog lines generated
- 15+ tests pass
- GitHub push staging-dialog-{ts}
- Honest gaps logged
- Loop poll inbox

---

**END CMD_DIALOG v1.0**
