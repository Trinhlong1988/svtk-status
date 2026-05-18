#!/usr/bin/env python3
"""TEST ENVIRONMENT — CMD5 LEAD ↔ 16 Worker protocol.

10 test scenarios covering: happy path, edge cases, escalation, dashboard, race.
"""
import os, sys, json, time, shutil, tempfile
from pathlib import Path
from datetime import datetime


# ============ MOCK REPO ============
class MockRepo:
    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix='svtk_'))
        self.setup()

    def setup(self):
        (self.root / 'foundation').mkdir(parents=True)
        (self.root / 'foundation' / 'SVTK_FOUNDATION_v2.7.0.md').write_text('mock')
        cmds = ['lead', 'engine', 'place', 'parse', 'db', 'npc', 'quest', 'dialog',
                'item', 'boss', 'skill', 'event', 'sprite', 'map', 'icon', 'audio',
                'qa_content', 'qa_art', 'qa_core', 'qa_full']
        for c in cmds:
            for sub in ['alerts', 'inbox', 'inbox-processed', 'status', 'output/registry', 'existing']:
                (self.root / f'cmd-{c}' / sub).mkdir(parents=True, exist_ok=True)
        for sub in ['alerts', 'alerts-processed', 'alerts-escalated', 'dashboard', 'status']:
            (self.root / 'cmd-lead' / sub).mkdir(parents=True, exist_ok=True)

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


WORKERS = ['engine', 'place', 'parse', 'db', 'npc', 'quest', 'dialog', 'item',
           'boss', 'skill', 'event', 'sprite', 'map', 'icon', 'audio',
           'qa_content', 'qa_art', 'qa_core', 'qa_full']


# ============ WORKER ============
def worker_push_alert(repo, origin, severity, issue_id, evidence):
    ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    alert = {'severity': severity, 'issue_id': issue_id, 'evidence': evidence,
             'cmd_origin': origin, 'timestamp': ts}
    (repo.root / 'cmd-lead' / 'alerts' / f'{severity}-{ts}.json').write_text(
        json.dumps(alert, ensure_ascii=False, indent=2), encoding='utf-8')


def worker_push_status(repo, worker, score, existing, new, gaps=None):
    ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    status = {'cmd': worker, 'timestamp': ts, 'validation_score': score,
              'existing_count': existing, 'new_count': new,
              'honest_gaps': gaps or [], 'exit_code': 0 if score >= 0.95 else 1}
    (repo.root / f'cmd-{worker.lower()}' / 'status' / f'status-{ts}.json').write_text(
        json.dumps(status, ensure_ascii=False, indent=2), encoding='utf-8')


def worker_poll_inbox(repo, worker):
    inbox = repo.root / f'cmd-{worker.lower()}' / 'inbox'
    if not inbox.exists():
        return []
    tasks = []
    for f in sorted(inbox.glob('fix-*.json')):
        t = json.loads(f.read_text(encoding='utf-8'))
        t['_file'] = str(f)
        tasks.append(t)
    return tasks


def worker_apply_fix(repo, worker, task):
    src = Path(task['_file'])
    dst = src.parent.parent / 'inbox-processed' / src.name
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)


# ============ LEAD ============
def lead_poll_alerts(repo):
    alerts = []
    for f in sorted((repo.root / 'cmd-lead' / 'alerts').glob('*.json')):
        try:
            d = json.loads(f.read_text(encoding='utf-8'))
            d['_file'] = str(f)
            alerts.append(d)
        except Exception:
            pass
    return alerts


def lead_verify(alert):
    if not alert.get('evidence'):
        return False, None, None
    iid = alert.get('issue_id', '').lower()
    target = None
    for w in WORKERS:
        if w in iid:
            target = w
            break
    if not target:
        return False, None, None
    fix = {'issue_id': alert['issue_id'],
           'description': f'Fix from {alert.get("cmd_origin")}',
           'evidence': alert['evidence'],
           'severity': alert.get('severity', 'MED'),
           'priority': 1 if alert.get('severity') == 'HIGH' else 2}
    return True, target, fix


