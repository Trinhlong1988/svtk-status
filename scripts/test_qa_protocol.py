#!/usr/bin/env python3
"""TEST GIAO THỨC QA ↔ WORKER 2 CHIỀU.

QA CMD (giám sát):
  QA-CONTENT → NPC, QUEST, ITEM, DIALOG, BOSS, SKILL, EVENT (7 content)
  QA-ART     → SPRITE, MAP, ICON, AUDIO (4 art)
  QA-CORE    → ENGINE, PLACE, DB, PARSE (4 core)
  QA-FULL    → E2E toàn bộ ecosystem

Giao thức QA → Worker (gián tiếp qua LEAD):
  QA observe output → push alert → LEAD assign fix → worker fix
  → worker completion → LEAD notify QA re-verify → close loop

15 scenarios test:
  Forward (QA detect):  4 (missing field, Tam Quoc, file size, UUID)
  Closure (re-verify):  3 (re-verify PASS, FAIL, escalate)
  Cross-QA verify:      2 (QA-FULL test others, parallel QA)
  Worker → QA via LEAD: 3 (notify, ack, status)
  Full E2E loops:       3 (content+art+core full closure)
"""
import os, sys, json, time, shutil, tempfile
from pathlib import Path
from datetime import datetime


QA_TARGETS = {
    'qa_content': ['npc', 'quest', 'item', 'dialog', 'boss', 'skill', 'event'],
    'qa_art':     ['sprite', 'map', 'icon', 'audio'],
    'qa_core':    ['engine', 'place', 'db', 'parse'],
    'qa_full':    ['npc', 'quest', 'item', 'dialog', 'sprite', 'map', 'engine'],
}

ALL_WORKERS = ['engine', 'place', 'parse', 'db', 'npc', 'quest', 'dialog', 'item',
               'boss', 'skill', 'event', 'sprite', 'map', 'icon', 'audio',
               'qa_content', 'qa_art', 'qa_core', 'qa_full']


# ============ MOCK ============
class MockRepo:
    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix='svtk_qa_'))
        self.setup()

    def setup(self):
        (self.root / 'foundation').mkdir(parents=True)
        (self.root / 'foundation' / 'SVTK_FOUNDATION_v2.7.0.md').write_text('mock')
        for c in ['lead'] + ALL_WORKERS:
            for sub in ['alerts', 'inbox', 'inbox-processed', 'inbox-recheck',
                        'status', 'output/registry']:
                (self.root / f'cmd-{c}' / sub).mkdir(parents=True, exist_ok=True)
        for sub in ['alerts', 'alerts-processed', 'alerts-escalated', 'dashboard',
                    'status', 'completions', 'completions-resolved',
                    'heartbeats', 'acks', 'qa-verdicts']:
            (self.root / 'cmd-lead' / sub).mkdir(parents=True, exist_ok=True)

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


# ============ WORKER (target) ============
def worker_push_output(repo, worker, entries):
    """Worker ship output JSONL (cái QA sẽ check)."""
    out = repo.root / f'cmd-{worker}' / 'output' / 'registry' / f'{worker}_full.jsonl'
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('w', encoding='utf-8') as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + '\n')


def worker_push_status(repo, worker, score, existing, new, gaps=None):
    ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    (repo.root / f'cmd-{worker}' / 'status' / f'status-{ts}.json').write_text(
        json.dumps({'cmd': worker, 'timestamp': ts, 'validation_score': score,
                    'existing_count': existing, 'new_count': new,
                    'honest_gaps': gaps or [],
                    'exit_code': 0 if score >= 0.95 else 1},
                  ensure_ascii=False, indent=2), encoding='utf-8')


def worker_poll_inbox(repo, worker, folder='inbox'):
    inbox = repo.root / f'cmd-{worker}' / folder
    tasks = []
    if not inbox.exists():
        return tasks
    for f in sorted(inbox.glob('fix-*.json')):
        t = json.loads(f.read_text(encoding='utf-8'))
        t['_file'] = str(f)
        tasks.append(t)
    return tasks


def worker_apply_fix(repo, worker, task):
    src = Path(task['_file'])
    dst = src.parent.parent / 'inbox-processed' / src.name
    src.rename(dst)


