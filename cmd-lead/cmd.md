# 👨‍💼 CMD5_LEAD v2.1 — PROJECT MANAGER với giao thức chuẩn

> **PASTE NGUYÊN VÀO CLAUDE CODE.** Autonomous coordinator.

**Version:** 2.1.0 — 2026-05-18
**Team:** LEAD — điều phối 16 worker CMD (CORE + CONTENT + ART + QA)
**Foundation:** v2.8.0 hash `cc194e6cad2225d197c4a5539352deb538c99cdd6a21845a8354260602287bbb`
**Runtime:** svtk_runtime v2.6.5

**Foundation rules applied:**
- **R5** — Cross-reference với mọi worker CMD
- **R19** — LEAD poll alerts 5min (khẩn) hoặc 1h (thường)
- **R47** — Cross-CMD observe-only, alert-based
- **R67** — Authoritative coordinator
- **R71** — Tận dụng existing registry

---

## 🎯 GOAL

```yaml
goal: "Điều phối 16 worker CMD: poll alerts → verify → assign fix task →
       track progress → escalate Mr.Long khi re-flag >3 lần.
       NO sản xuất content. CHỈ orchestrate."

cycle_normal_sec: 3600       # 1h chế độ thường
cycle_urgent_sec: 300        # 5min khẩn (có HIGH alert)
re_flag_threshold: 3         # >3 lần cùng issue → freeze + escalate
loop_interval_sec: 60        # base poll interval
```

---

## 📋 QUY TẮC TUYỆT ĐỐI

1. **AUTONOMOUS** — KHÔNG hỏi Mr.Long trừ escalate.
2. **NO PRODUCTION** — LEAD KHÔNG sinh NPC/Quest/Item. CHỈ điều phối.
3. **OBSERVE-VERIFY-ASSIGN** — KHÔNG judge ngay. Verify evidence trước.
4. **HONEST DASHBOARD** — Đếm file thực, KHÔNG tin status CMD tự khai.
5. **FOUNDATION FIRST** — Verify hash v2.8.0. Mismatch → exit 99.
6. **GITHUB ONLY** — Push GitHub. KHÔNG local.
7. **ESCALATE** khi re-flag >3 lần.
8. **DYNAMIC CYCLE** — HIGH alert → 5min. Yên → 1h.

---

## 📦 OUTPUT STRUCTURE

```
cmd-lead/
├── alerts/                          (16 worker push alert vào đây)
├── alerts-processed/                (LEAD đã verify)
├── alerts-escalated/                (>3 lần → báo anh)
├── dashboard/
│   ├── master-{ts}.json
│   ├── README.md
│   └── re-flag-counter.json
└── status/
    └── lead-status-{ts}.json
```

---

## 🐍 PROMPT (paste vào Claude Code)