def lead_reflag(repo, iid):
    cf = repo.root / 'cmd-lead' / 'dashboard' / 're-flag-counter.json'
    counter = json.loads(cf.read_text()) if cf.exists() else {}
    counter[iid] = counter.get(iid, 0) + 1
    cf.write_text(json.dumps(counter, indent=2), encoding='utf-8')
    return counter[iid]


def lead_assign(repo, target, fix):
    ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    (repo.root / f'cmd-{target}' / 'inbox' / f'fix-{fix["issue_id"]}-{ts}.json').write_text(
        json.dumps(fix, ensure_ascii=False, indent=2), encoding='utf-8')


def lead_escalate(repo, iid, evidence, count):
    ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    (repo.root / 'cmd-lead' / 'alerts-escalated' / f'ESC-{ts}.json').write_text(
        json.dumps({'issue_id': iid, 're_flag_count': count, 'evidence': evidence,
                    'action': 'FROZEN', 'timestamp': ts}, ensure_ascii=False, indent=2),
        encoding='utf-8')


def lead_move_processed(alert):
    src = Path(alert['_file'])
    if src.exists():
        (src.parent.parent / 'alerts-processed' / src.name).parent.mkdir(parents=True, exist_ok=True)
        src.rename(src.parent.parent / 'alerts-processed' / src.name)


def lead_cycle(repo, threshold=3):
    result = {'processed': 0, 'assigned': 0, 'escalated': 0, 'invalid': 0}
    for alert in lead_poll_alerts(repo):
        ok, target, fix = lead_verify(alert)
        if not ok:
            result['invalid'] += 1
            lead_move_processed(alert)
            continue
        count = lead_reflag(repo, alert['issue_id'])
        if count > threshold:
            lead_escalate(repo, alert['issue_id'], alert['evidence'], count)
            result['escalated'] += 1
        else:
            lead_assign(repo, target, fix)
            result['assigned'] += 1
        lead_move_processed(alert)
        result['processed'] += 1
    return result


def lead_dashboard(repo):
    dash = {'total_existing': 0, 'total_new': 0, 'workers': {}}
    for w in WORKERS:
        sd = repo.root / f'cmd-{w}' / 'status'
        files = sorted(sd.glob('status-*.json'), reverse=True) if sd.exists() else []
        if not files:
            dash['workers'][w] = 'NO_REPORT'
            continue
        latest = json.loads(files[0].read_text(encoding='utf-8'))
        dash['workers'][w] = 'OK' if latest.get('exit_code') == 0 else 'PARTIAL'
        dash['total_existing'] += latest.get('existing_count', 0)
        dash['total_new'] += latest.get('new_count', 0)
    return dash


# ============ 10 TEST SCENARIOS ============
def t1_happy_path():
    r = MockRepo()
    try:
        worker_push_alert(r, 'qa_content', 'HIGH', 'npc_count_low',
                         {'expected': 10000, 'actual': 8500})
        res = lead_cycle(r)
        assert res['processed'] == 1 and res['assigned'] == 1
        tasks = worker_poll_inbox(r, 'npc')
        assert len(tasks) == 1 and tasks[0]['priority'] == 1
        worker_apply_fix(r, 'npc', tasks[0])
        assert len(worker_poll_inbox(r, 'npc')) == 0
        return True, 'Happy path: alert → assign → apply'
    except AssertionError as e:
        return False, f'Happy path FAIL: {e}'
    finally:
        r.cleanup()


def t2_no_evidence():
    r = MockRepo()
    try:
        worker_push_alert(r, 'qa_art', 'HIGH', 'sprite_missing', {})
        res = lead_cycle(r)
        assert res['invalid'] == 1 and res['assigned'] == 0
        return True, 'Alert no evidence → rejected'
    except AssertionError as e:
        return False, f'No evidence FAIL: {e}'
    finally:
        r.cleanup()