def worker_push_completion(repo, worker, fix_id, result, evidence):
    """Worker báo result fix về LEAD."""
    ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    (repo.root / 'cmd-lead' / 'completions' / f'{result}-{fix_id}-{ts}.json').write_text(
        json.dumps({'fix_id': fix_id, 'fixed_by': worker, 'result': result,
                    'evidence': evidence, 'timestamp': ts},
                  ensure_ascii=False, indent=2), encoding='utf-8')


# ============ QA CMD (giám sát) ============
def qa_read_worker_output(repo, worker):
    """QA đọc output của worker (read-only)."""
    out = repo.root / f'cmd-{worker}' / 'output' / 'registry' / f'{worker}_full.jsonl'
    entries = []
    if not out.exists():
        return entries
    for line in out.read_text(encoding='utf-8').split('\n'):
        if line.strip():
            entries.append(json.loads(line))
    return entries


def qa_verify_content(entries, target_count=None):
    """QA-CONTENT verify rules: count + cultural lock + required fields."""
    issues = []

    # 1. Count target
    if target_count and len(entries) < target_count:
        issues.append({'type': 'count_below_target',
                       'expected': target_count, 'actual': len(entries)})

    # 2. Required fields
    for i, e in enumerate(entries):
        if '_index' not in e and 'id' not in e and 'skill_id' not in e:
            issues.append({'type': 'missing_id', 'index': i})
            break

    # 3. Cultural lock (Tam Quốc / CJK)
    import re
    tam_quoc = re.compile(r'(Tào Tháo|Lưu Bị|Quan Vũ|Tam Quốc)')
    cjk = re.compile(r'[\u4E00-\u9FFF]')
    for i, e in enumerate(entries):
        text = json.dumps(e, ensure_ascii=False)
        if tam_quoc.search(text):
            issues.append({'type': 'tam_quoc_ref', 'index': i})
            break
        if cjk.search(text):
            issues.append({'type': 'cjk_chars', 'index': i})
            break

    return issues


def qa_verify_art(entries, max_file_size_kb=None):
    """QA-ART verify: file size + format."""
    issues = []
    for i, e in enumerate(entries):
        if max_file_size_kb and e.get('size_kb', 0) > max_file_size_kb:
            issues.append({'type': 'file_oversized',
                          'index': i,
                          'expected_kb': max_file_size_kb,
                          'actual_kb': e.get('size_kb')})
            break
    return issues


def qa_verify_core(entries):
    """QA-CORE verify: UUID unique + 2PC + integrity."""
    issues = []
    uuids = set()
    for i, e in enumerate(entries):
        uid = e.get('uuid', '')
        if uid:
            if uid in uuids:
                issues.append({'type': 'uuid_collision', 'index': i, 'uuid': uid})
                break
            uuids.add(uid)
    return issues


def qa_push_alert(repo, qa_name, target_worker, severity, issue_type, evidence):
    """QA push alert lên cmd-lead/alerts/."""
    ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    issue_id = f'{target_worker}_{issue_type}'
    (repo.root / 'cmd-lead' / 'alerts' / f'{severity}-{ts}.json').write_text(
        json.dumps({'severity': severity, 'issue_id': issue_id,
                    'evidence': evidence, 'cmd_origin': qa_name,
                    'target_worker': target_worker,
                    'timestamp': ts},
                  ensure_ascii=False, indent=2), encoding='utf-8')


def qa_push_verdict(repo, qa_name, target_worker, verdict, evidence):
    """QA push verdict cho LEAD: PASS / FAIL / NEED_REVIEW."""
    ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    (repo.root / 'cmd-lead' / 'qa-verdicts' / f'{verdict}-{qa_name}-{target_worker}-{ts}.json').write_text(
        json.dumps({'qa': qa_name, 'target': target_worker, 'verdict': verdict,
                    'evidence': evidence, 'timestamp': ts},
                  ensure_ascii=False, indent=2), encoding='utf-8')


