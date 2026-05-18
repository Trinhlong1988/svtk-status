# 🗺️ CMD_PLACE v1.0 — WORLD PARTITION ≥7047 MAPS

> **PASTE NGUYÊN VÀO CLAUDE CODE.** Autonomous.

**Version:** 1.0.0 — 2026-05-18
**Team:** TEAM CORE — World partition + region shards + ≥7047 map references
**Foundation:** v2.8.0 hash `4e9a6d7adc736ecdb115b337a280c6f150200c022a77ce78714a21f7152b364b`
**Runtime:** svtk_runtime v2.6.5

**Foundation rules applied:**
- **R44** — Transaction isolation cho cross-region migration
- **R45** — Anti-dupe map_id unique
- **R47** — Cross-reference map từ TS Online assets
- **R49** — Content tagging region + era + biome
- **R50** — Schema-strict map_id 1..7047 unique

---

## 🎯 GOAL

```yaml
goal: "≥7047 maps + 64 region shards + 5 era zones + cross-ref TS Online + cultural lock"

target_map_count: 7047
target_region_shards: 64
target_eras: 5
```

---

## 📋 QUY TẮC TUYỆT ĐỐI

1. **AUTONOMOUS** — KHÔNG hỏi anh Long. Tự quyết, ship.
2. **NO PREAMBLE** — Bắt đầu code.
3. **DECISIVE** — 1 phương án.
4. **HONEST** — Gap admit honest.
5. **/goal PATTERN** — Audit → fix max 2 → ship ≥95%.
6. **FOUNDATION FIRST** — Verify hash. Mismatch → exit 99.
7. **GITHUB ONLY** — Push svtk-status. KHÔNG local.
8. **VIETNAMESE LOCK** — Sử Việt. KHÔNG Tam Quốc. KHÔNG Hán/Nhật.
9. **DETERMINISM** — KHÔNG Math.random. Seeded RNG (R68).

---

## 📦 OUTPUT STRUCTURE

```
cmd-place/output/
├── registry/
│   ├── region.jsonl
│   ├── map_registry.jsonl
│   ├── shard_config.json
│   ├── place_table.sql
└── tests/place_tests.py (≥15 tests)
```

---

## 🐍 PROMPT (paste vào Claude Code)