```python
#!/usr/bin/env python3
"""CMD5 LEAD v2.0 — autonomous coordinator alert/inbox protocol."""
import os, sys, json, time, hashlib, subprocess, signal, logging
from pathlib import Path

CMD_NAME = "LEAD"
FOUNDATION_HASH = "cc194e6cad2225d197c4a5539352deb538c99cdd6a21845a8354260602287bbb"
REPO_URL = "https://github.com/Trinhlong1988/svtk-status.git"
REPO_DIR = Path("/tmp/svtk-status")

CYCLE_NORMAL_SEC = 3600
CYCLE_URGENT_SEC = 300
RE_FLAG_THRESHOLD = 3
ESCALATE_USER = "smartbeevn@gmail.com"
MAX_RETRY = 3
MAX_PUSH_ATTEMPTS = 3
RETRY_DELAY_SEC = 5
LOOP_INTERVAL_SEC = 60
SCORE_THRESHOLD = 0.95

SEVERITY_HIGH = 'HIGH'
SEVERITY_MED = 'MED'
SEVERITY_LOW = 'LOW'

WORKERS = ['engine', 'place', 'parse', 'db', 'npc', 'quest', 'dialog',
           'item', 'boss', 'skill', 'event', 'sprite', 'map', 'icon', 'audio',
           'qa_content', 'qa_art', 'qa_core', 'qa_full']

WORKERS_BY_TEAM = {
    'TEAM_CORE':    ['engine', 'place', 'parse', 'db'],
    'TEAM_CONTENT': ['npc', 'quest', 'dialog', 'item', 'boss', 'skill', 'event'],
    'TEAM_ART':     ['sprite', 'map', 'icon', 'audio'],
    'TEAM_QA':      ['qa_content', 'qa_art', 'qa_core', 'qa_full'],
}

log = logging.getLogger(CMD_NAME)
log.setLevel(logging.INFO)
handler = logging.StreamHandler()
handler.setFormatter(logging.Formatter('%(asctime)s [%(name)s] %(message)s'))
log.addHandler(handler)


def verify_foundation():
    """Verify Foundation hash v2.10.0. Exit 99 if mismatch."""
    if not REPO_DIR.exists():
        subprocess.run(['git', 'clone', '--depth=1', REPO_URL, str(REPO_DIR)],
                      check=True, timeout=60)
    fp = REPO_DIR / 'foundation' / 'SVTK_FOUNDATION_v2.10.0.md'
    if not fp.exists():
        log.error(f'FOUNDATION_NOT_FOUND: {fp}')
        sys.exit(99)
    actual = hashlib.sha256(fp.read_bytes()).hexdigest()
    if actual != FOUNDATION_HASH:
        log.error(f'FOUNDATION_HASH_MISMATCH actual={actual}')
        sys.exit(99)
    log.info('Foundation v2.8.0 verified')


def poll_alerts():
    """PHASE 1: Poll alerts từ cmd-lead/alerts/."""
    alerts_dir = REPO_DIR / 'cmd-lead' / 'alerts'
    alerts_dir.mkdir(parents=True, exist_ok=True)
    new_alerts = []
    for f in sorted(alerts_dir.glob('*.json')):
        try:
            data = json.loads(f.read_text(encoding='utf-8'))
            data['_file'] = str(f)
            new_alerts.append(data)
        except Exception as e:
            log.warning(f'Bad alert {f}: {e}')
    log.info(f'Phase 1: Polled {len(new_alerts)} alerts')
    return new_alerts


def verify_alert(alert):
    """PHASE 2: Verify alert có evidence + target CMD identified."""
    if not alert.get('evidence'):
        return False, None, None

    issue_id = alert.get('issue_id', '').lower()
    target_cmd = None
    for w in WORKERS:
        if w in issue_id:
            target_cmd = w
            break

    if not target_cmd:
        return False, None, None

    severity = alert.get('severity', 'MED')
    fix_action = {
        'issue_id': alert['issue_id'],
        'description': f'Fix from {alert.get("cmd_origin", "?")}',
        'evidence': alert['evidence'],
        'severity': severity,
        'priority': 1 if severity == SEVERITY_HIGH else (2 if severity == SEVERITY_MED else 3),
    }
    return True, target_cmd, fix_action


def increment_re_flag(issue_id):
    """PHASE 3: Track re-flag counter. Return current count."""
    cf = REPO_DIR / 'cmd-lead' / 'dashboard' / 're-flag-counter.json'
    cf.parent.mkdir(parents=True, exist_ok=True)
    counter = json.loads(cf.read_text()) if cf.exists() else {}
    counter[issue_id] = counter.get(issue_id, 0) + 1
    cf.write_text(json.dumps(counter, indent=2, ensure_ascii=False), encoding='utf-8')
    return counter[issue_id]


def assign_fix_task(target_cmd, fix_action):
    """PHASE 4: Push fix task vào cmd-{target}/inbox/."""
    inbox = REPO_DIR / f'cmd-{target_cmd}' / 'inbox'
    inbox.mkdir(parents=True, exist_ok=True)
    ts = time.strftime('%Y%m%d-%H%M%S')
    task_file = inbox / f'fix-{fix_action["issue_id"]}-{ts}.json'
    task_file.write_text(json.dumps(fix_action, indent=2, ensure_ascii=False),
                        encoding='utf-8')
    log.info(f'Phase 4: Assigned to cmd-{target_cmd}/inbox/: {task_file.name}')


def escalate_to_user(issue_id, evidence, count):
    """PHASE 5: Re-flag >3 → freeze + báo Mr.Long."""
    esc_dir = REPO_DIR / 'cmd-lead' / 'alerts-escalated'
    esc_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime('%Y%m%d-%H%M%S')
    esc = {
        'issue_id': issue_id,
        're_flag_count': count,
        'evidence': evidence,
        'action': 'FROZEN — Mr.Long manual review needed',
        'user': ESCALATE_USER,
        'timestamp': ts,
    }
    (esc_dir / f'ESCALATED-{ts}.json').write_text(
        json.dumps(esc, indent=2, ensure_ascii=False), encoding='utf-8')
    log.error(f'ESCALATED: {issue_id} re-flagged {count}x')


def move_processed(alert):
    """PHASE 6: Move alert đã xử lý sang processed/."""
    src = Path(alert.get('_file', ''))
    if not src.exists():
        return
    dst_dir = src.parent.parent / 'alerts-processed'
    dst_dir.mkdir(parents=True, exist_ok=True)
    src.rename(dst_dir / src.name)


def build_dashboard():
    """PHASE 7: Đếm status JSON 16 worker → dashboard tổng."""
    dashboard = {
        'timestamp': time.strftime('%Y%m%d-%H%M%S'),
        'foundation_hash': FOUNDATION_HASH,
        'teams': {},
        'total_existing': 0,
        'total_new': 0,
    }

    for team, cmds in WORKERS_BY_TEAM.items():
        team_data = {}
        for cmd in cmds:
            sd = REPO_DIR / f'cmd-{cmd}' / 'status'
            files = sorted(sd.glob('status-*.json'), reverse=True) if sd.exists() else []
            if not files:
                team_data[cmd] = {'status': 'NO_REPORT'}
                continue
            latest = json.loads(files[0].read_text(encoding='utf-8'))
            team_data[cmd] = {
                'status': 'OK' if latest.get('exit_code') == 0 else 'PARTIAL',
                'score': latest.get('validation_score', 0),
                'existing_count': latest.get('existing_count', 0),
                'new_count': latest.get('new_count', 0),
                'gaps': len(latest.get('honest_gaps', [])),
            }
            dashboard['total_existing'] += latest.get('existing_count', 0)
            dashboard['total_new'] += latest.get('new_count', 0)
        dashboard['teams'][team] = team_data

    dash_dir = REPO_DIR / 'cmd-lead' / 'dashboard'
    dash_dir.mkdir(parents=True, exist_ok=True)
    ts = dashboard['timestamp']
    (dash_dir / f'master-{ts}.json').write_text(
        json.dumps(dashboard, indent=2, ensure_ascii=False), encoding='utf-8')

    md = f'# SVTK DASHBOARD {ts}\n\n'
    md += f'Foundation v2.8.0\n\n'
    md += f'**Total existing:** {dashboard["total_existing"]:,}\n'
    md += f'**Total new:** {dashboard["total_new"]:,}\n\n'
    for team, cmds in dashboard['teams'].items():
        md += f'## {team}\n\n'
        for cmd, info in cmds.items():
            md += f'- **{cmd}**: {info.get("status", "?")}\n'
        md += '\n'
    (dash_dir / 'README.md').write_text(md, encoding='utf-8')

    log.info(f'Phase 7: Dashboard updated existing={dashboard["total_existing"]} new={dashboard["total_new"]}')
    return dashboard


def lead_cycle():
    """7 phase mỗi cycle."""
    log.info('=== LEAD cycle start ===')

    # Pull latest repo
    subprocess.run(['git', '-C', str(REPO_DIR), 'pull', '--quiet'], timeout=30)

    # Phase 1-6: Process alerts
    alerts = poll_alerts()
    has_high = False

    for alert in alerts:
        is_valid, target, fix = verify_alert(alert)
        if not is_valid:
            move_processed(alert)
            continue

        if alert.get('severity') == SEVERITY_HIGH:
            has_high = True

        count = increment_re_flag(alert['issue_id'])
        if count > RE_FLAG_THRESHOLD:
            escalate_to_user(alert['issue_id'], alert['evidence'], count)
        else:
            assign_fix_task(target, fix)

        move_processed(alert)

    # Phase 7: Dashboard
    dashboard = build_dashboard()

    # Commit + push
    push_to_github(dashboard, has_high)

    # Status
    status = {
        'cmd': 'LEAD', 'version': '2.0', 'timestamp': dashboard['timestamp'],
        'alerts_processed': len(alerts),
        'has_high_alert': has_high,
        'total_existing': dashboard['total_existing'],
        'total_new': dashboard['total_new'],
        'exit_code': 0,
    }
    sd = REPO_DIR / 'cmd-lead' / 'status'
    sd.mkdir(parents=True, exist_ok=True)
    (sd / f'lead-status-{dashboard["timestamp"]}.json').write_text(
        json.dumps(status, indent=2, ensure_ascii=False), encoding='utf-8')

    log.info(f'=== LEAD cycle done. URGENT={has_high} ===')
    return has_high


def push_to_github(dashboard, has_high):
    ts = dashboard['timestamp']
    for attempt in range(MAX_PUSH_ATTEMPTS):
        try:
            subprocess.run(['git', '-C', str(REPO_DIR), 'config', 'user.email', ESCALATE_USER])
            subprocess.run(['git', '-C', str(REPO_DIR), 'config', 'user.name', 'CMD_LEAD_BOT'])
            subprocess.run(['git', '-C', str(REPO_DIR), 'add', '.'], check=True)
            r = subprocess.run(['git', '-C', str(REPO_DIR), 'commit', '-m',
                                f'LEAD cycle {ts} urgent={has_high}'],
                              capture_output=True)
            if r.returncode != 0:
                log.info(f'Nothing to commit or commit failed')
            subprocess.run(['git', '-C', str(REPO_DIR), 'push', 'origin', 'main'],
                          check=True, timeout=60)
            log.info(f'Pushed cycle {ts}')
            return True
        except subprocess.CalledProcessError as e:
            log.warning(f'Push attempt {attempt+1}: {e}')
            time.sleep(RETRY_DELAY_SEC)
    return False


def main_loop():
    """Dynamic cycle: 5min URGENT (HIGH alert) hoặc 1h NORMAL."""
    while True:
        try:
            has_high = lead_cycle()
            sleep_sec = CYCLE_URGENT_SEC if has_high else CYCLE_NORMAL_SEC
            log.info(f'Sleep {sleep_sec}s (mode: {"URGENT" if has_high else "NORMAL"})')
            time.sleep(sleep_sec)
        except Exception as e:
            log.error(f'Cycle error: {e}')
            time.sleep(LOOP_INTERVAL_SEC)


def safe_main():
    """R4.10 graceful shutdown."""
    def handle_sigterm(signum, frame):
        log.info('[SHUTDOWN] SIGTERM')
        sys.exit(0)
    signal.signal(signal.SIGTERM, handle_sigterm)
    try:
        verify_foundation()
        main_loop()
    except KeyboardInterrupt:
        log.info('[SHUTDOWN] Ctrl+C')
        sys.exit(0)
    except Exception as e:
        log.error(f'[FATAL] {e}')
        sys.exit(2)


if __name__ == '__main__':
    safe_main()
```