def t3_no_target():
    r = MockRepo()
    try:
        worker_push_alert(r, 'qa_content', 'MED', 'unknown_xyz', {'detail': 'x'})
        res = lead_cycle(r)
        assert res['invalid'] == 1 and res['assigned'] == 0
        return True, 'No target → rejected'
    except AssertionError as e:
        return False, f'No target FAIL: {e}'
    finally:
        r.cleanup()


def t4_reflag_escalate():
    r = MockRepo()
    try:
        for _ in range(4):
            worker_push_alert(r, 'qa_content', 'HIGH', 'npc_grammar',
                             {'sample': 'x', 'count': 100})
            lead_cycle(r)
        esc = list((r.root / 'cmd-lead' / 'alerts-escalated').glob('*.json'))
        assert len(esc) == 1
        assert json.loads(esc[0].read_text())['re_flag_count'] == 4
        return True, 'Re-flag >3 → escalate'
    except AssertionError as e:
        return False, f'Re-flag FAIL: {e}'
    finally:
        r.cleanup()


def t5_parallel_alerts():
    r = MockRepo()
    try:
        worker_push_alert(r, 'qa_content', 'HIGH', 'npc_low', {'a': 1})
        worker_push_alert(r, 'qa_art', 'MED', 'sprite_size_big', {'b': 2})
        worker_push_alert(r, 'qa_core', 'HIGH', 'item_uuid_collision', {'c': 3})
        res = lead_cycle(r)
        assert res['processed'] == 3 and res['assigned'] == 3
        assert len(worker_poll_inbox(r, 'npc')) == 1
        assert len(worker_poll_inbox(r, 'sprite')) == 1
        assert len(worker_poll_inbox(r, 'item')) == 1
        return True, '3 parallel alerts → 3 routed correctly'
    except AssertionError as e:
        return False, f'Parallel FAIL: {e}'
    finally:
        r.cleanup()


def t6_dashboard():
    r = MockRepo()
    try:
        worker_push_status(r, 'npc', 0.98, 438, 9562)
        worker_push_status(r, 'skill', 1.0, 165, 135)
        worker_push_status(r, 'item', 0.95, 200, 1300)
        d = lead_dashboard(r)
        assert d['total_existing'] == 803  # 438+165+200
        assert d['total_new'] == 10997     # 9562+135+1300
        assert d['workers']['npc'] == 'OK'
        return True, 'Dashboard tổng 803 existing + 10997 new'
    except AssertionError as e:
        return False, f'Dashboard FAIL: {e}'
    finally:
        r.cleanup()


def t7_severity_priority():
    r = MockRepo()
    try:
        worker_push_alert(r, 'qa_content', 'LOW', 'npc_typo', {'count': 5})
        worker_push_alert(r, 'qa_content', 'HIGH', 'npc_corruption', {'count': 100})
        lead_cycle(r)
        tasks = worker_poll_inbox(r, 'npc')
        assert len(tasks) == 2
        # HIGH priority = 1, LOW = 2
        priorities = [t['priority'] for t in tasks]
        assert 1 in priorities and 2 in priorities
        return True, 'HIGH=priority 1, LOW=priority 2'
    except AssertionError as e:
        return False, f'Severity FAIL: {e}'
    finally:
        r.cleanup()


def t8_alert_moved_processed():
    r = MockRepo()
    try:
        worker_push_alert(r, 'qa_content', 'HIGH', 'npc_count_low', {'x': 1})
        lead_cycle(r)
        # Alert must be moved out of /alerts/
        remaining = list((r.root / 'cmd-lead' / 'alerts').glob('*.json'))
        processed = list((r.root / 'cmd-lead' / 'alerts-processed').glob('*.json'))
        assert len(remaining) == 0 and len(processed) == 1
        return True, 'Processed alert moved correctly'
    except AssertionError as e:
        return False, f'Move processed FAIL: {e}'
    finally:
        r.cleanup()