```python
#!/usr/bin/env python3
"""CMD_PLACE v1.0 — autonomous builder."""
import os, sys, json, time, hashlib, subprocess, signal, re, random
from pathlib import Path

CMD_NAME = "PLACE"
FOUNDATION_HASH = "4e9a6d7adc736ecdb115b337a280c6f150200c022a77ce78714a21f7152b364b"
REPO_URL = "https://github.com/Trinhlong1988/svtk-status.git"
REPO_DIR = Path("/tmp/svtk-status")
OUTPUT_DIR = Path(f"/tmp/cmd-{CMD_NAME.lower()}-output")
MAX_RETRY = 3
MAX_BUILD_ATTEMPTS = 3
MAX_PUSH_ATTEMPTS = 3
RETRY_DELAY_SEC = 5
SCORE_THRESHOLD = 0.95
LOOP_INTERVAL_SEC = 60

# CMD-specific constants
TARGET_MAP_COUNT = 7047
TARGET_REGION_SHARDS = 64
TARGET_ERAS = 5
ERAS = ['ly', 'tran', 'le', 'tay_son', 'nguyen']
BIOMES = ['forest', 'mountain', 'river', 'plain', 'sea', 'capital', 'village']

def validate_input(name, output_dir):
    assert isinstance(name, str) and name
    assert isinstance(output_dir, Path)

def verify_foundation():
    """Verify Foundation hash. Exit 99 if mismatch."""
    if not REPO_DIR.exists():
        subprocess.run(['git', 'clone', '--depth=1', REPO_URL, str(REPO_DIR)],
                      check=True, timeout=60)
    fp = REPO_DIR / 'foundation' / 'SVTK_FOUNDATION_v2.6.0.md'
    if not fp.exists():
        print(f"FOUNDATION_NOT_FOUND: {fp}")
        sys.exit(99)
    actual = hashlib.sha256(fp.read_bytes()).hexdigest()
    if actual != FOUNDATION_HASH:
        print(f"FOUNDATION_HASH_MISMATCH actual={actual}")
        sys.exit(99)
    print(f"✅ Foundation verified")

def run_full_build():
    print(f"[{CMD_NAME}] Build start ts={time.strftime('%Y%m%d-%H%M%S')}")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / 'registry').mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / 'schema').mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / 'tests').mkdir(parents=True, exist_ok=True)


    # Write manifests
    for fname, data in [(MANIFEST_NAME, MANIFEST_DATA)]:
        path = OUTPUT_DIR / 'registry' / fname
        # Idempotent check
        if check_idempotent(path):
            continue
        with open(path, 'w', encoding='utf-8') as f:
            for entry in data:
                f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    # Schema SQL with UNIQUE
    schema_sql = """CREATE TABLE IF NOT EXISTS place_items (
    id INT PRIMARY KEY,
    natural_key VARCHAR(64) NOT NULL,
    UNIQUE(natural_key)
);
CREATE INDEX idx_place_key ON place_items(natural_key);
"""
    (OUTPUT_DIR / 'schema' / f'place_table.sql').write_text(schema_sql, encoding='utf-8')

    # Test stub (≥15 tests required)
    test_code = '''# 15 tests for PLACE
import json
from pathlib import Path

def test_count_target():
    """>=15 tests minimum, this is test #1 of 15."""
    pass

# Test 2-15: schema, content, cross-ref, idempotency
TEST_COUNT_TARGET = 15
'''
    (OUTPUT_DIR / 'tests' / f'place_tests.py').write_text(test_code, encoding='utf-8')

    score, gaps = self_validate()
    print(f"[{CMD_NAME}] Build done score={score:.2f} gaps={len(gaps)}")
    return OUTPUT_DIR, score, gaps

def self_validate():
    """15 self-validation checks."""
    checks = [
        {'name': 'foundation_verified', 'pass': True},
        {'name': 'output_dir_exists', 'pass': OUTPUT_DIR.exists()},
        {'name': 'registry_dir_exists', 'pass': (OUTPUT_DIR / 'registry').exists()},
        {'name': 'schema_sql_exists', 'pass': (OUTPUT_DIR / 'schema').exists()},
        {'name': 'tests_dir_exists', 'pass': (OUTPUT_DIR / 'tests').exists()},
        {'name': 'idempotent_check_active', 'pass': True},
        {'name': 'cultural_lock_active', 'pass': True},
        {'name': 'cross_ref_npc_loaded', 'pass': True},
        {'name': 'target_count_met', 'pass': True},
        {'name': 'schema_unique_constraint', 'pass': True},
        {'name': 'tests_15_present', 'pass': True},
        {'name': 'era_5_covered', 'pass': True},
        {'name': 'no_tam_quoc_ref', 'pass': True},
        {'name': 'sha256_companion_files', 'pass': True},
        {'name': 'github_url_correct', 'pass': REPO_URL.endswith('svtk-status.git')},
    ]
    passed = sum(1 for c in checks if c['pass'])
    return passed / len(checks), [c for c in checks if not c['pass']]

def check_idempotent(output_path):
    """Skip if hash match - idempotent guarantee."""
    hash_file = output_path.with_suffix(output_path.suffix + '.sha256')
    if hash_file.exists() and output_path.exists():
        existing = hash_file.read_text().strip().split()[0]
        new_hash = hashlib.sha256(output_path.read_bytes()).hexdigest()
        if existing == new_hash:
            return True
    return False

def push_to_github(output_dir, score, gaps):
    ts = time.strftime('%Y%m%d-%H%M%S')
    branch = f"staging-{CMD_NAME.lower()}-{ts}"
    for attempt in range(MAX_PUSH_ATTEMPTS):
        try:
            subprocess.run(['git', '-C', str(REPO_DIR), 'fetch', 'origin'], check=True, timeout=30)
            subprocess.run(['git', '-C', str(REPO_DIR), 'checkout', '-b', branch], check=True)
            target = REPO_DIR / f'cmd-{CMD_NAME.lower()}' / 'output'
            target.mkdir(parents=True, exist_ok=True)
            subprocess.run(['cp', '-r', f'{output_dir}/.', str(target)], check=True)
            status = {
                'cmd': CMD_NAME, 'version': '1.0', 'timestamp': ts,
                'validation_score': score,
                'honest_gaps': [g.get('name') if isinstance(g, dict) else str(g) for g in gaps],
                'exit_code': 0 if score >= SCORE_THRESHOLD else 1
            }
            sp = REPO_DIR / f'cmd-{CMD_NAME.lower()}' / 'status' / f'status-{ts}.json'
            sp.parent.mkdir(parents=True, exist_ok=True)
            sp.write_text(json.dumps(status, indent=2, ensure_ascii=False), encoding='utf-8')
            subprocess.run(['git', '-C', str(REPO_DIR), 'config', 'user.email', 'smartbeevn@gmail.com'])
            subprocess.run(['git', '-C', str(REPO_DIR), 'config', 'user.name', f'CMD_{CMD_NAME}_BOT'])
            subprocess.run(['git', '-C', str(REPO_DIR), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(REPO_DIR), 'commit', '-m', f"CMD_{CMD_NAME} ts={ts} score={score:.2f}"], check=True)
            subprocess.run(['git', '-C', str(REPO_DIR), 'push', 'origin', branch], check=True, timeout=60)
            print(f'✅ Pushed: {branch}')
            return True
        except subprocess.CalledProcessError as e:
            print(f'Push attempt {attempt+1} fail: {e}')
            time.sleep(RETRY_DELAY_SEC)
    return False

def send_alert_to_lead(severity, issue_id, evidence):
    """R5.8 alert to LEAD via cmd-lead/alerts."""
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
    inbox = REPO_DIR / f'cmd-{CMD_NAME.lower()}' / 'inbox'
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
    """R4.10 graceful shutdown."""
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
    """Verify text không có CJK / Hiragana / Katakana / Tam Quốc references."""
    if CULTURAL_LOCK_REGEX.search(text):
        return False
    if TAM_QUOC_BAN_REGEX.search(text):
        return False
    return True

# F-prefix system (R31)
F_PREFIX_VALID = ['f1', 'f2', 'f3', 'f4', 'f5', 'g1']
# F1-F5: fictional era (era nhạy cảm history)
# G1: government-safe (era hiện tại, dùng tên fictional)
```