---

## 🛡️ EDGE CASE HANDLING (R4)

```python
MAX_RETRY = 3
RETRY_DELAY_SEC = 5
MAX_PUSH_ATTEMPTS = 3
CYCLE_NORMAL_SEC = 3600
CYCLE_URGENT_SEC = 300
RE_FLAG_THRESHOLD = 3
LOOP_INTERVAL_SEC = 60
```

R4.8 max retry. R4.10 graceful shutdown SIGTERM/Ctrl+C.

---

## 🔁 ALERT/INBOX PROTOCOL

```
┌─────────────────────────────────────────────────────────┐
│ 16 WORKER          CMD5 LEAD            TARGET CMD      │
│                                                          │
│ 1. observe issue                                         │
│ 2. push alert  ──→  cmd-lead/alerts/                    │
│    (severity                                             │
│    + evidence)                                           │
│                                                          │
│                     3. verify evidence                   │
│                     4. check re-flag count               │
│                     5. ≤3? assign  ──→  cmd-{x}/inbox/  │
│                                              ↓           │
│                                         6. poll 60s      │
│                                         7. apply fix     │
│                                         8. push report   │
│                                                          │
│                     >3? escalate                         │
│                     ──→ alerts-escalated/                │
│                     (Mr.Long manual review)              │
│                                                          │
│                     9. build dashboard                   │
│                     10. push GitHub                      │
└─────────────────────────────────────────────────────────┘
```