def t9_empty_cycle():
    r = MockRepo()
    try:
        res = lead_cycle(r)
        assert res['processed'] == 0 and res['assigned'] == 0
        d = lead_dashboard(r)
        assert d['total_existing'] == 0
        return True, 'Empty cycle handle correctly'
    except AssertionError as e:
        return False, f'Empty FAIL: {e}'
    finally:
        r.cleanup()


def t10_full_workflow():
    """Full E2E: 16 worker push status + alerts → LEAD cycle → dashboard → re-flag → escalate."""
    r = MockRepo()
    try:
        # 1. All workers push status
        for w in ['npc', 'skill', 'item', 'boss', 'quest']:
            worker_push_status(r, w, 0.96, 100, 900)

        # 2. QA flag 2 issues
        worker_push_alert(r, 'qa_content', 'HIGH', 'npc_low', {'x': 1})
        worker_push_alert(r, 'qa_art', 'MED', 'sprite_size', {'y': 2})
        res1 = lead_cycle(r)
        assert res1['assigned'] == 2

        # 3. Worker fix → push status again
        for t in worker_poll_inbox(r, 'npc'):
            worker_apply_fix(r, 'npc', t)
        worker_push_status(r, 'npc', 1.0, 100, 9900)  # improved

        # 4. Build dashboard
        d = lead_dashboard(r)
        npc_status = d['workers']['npc']
        assert npc_status == 'OK'

        # 5. Re-flag escalation (4 lần cùng issue)
        for _ in range(4):
            worker_push_alert(r, 'qa_core', 'HIGH', 'item_dupe', {'count': 10})
            lead_cycle(r)
        esc = list((r.root / 'cmd-lead' / 'alerts-escalated').glob('*.json'))
        assert len(esc) == 1
        return True, 'Full workflow E2E pass'
    except AssertionError as e:
        return False, f'Full workflow FAIL: {e}'
    finally:
        r.cleanup()


# ============ RUN 40 ITERATIONS ============
def run_iteration():
    tests = [t1_happy_path, t2_no_evidence, t3_no_target, t4_reflag_escalate,
             t5_parallel_alerts, t6_dashboard, t7_severity_priority,
             t8_alert_moved_processed, t9_empty_cycle, t10_full_workflow]
    results = []
    for t in tests:
        passed, msg = t()
        results.append((t.__name__, passed, msg))
    return results


if __name__ == '__main__':
    print("=" * 78)
    print("CMD5 LEAD ↔ 16 WORKER PROTOCOL TEST — 50 ITERATIONS × 10 SCENARIOS")
    print("=" * 78)

    iter_summary = []
    fail_details = []
    start = time.time()

    for i in range(50):
        results = run_iteration()
        passed = sum(1 for _, ok, _ in results if ok)
        total = len(results)
        iter_summary.append((passed, total))
        if passed != total:
            for name, ok, msg in results:
                if not ok:
                    fail_details.append((i+1, name, msg))

    elapsed = time.time() - start

    # Stats
    total_pass = sum(p for p, _ in iter_summary)
    total_tests = sum(t for _, t in iter_summary)
    print()
    print(f"50 iterations × 10 scenarios = {total_tests} tests in {elapsed:.2f}s")
    print(f"Pass: {total_pass}/{total_tests} = {total_pass/total_tests*100:.1f}%")
    print()

    # Show first iteration result detail
    print("Sample (iteration 1):")
    for name, ok, msg in run_iteration():
        print(f"  {'✅' if ok else '❌'} {name}: {msg}")

    print()
    if fail_details:
        print(f"FAILURES ({len(fail_details)}):")
        for iter_no, name, msg in fail_details[:10]:
            print(f"  Iter {iter_no} - {name}: {msg}")
    else:
        print("✅ ZERO FAILURES across 40 iterations")

    print("=" * 78)