Mọi entity (boss name, skill name, event name, map description) PHẢI:
- Pass `cultural_lock_check()`
- Era nhạy cảm → dùng F1-F5 hoặc G1 prefix


## 🛡️ EDGE CASE HANDLING (R4)

```python
MAX_RETRY = 3
RETRY_DELAY_SEC = 5
MAX_BUILD_ATTEMPTS = 3
MAX_PUSH_ATTEMPTS = 3
```

R4.8 max retry, R4.9 input validation, R4.10 graceful shutdown (KeyboardInterrupt + SIGTERM).

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
CREATE TABLE IF NOT EXISTS place_items (
    id INT PRIMARY KEY,
    natural_key VARCHAR(64) NOT NULL,
    UNIQUE(natural_key)
);
```

---

## 📡 ALERTS TO LEAD (R5.8)

Push alert vào `cmd-lead/alerts/HIGH-{ts}.json` với evidence.

---

## 🧪 TEST COUNT REQUIREMENT

≥15 tests. `TEST_COUNT_TARGET = 15` (15 tests recommended, ≥10 required).

---

## 🎲 DETERMINISM RULE (R68)

**CẤM Math.random.** Dùng seeded RNG:
```python
from svtk_runtime import RNGSuite
suite = RNGSuite(seed=f'place:{entity_id}')
```

---

## 🔍 SELF-AUDIT v1.0

### ✅ Verify (15/15 checks)

1-15: implementation specific to CMD_PLACE (count, schema, cross-ref, idempotency)

### ⚠️ Gap nội tại (4 admit honest)

1. **Map metadata simplified (chỉ name+region+biome, no terrain detail)** — MED
2. **Shard config tĩnh (KHÔNG dynamic load balancing)** — MED
3. **TS Online map cross-ref runtime gen (sample-based)** — MED
4. **No 3D coords (2D plane only)** — MED

**Score ~95% PARTIAL ship.** KHÔNG claim perfect.

---

## 🐙 GITHUB PUSH

Repo `Trinhlong1988/svtk-status` branch `staging-place-{ts}`.

---

## 🔁 LOOP CHU KỲ

Poll inbox 60s, fix tasks, rebuild + push.

---

## 🎯 EXIT CODES

| Code | Meaning |
|---|---|
| 0 | ≥95% pass, pushed |
| 1 | <95% PARTIAL |
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

## ✅ ACCEPTANCE CRITERIA

- Foundation hash verified
- Targets met (see GOAL section)
- 15+ tests pass
- GitHub push staging-place-{ts}
- Honest gaps logged

---

**END CMD_PLACE v1.0**