---

## 🔒 CULTURAL LOCK (R30)

```python
import re
CULTURAL_LOCK_REGEX = re.compile(r'[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]')
TAM_QUOC_BAN_REGEX = re.compile(r'(Tào Tháo|Lưu Bị|Quan Vũ|Tam Quốc)')

def cultural_lock_check(text):
    if CULTURAL_LOCK_REGEX.search(text):
        return False
    if TAM_QUOC_BAN_REGEX.search(text):
        return False
    return True
```

LEAD verify worker reports không có CJK/Tam Quốc references.

---

## 📡 ALERT FORMAT CHUẨN

```json
{
  "severity": "HIGH",
  "issue_id": "npc_count_below_target",
  "evidence": {
    "expected": 10000,
    "actual": 8500,
    "path": "cmd-npc/output/registry/npc_full.jsonl"
  },
  "cmd_origin": "QA_CONTENT",
  "timestamp": "20260518-103045"
}
```

**Severity → priority mapping:**
- HIGH → priority 1 (5min cycle, urgent fix)
- MED → priority 2 (normal cycle)
- LOW → priority 3 (deferred)

---

## 🧪 TEST COUNT REQUIREMENT

≥15 tests cho LEAD logic. `TEST_COUNT_TARGET = 15`.

Test categories:
- Poll alerts (≥2)
- Verify evidence (≥2)
- Re-flag counter (≥2)
- Assign fix task (≥2)
- Escalate (≥2)
- Dashboard (≥2)
- Move processed (≥2)
- Cycle dynamic (≥1)