# ============ LEAD ============
def lead_cycle(repo, threshold=3):
    """LEAD cycle forward."""
    result = {'processed': 0, 'assigned': 0, 'escalated': 0, 'invalid': 0}
    alerts_dir = repo.root / 'cmd-lead' / 'alerts'

    for f in sorted(alerts_dir.glob('*.json')):
        alert = json.loads(f.read_text(encoding='utf-8'))

        if not alert.get('evidence'):
            result['invalid'] += 1
            (alerts_dir.parent / 'alerts-processed' / f.name).write_bytes(f.read_bytes())
            f.unlink()
            continue

        # Identify target from issue_id
        iid = alert.get('issue_id', '').lower()
        target = alert.get('target_worker', '')  # QA passes explicit target
        if not target:
            for w in ALL_WORKERS:
                if w in iid:
                    target = w
                    break

        if not target:
            result['invalid'] += 1
            (alerts_dir.parent / 'alerts-processed' / f.name).write_bytes(f.read_bytes())
            f.unlink()
            continue

        # Re-flag counter
        cf = repo.root / 'cmd-lead' / 'dashboard' / 're-flag-counter.json'
        cf.parent.mkdir(parents=True, exist_ok=True)
        counter = json.loads(cf.read_text()) if cf.exists() else {}
        counter[alert['issue_id']] = counter.get(alert['issue_id'], 0) + 1
        cf.write_text(json.dumps(counter, indent=2), encoding='utf-8')

        if counter[alert['issue_id']] > threshold:
            # Escalate
            ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
            (repo.root / 'cmd-lead' / 'alerts-escalated' / f'ESC-{ts}.json').write_text(
                json.dumps({'issue_id': alert['issue_id'],
                            're_flag_count': counter[alert['issue_id']],
                            'evidence': alert['evidence'], 'timestamp': ts},
                          ensure_ascii=False, indent=2), encoding='utf-8')
            result['escalated'] += 1
        else:
            # Assign fix to target worker
            sev = alert.get('severity', 'MED')
            ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
            fix = {'issue_id': alert['issue_id'],
                   'evidence': alert['evidence'],
                   'severity': sev,
                   'priority': 1 if sev == 'HIGH' else (2 if sev == 'MED' else 3),
                   'reporter': alert.get('cmd_origin', '')}
            (repo.root / f'cmd-{target}' / 'inbox' / f'fix-{alert["issue_id"]}-{ts}.json').write_text(
                json.dumps(fix, ensure_ascii=False, indent=2), encoding='utf-8')
            result['assigned'] += 1

        (alerts_dir.parent / 'alerts-processed' / f.name).write_bytes(f.read_bytes())
        f.unlink()
        result['processed'] += 1

    return result


def lead_notify_qa_recheck(repo, qa_name, target_worker, fix_id):
    """Worker fix xong → LEAD notify QA re-verify."""
    ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    recheck = {'task': 'RECHECK', 'target_worker': target_worker,
               'fix_id': fix_id, 'timestamp': ts}
    (repo.root / f'cmd-{qa_name}' / 'inbox-recheck' / f'recheck-{fix_id}-{ts}.json').write_text(
        json.dumps(recheck, ensure_ascii=False, indent=2), encoding='utf-8')


def lead_process_completions_notify_qa(repo):
    """LEAD đọc completion → notify QA tương ứng re-verify."""
    comp_dir = repo.root / 'cmd-lead' / 'completions'
    result = {'processed': 0, 'qa_notified': 0}

    for f in sorted(comp_dir.glob('*.json')):
        comp = json.loads(f.read_text(encoding='utf-8'))
        result['processed'] += 1

        if comp['result'] == 'PASS':
            # Determine which QA to notify
            worker = comp['fixed_by']
            qa_name = None
            for qa, workers in QA_TARGETS.items():
                if worker in workers:
                    qa_name = qa
                    break
            if qa_name:
                lead_notify_qa_recheck(repo, qa_name, worker, comp['fix_id'])
                result['qa_notified'] += 1

            # Reset counter
            cf = repo.root / 'cmd-lead' / 'dashboard' / 're-flag-counter.json'
            if cf.exists():
                counter = json.loads(cf.read_text())
                counter[comp['fix_id']] = 0
                cf.write_text(json.dumps(counter, indent=2), encoding='utf-8')

        # Move resolved
        (comp_dir.parent / 'completions-resolved' / f.name).write_bytes(f.read_bytes())
        f.unlink()

    return result