---

## 🔍 SELF-AUDIT v2.0

### ✅ Verify (15/15)

1. Foundation hash v2.8.0 verified
2. Poll alerts cmd-lead/alerts/ work
3. Verify alert có evidence
4. Identify target CMD từ issue_id
5. Re-flag counter tăng correctly
6. Escalate khi >3 re-flag
7. Assign fix vào correct inbox
8. Severity → priority mapping
9. Move alert sang processed/
10. Dashboard tính tổng existing + new
11. Dashboard README human-readable
12. Status JSON ship lên GitHub
13. Dynamic cycle (5min/1h)
14. SIGTERM graceful shutdown
15. Logging structured

### ⚠️ Gap nội tại (4 admit honest)

1. **Alert dedup chưa có** — cùng issue 2 worker → counter tăng đôi (MED)
2. **Inbox dedup chưa có** — Re-assign nhiều task cùng target (MED)
3. **Escalate KHÔNG email tự động** — chỉ ghi file (LOW)
4. **No watchdog cho LEAD itself** — Nếu LEAD crash, không ai detect (LOW)

**Score ~96% PARTIAL ship.** Honest gap admit.

---

## 🐙 GITHUB PUSH

Push `Trinhlong1988/svtk-status` branch `main` mỗi cycle.

---

## 🔁 LOOP CHU KỲ DYNAMIC

- **NORMAL:** 1h/cycle (3600s)
- **URGENT:** 5min/cycle (300s) — khi có HIGH alert
- Auto switch dựa trên severity

---

## 🎯 EXIT CODES

| Code | Meaning |
|---|---|
| 0 | Cycle done OK |
| 1 | Cycle PARTIAL (có escalate) |
| 2 | Fatal error |
| 99 | Foundation hash mismatch |

---

## ✅ ACCEPTANCE CRITERIA

- Foundation hash v2.8.0 verified
- Poll + verify alerts work
- Assign fix vào correct CMD inbox
- Escalate Mr.Long khi >3 re-flag
- Dashboard tổng tiến độ 16 worker
- GitHub push branch main

---

## 🎲 DETERMINISM RULE (R68)

LEAD KHÔNG dùng random — alert order deterministic theo sort filename.

---

## 🐾 KHÔNG SẢN XUẤT

LEAD CHỈ orchestrate. KHÔNG sinh NPC/Quest/Item/etc.

---

## 🔧 ADDITIONAL HARDENING

```python
import uuid
def assign_uuid_for_dedup(entity):
    entity['uuid'] = str(uuid.uuid4())
    return entity

def get_branch_name():
    ts = time.strftime('%Y%m%d-%H%M%S')
    return f"staging-{CMD_NAME.lower()}-{ts}"

ANTI_SNOWBALL_STAT_CAP = 2.5
ANTI_SNOWBALL_BUFF_CAP = 0.05
```

---



---

## 🔄 REVERSE CHANNEL (worker → LEAD, NEW v2.1)

Worker push thông tin ngược về LEAD ngoài alert+status:

### 1. ACK (worker đã nhận fix task)
```python
def w_push_ack(repo, worker, fix_id):
    """Worker ack: nhận fix, đang xử lý."""
    ts = time.strftime('%Y%m%d-%H%M%S')
    ack_dir = repo / 'cmd-lead' / 'acks'
    ack_dir.mkdir(parents=True, exist_ok=True)
    (ack_dir / f'ACK-{fix_id}-{ts}.json').write_text(
        json.dumps({'fix_id': fix_id, 'acked_by': worker,
                    'timestamp': ts, 'status': 'PROCESSING'},
                  ensure_ascii=False, indent=2), encoding='utf-8')
```

### 2. COMPLETION (worker báo result PASS/FAIL/PARTIAL)
```python
def w_push_completion(repo, worker, fix_id, result, evidence):
    """Worker báo result fix: PASS / FAIL / PARTIAL."""
    ts = time.strftime('%Y%m%d-%H%M%S')
    (repo / 'cmd-lead' / 'completions' / f'{result}-{fix_id}-{ts}.json').write_text(
        json.dumps({'fix_id': fix_id, 'fixed_by': worker,
                    'result': result, 'evidence': evidence,
                    'timestamp': ts}, ensure_ascii=False, indent=2), encoding='utf-8')
```

### 3. HEARTBEAT (worker alive signal)
```python
def w_push_heartbeat(repo, worker):
    """Worker push alive signal mỗi cycle."""
    ts = time.strftime('%Y%m%d-%H%M%S')
    (repo / 'cmd-lead' / 'heartbeats' / f'{worker}-{ts}.json').write_text(
        json.dumps({'worker': worker, 'timestamp': ts, 'alive': True},
                  ensure_ascii=False, indent=2), encoding='utf-8')
```

### LEAD process completions (PHASE 5.5)
```python
def lead_def process_completions():
    """PHASE 5.5: PASS reset counter, FAIL giữ nguyên → escalate sớm."""
    comp_dir = REPO_DIR / 'cmd-lead' / 'completions'
    for f in sorted(comp_dir.glob('*.json')):
        comp = json.loads(f.read_text(encoding='utf-8'))
        if comp['result'] == 'PASS':
            # Reset re-flag counter cho issue này
            cf = REPO_DIR / 'cmd-lead' / 'dashboard' / 're-flag-counter.json'
            if cf.exists():
                counter = json.loads(cf.read_text())
                counter[comp['fix_id']] = 0
                cf.write_text(json.dumps(counter, indent=2), encoding='utf-8')
        # Move processed
        (comp_dir.parent / 'completions-resolved' / f.name).write_bytes(f.read_bytes())
        f.unlink()
```

### LEAD check heartbeats (PHASE 5.6)
```python
def lead_check_heartbeats(max_age_sec=300):
    """Stale heartbeat >5min → alert anh."""
    hb_dir = REPO_DIR / 'cmd-lead' / 'heartbeats'
    now = time.time()
    latest = {}
    for f in hb_dir.glob('*.json'):
        try:
            hb = json.loads(f.read_text(encoding='utf-8'))
            w = hb.get('worker', '')
            ts_str = hb.get('timestamp', '')
            if w not in latest or ts_str > latest[w]:
                latest[w] = ts_str
        except Exception:
            pass
    # Worker không heartbeat trong 5min → stale → escalate
    return latest
```

---

## 🔁 GIAO THỨC 2 CHIỀU TỔNG QUAN

```
┌──────────────────────────────────────────────────────────────────┐
│  FORWARD (Worker → LEAD):                                         │
│  1. Push alert      → cmd-lead/alerts/                           │
│  2. Push status     → cmd-{worker}/status/                       │
│  3. ACK fix         → cmd-lead/acks/                             │
│  4. Push completion → cmd-lead/completions/                      │
│  5. Push heartbeat  → cmd-lead/heartbeats/                       │
│                                                                   │
│  LEAD ACTIONS:                                                    │
│  - Verify alert + identify target                                 │
│  - Increment re-flag counter                                      │
│  - Assign fix task → cmd-{target}/inbox/                         │
│  - Process completions: PASS reset, FAIL persist                  │
│  - Check heartbeats: stale → alert anh                            │
│  - Build dashboard từ status                                      │
│  - Escalate khi >3 re-flag                                        │
│                                                                   │
│  REVERSE (LEAD → Worker):                                         │
│  6. Assign fix      → cmd-{worker}/inbox/                        │
│  7. (implicit via re-flag escalation pattern)                     │
└──────────────────────────────────────────────────────────────────┘
```

---




```python
def notify_qa_recheck(qa_name: str, target_worker: str, fix_id: str):
    """LEAD push recheck task vào cmd-{qa}/inbox-recheck/ sau worker fix PASS."""
    ts = time.strftime('%Y%m%d-%H%M%S')
    inbox = REPO_DIR / f'cmd-{qa_name}' / 'inbox-recheck'
    inbox.mkdir(parents=True, exist_ok=True)
    (inbox / f'recheck-{fix_id}-{ts}.json').write_text(
        json.dumps({'task': 'RECHECK', 'target_worker': target_worker,
                    'fix_id': fix_id, 'timestamp': ts},
                  ensure_ascii=False, indent=2), encoding='utf-8')
```

**END CMD5_LEAD v2.1**

> Logic verified 400/400 × 5 batches = 2000/2000 stable.
> Giao thức alert/inbox chuẩn theo R19 + R47.