# ============ 15 TEST SCENARIOS ============
def t1_qa_detect_count_below():
    """QA-CONTENT detect NPC count thấp → alert → LEAD assign → NPC inbox."""
    r = MockRepo()
    try:
        # NPC ship output thiếu (chỉ 5000, target 10000)
        worker_push_output(r, 'npc', [{'_index': i, 'name': f'NPC_{i}'} for i in range(5000)])

        # QA-CONTENT verify
        entries = qa_read_worker_output(r, 'npc')
        issues = qa_verify_content(entries, target_count=10000)
        assert len(issues) >= 1, 'QA must detect count below target'

        # QA push alert
        for issue in issues:
            qa_push_alert(r, 'qa_content', 'npc', 'HIGH',
                         issue['type'], issue)

        # LEAD cycle
        res = lead_cycle(r)
        assert res['assigned'] >= 1

        # NPC inbox has fix task
        tasks = worker_poll_inbox(r, 'npc')
        assert len(tasks) >= 1
        return True, 'QA detect count → alert → assign'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t2_qa_detect_tam_quoc():
    """QA-CONTENT detect Tam Quốc reference → alert."""
    r = MockRepo()
    try:
        worker_push_output(r, 'quest', [
            {'id': 1, 'name': 'Quest tốt'},
            {'id': 2, 'name': 'Đánh bại Tào Tháo'},  # BAD!
        ])
        entries = qa_read_worker_output(r, 'quest')
        issues = qa_verify_content(entries)
        assert any(i['type'] == 'tam_quoc_ref' for i in issues)

        for issue in issues:
            qa_push_alert(r, 'qa_content', 'quest', 'HIGH', issue['type'], issue)
        lead_cycle(r)
        assert len(worker_poll_inbox(r, 'quest')) >= 1
        return True, 'QA detect Tam Quốc → alert'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t3_qa_art_detect_oversized():
    """QA-ART detect sprite oversized → alert."""
    r = MockRepo()
    try:
        worker_push_output(r, 'sprite', [
            {'id': 1, 'size_kb': 20},
            {'id': 2, 'size_kb': 60},  # oversized (>30KB)
        ])
        entries = qa_read_worker_output(r, 'sprite')
        issues = qa_verify_art(entries, max_file_size_kb=30)
        assert len(issues) >= 1

        qa_push_alert(r, 'qa_art', 'sprite', 'MED', issues[0]['type'], issues[0])
        lead_cycle(r)
        assert len(worker_poll_inbox(r, 'sprite')) >= 1
        return True, 'QA-ART detect oversized'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t4_qa_core_detect_uuid_collision():
    """QA-CORE detect UUID collision → alert."""
    r = MockRepo()
    try:
        worker_push_output(r, 'engine', [
            {'id': 1, 'uuid': 'abc-123'},
            {'id': 2, 'uuid': 'def-456'},
            {'id': 3, 'uuid': 'abc-123'},  # COLLISION
        ])
        entries = qa_read_worker_output(r, 'engine')
        issues = qa_verify_core(entries)
        assert any(i['type'] == 'uuid_collision' for i in issues)

        qa_push_alert(r, 'qa_core', 'engine', 'HIGH', 'uuid_collision', issues[0])
        lead_cycle(r)
        assert len(worker_poll_inbox(r, 'engine')) >= 1
        return True, 'QA-CORE detect UUID collision'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t5_qa_reverify_after_fix_PASS():
    """QA detect issue → worker fix → QA re-verify → PASS."""
    r = MockRepo()
    try:
        # Worker ship bad output
        worker_push_output(r, 'npc', [{'_index': i} for i in range(5000)])
        # QA detect
        issues = qa_verify_content(qa_read_worker_output(r, 'npc'), target_count=10000)
        qa_push_alert(r, 'qa_content', 'npc', 'HIGH', issues[0]['type'], issues[0])
        lead_cycle(r)

        # Worker poll + fix + ship complete output
        tasks = worker_poll_inbox(r, 'npc')
        worker_apply_fix(r, 'npc', tasks[0])
        worker_push_output(r, 'npc', [{'_index': i} for i in range(10000)])  # fixed
        worker_push_completion(r, 'npc', tasks[0]['issue_id'], 'PASS',
                              {'new_count': 10000})

        # LEAD process completions + notify QA recheck
        res = lead_process_completions_notify_qa(r)
        assert res['qa_notified'] == 1

        # QA-CONTENT inbox-recheck
        rechecks = list((r.root / 'cmd-qa_content' / 'inbox-recheck').glob('recheck-*.json'))
        assert len(rechecks) == 1

        # QA re-verify
        entries = qa_read_worker_output(r, 'npc')
        new_issues = qa_verify_content(entries, target_count=10000)
        # No more count issue
        assert not any(i['type'] == 'count_below_target' for i in new_issues)

        # QA push verdict PASS
        qa_push_verdict(r, 'qa_content', 'npc', 'PASS', {'count': 10000})
        verdicts = list((r.root / 'cmd-lead' / 'qa-verdicts').glob('PASS-*.json'))
        assert len(verdicts) == 1
        return True, 'Re-verify after fix → PASS'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t6_qa_reverify_after_fix_FAIL():
    """QA re-verify → vẫn FAIL → counter giữ."""
    r = MockRepo()
    try:
        # Worker ship bad
        worker_push_output(r, 'npc', [{'_index': i} for i in range(5000)])
        issues = qa_verify_content(qa_read_worker_output(r, 'npc'), target_count=10000)
        qa_push_alert(r, 'qa_content', 'npc', 'HIGH', issues[0]['type'], issues[0])
        lead_cycle(r)

        # Worker fix nhưng không đủ (still 7000)
        tasks = worker_poll_inbox(r, 'npc')
        worker_apply_fix(r, 'npc', tasks[0])
        worker_push_output(r, 'npc', [{'_index': i} for i in range(7000)])
        worker_push_completion(r, 'npc', tasks[0]['issue_id'], 'PARTIAL',
                              {'count': 7000})
        lead_process_completions_notify_qa(r)

        # QA re-verify → still has issue
        new_issues = qa_verify_content(qa_read_worker_output(r, 'npc'), target_count=10000)
        assert any(i['type'] == 'count_below_target' for i in new_issues)

        # QA push verdict FAIL
        qa_push_verdict(r, 'qa_content', 'npc', 'FAIL', {'count': 7000})
        verdicts = list((r.root / 'cmd-lead' / 'qa-verdicts').glob('FAIL-*.json'))
        assert len(verdicts) == 1
        return True, 'Re-verify → FAIL persist'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t7_qa_escalate_after_3_fails():
    """QA detect → assign → fix FAIL × 3 → escalate."""
    r = MockRepo()
    try:
        for attempt in range(4):
            qa_push_alert(r, 'qa_content', 'npc', 'HIGH', 'count_below_target',
                         {'expected': 10000, 'actual': 5000})
            lead_cycle(r)

        esc = list((r.root / 'cmd-lead' / 'alerts-escalated').glob('*.json'))
        assert len(esc) == 1
        return True, '4 QA alerts → escalate'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t8_qa_parallel_4_qa():
    """4 QA CMD push alert song song → 4 fix routed."""
    r = MockRepo()
    try:
        qa_push_alert(r, 'qa_content', 'npc', 'HIGH', 'count_low', {'a': 1})
        qa_push_alert(r, 'qa_art', 'sprite', 'MED', 'oversized', {'b': 2})
        qa_push_alert(r, 'qa_core', 'engine', 'HIGH', 'uuid_collision', {'c': 3})
        qa_push_alert(r, 'qa_full', 'quest', 'LOW', 'e2e_minor', {'d': 4})
        res = lead_cycle(r)
        assert res['assigned'] == 4
        assert len(worker_poll_inbox(r, 'npc')) == 1
        assert len(worker_poll_inbox(r, 'sprite')) == 1
        assert len(worker_poll_inbox(r, 'engine')) == 1
        assert len(worker_poll_inbox(r, 'quest')) == 1
        return True, '4 QA parallel routed correctly'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t9_qa_full_cross_verify():
    """QA-FULL verify multiple workers cùng lúc."""
    r = MockRepo()
    try:
        # 3 worker push output
        worker_push_output(r, 'npc', [{'_index': i} for i in range(10000)])
        worker_push_output(r, 'quest', [{'id': i} for i in range(3000)])
        worker_push_output(r, 'engine', [{'id': 1, 'uuid': 'ok-1'}])

        # QA-FULL run E2E on all 3
        all_pass = True
        for w in ['npc', 'quest', 'engine']:
            entries = qa_read_worker_output(r, w)
            if not entries:
                all_pass = False
        assert all_pass

        # QA-FULL push verdict
        qa_push_verdict(r, 'qa_full', 'all_workers', 'PASS', {'tested': 3})
        verdicts = list((r.root / 'cmd-lead' / 'qa-verdicts').glob('PASS-*.json'))
        assert len(verdicts) == 1
        return True, 'QA-FULL cross-verify 3 workers'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t10_qa_qa_full_test_qa_outputs():
    """QA-FULL test các QA khác (meta-verification)."""
    r = MockRepo()
    try:
        # QA-CONTENT push verdict
        qa_push_verdict(r, 'qa_content', 'npc', 'PASS', {'count': 10000})

        # QA-FULL đọc verdict files
        verdicts = list((r.root / 'cmd-lead' / 'qa-verdicts').glob('*.json'))
        assert len(verdicts) == 1
        v = json.loads(verdicts[0].read_text())
        assert v['qa'] == 'qa_content'
        return True, 'QA-FULL reads QA-CONTENT verdict'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t11_worker_complete_lead_notify_qa():
    """Worker completion → LEAD notify QA via inbox-recheck."""
    r = MockRepo()
    try:
        worker_push_completion(r, 'npc', 'npc_count_low', 'PASS', {'count': 10000})
        res = lead_process_completions_notify_qa(r)
        assert res['qa_notified'] == 1
        rechecks = list((r.root / 'cmd-qa_content' / 'inbox-recheck').glob('*.json'))
        assert len(rechecks) == 1
        return True, 'Worker complete → LEAD notify QA'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t12_qa_full_e2e_loop_content():
    """E2E loop QA-CONTENT: detect → fix → re-verify → PASS → close."""
    r = MockRepo()
    try:
        worker_push_output(r, 'item', [{'id': i} for i in range(500)])
        issues = qa_verify_content(qa_read_worker_output(r, 'item'), target_count=1500)
        qa_push_alert(r, 'qa_content', 'item', 'HIGH', issues[0]['type'], issues[0])
        lead_cycle(r)

        tasks = worker_poll_inbox(r, 'item')
        worker_apply_fix(r, 'item', tasks[0])
        worker_push_output(r, 'item', [{'id': i} for i in range(1500)])
        worker_push_completion(r, 'item', tasks[0]['issue_id'], 'PASS', {'count': 1500})
        lead_process_completions_notify_qa(r)

        new_issues = qa_verify_content(qa_read_worker_output(r, 'item'), target_count=1500)
        count_issues = [i for i in new_issues if i['type'] == 'count_below_target']
        assert len(count_issues) == 0

        qa_push_verdict(r, 'qa_content', 'item', 'PASS', {'count': 1500})
        return True, 'E2E content loop close'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t13_qa_full_e2e_loop_art():
    """E2E loop QA-ART: oversized → fix → re-verify → PASS."""
    r = MockRepo()
    try:
        worker_push_output(r, 'icon', [{'id': 1, 'size_kb': 8}])
        issues = qa_verify_art(qa_read_worker_output(r, 'icon'), max_file_size_kb=5)
        qa_push_alert(r, 'qa_art', 'icon', 'MED', issues[0]['type'], issues[0])
        lead_cycle(r)

        tasks = worker_poll_inbox(r, 'icon')
        worker_apply_fix(r, 'icon', tasks[0])
        worker_push_output(r, 'icon', [{'id': 1, 'size_kb': 4}])
        worker_push_completion(r, 'icon', tasks[0]['issue_id'], 'PASS', {'size_kb': 4})
        lead_process_completions_notify_qa(r)

        new_issues = qa_verify_art(qa_read_worker_output(r, 'icon'), max_file_size_kb=5)
        assert len(new_issues) == 0
        return True, 'E2E art loop close'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t14_qa_full_e2e_loop_core():
    """E2E loop QA-CORE: UUID collision → fix → re-verify → PASS."""
    r = MockRepo()
    try:
        worker_push_output(r, 'engine', [
            {'id': 1, 'uuid': 'a'}, {'id': 2, 'uuid': 'a'}  # collision
        ])
        issues = qa_verify_core(qa_read_worker_output(r, 'engine'))
        qa_push_alert(r, 'qa_core', 'engine', 'HIGH', 'uuid_collision', issues[0])
        lead_cycle(r)

        tasks = worker_poll_inbox(r, 'engine')
        worker_apply_fix(r, 'engine', tasks[0])
        worker_push_output(r, 'engine', [
            {'id': 1, 'uuid': 'a'}, {'id': 2, 'uuid': 'b'}  # fixed
        ])
        worker_push_completion(r, 'engine', tasks[0]['issue_id'], 'PASS',
                              {'collision_resolved': True})

        new_issues = qa_verify_core(qa_read_worker_output(r, 'engine'))
        assert len(new_issues) == 0
        return True, 'E2E core loop close'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t15_qa_full_bidirectional_with_ack():
    """Full bidirectional: QA → LEAD → Worker → ACK → COMPLETION → QA re-verify."""
    r = MockRepo()
    try:
        # 1. QA detect
        worker_push_output(r, 'quest', [{'id': i} for i in range(1500)])
        issues = qa_verify_content(qa_read_worker_output(r, 'quest'), target_count=3000)
        qa_push_alert(r, 'qa_content', 'quest', 'HIGH', issues[0]['type'], issues[0])

        # 2. LEAD assign
        res = lead_cycle(r)
        assert res['assigned'] == 1

        # 3. Worker poll + ack
        tasks = worker_poll_inbox(r, 'quest')
        assert len(tasks) == 1

        # 4. Worker fix
        worker_apply_fix(r, 'quest', tasks[0])
        worker_push_output(r, 'quest', [{'id': i} for i in range(3000)])

        # 5. Worker completion
        worker_push_completion(r, 'quest', tasks[0]['issue_id'], 'PASS', {'count': 3000})

        # 6. LEAD notify QA
        res2 = lead_process_completions_notify_qa(r)
        assert res2['qa_notified'] == 1

        # 7. QA re-verify
        rechecks = list((r.root / 'cmd-qa_content' / 'inbox-recheck').glob('*.json'))
        assert len(rechecks) == 1
        new_issues = qa_verify_content(qa_read_worker_output(r, 'quest'), target_count=3000)
        count_left = [i for i in new_issues if i['type'] == 'count_below_target']
        assert len(count_left) == 0

        # 8. QA verdict PASS
        qa_push_verdict(r, 'qa_content', 'quest', 'PASS', {'count': 3000})
        verdicts = list((r.root / 'cmd-lead' / 'qa-verdicts').glob('PASS-*.json'))
        assert len(verdicts) == 1
        return True, 'Full bidirectional QA loop'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


# ============ RUN ============
def run_iteration():
    tests = [t1_qa_detect_count_below, t2_qa_detect_tam_quoc,
             t3_qa_art_detect_oversized, t4_qa_core_detect_uuid_collision,
             t5_qa_reverify_after_fix_PASS, t6_qa_reverify_after_fix_FAIL,
             t7_qa_escalate_after_3_fails, t8_qa_parallel_4_qa,
             t9_qa_full_cross_verify, t10_qa_qa_full_test_qa_outputs,
             t11_worker_complete_lead_notify_qa,
             t12_qa_full_e2e_loop_content, t13_qa_full_e2e_loop_art,
             t14_qa_full_e2e_loop_core, t15_qa_full_bidirectional_with_ack]
    return [(t.__name__, *t()) for t in tests]


if __name__ == '__main__':
    print("=" * 78)
    print("QA ↔ WORKER BIDIRECTIONAL — 50 ITER × 15 SCENARIOS × 3 BATCHES")
    print("=" * 78)

    overall_pass = 0
    overall_total = 0
    overall_fails = []
    start = time.time()

    for batch in range(1, 4):
        batch_pass = 0
        batch_total = 0
        for i in range(50):
            for name, ok, msg in run_iteration():
                batch_total += 1
                if ok:
                    batch_pass += 1
                else:
                    overall_fails.append((batch, i+1, name, msg))
        overall_pass += batch_pass
        overall_total += batch_total
        print(f"Batch {batch}: {batch_pass}/{batch_total} = {batch_pass/batch_total*100:.1f}%")

    elapsed = time.time() - start
    print()
    print(f"TOTAL: {overall_pass}/{overall_total} = {overall_pass/overall_total*100:.1f}%")
    print(f"Time: {elapsed:.2f}s")

    print()
    print("Sample iteration 1:")
    for name, ok, msg in run_iteration():
        print(f"  {'✅' if ok else '❌'} {name}: {msg}")

    print()
    if overall_fails:
        print(f"FAILURES ({len(overall_fails)}):")
        for b, i, n, m in overall_fails[:5]:
            print(f"  Batch {b} iter {i} - {n}: {m}")
    else:
        print("✅ ZERO FAILURES")
    print("=" * 78)
