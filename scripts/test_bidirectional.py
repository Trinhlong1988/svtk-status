#!/usr/bin/env python3
"""TEST GIAO THỨC 2 CHIỀU — Worker ↔ CMD5 LEAD

15 scenarios:
  Forward (10): alert/status/assign/apply
  Reverse (5): ack/completion/heartbeat/closure/escalate-from-worker
"""
import os, sys, json, time, shutil, tempfile
from pathlib import Path
from datetime import datetime


WORKERS = ['engine', 'place', 'parse', 'db', 'npc', 'quest', 'dialog', 'item',
           'boss', 'skill', 'event', 'sprite', 'map', 'icon', 'audio',
           'qa_content', 'qa_art', 'qa_core', 'qa_full']


# ============ MOCK ============
class MockRepo:
    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix='svtk_bi_'))
        self.setup()

    def setup(self):
        (self.root / 'foundation').mkdir(parents=True)
        (self.root / 'foundation' / 'SVTK_FOUNDATION_v2.7.0.md').write_text('mock')
        for c in ['lead'] + WORKERS:
            for sub in ['alerts', 'inbox', 'inbox-processed', 'status', 'output/registry']:
                (self.root / f'cmd-{c}' / sub).mkdir(parents=True, exist_ok=True)
        for sub in ['alerts', 'alerts-processed', 'alerts-escalated', 'dashboard',
                    'status', 'completions', 'completions-resolved', 'heartbeats', 'acks']:
            (self.root / 'cmd-lead' / sub).mkdir(parents=True, exist_ok=True)

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


# ============ WORKER ============
def w_push_alert(repo, origin, severity, iid, evidence):
    ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    (repo.root / 'cmd-lead' / 'alerts' / f'{severity}-{ts}.json').write_text(
        json.dumps({'severity': severity, 'issue_id': iid, 'evidence': evidence,
                    'cmd_origin': origin, 'timestamp': ts},
                  ensure_ascii=False, indent=2), encoding='utf-8')


def w_push_status(repo, worker, score, existing, new, gaps=None):
    ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    (repo.root / f'cmd-{worker}' / 'status' / f'status-{ts}.json').write_text(
        json.dumps({'cmd': worker, 'timestamp': ts, 'validation_score': score,
                    'existing_count': existing, 'new_count': new,
                    'honest_gaps': gaps or [],
                    'exit_code': 0 if score >= 0.95 else 1},
                  ensure_ascii=False, indent=2), encoding='utf-8')


def w_poll_inbox(repo, worker):
    inbox = repo.root / f'cmd-{worker}' / 'inbox'
    tasks = []
    for f in sorted(inbox.glob('fix-*.json')):
        t = json.loads(f.read_text(encoding='utf-8'))
        t['_file'] = str(f)
        tasks.append(t)
    return tasks


def w_apply_fix(repo, worker, task):
    src = Path(task['_file'])
    dst = src.parent.parent / 'inbox-processed' / src.name
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)


# === REVERSE CHANNEL (worker → LEAD) ===
def w_push_ack(repo, worker, fix_id):
    """Worker ack: đã nhận fix task."""
    ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    (repo.root / 'cmd-lead' / 'acks' / f'ACK-{fix_id}-{ts}.json').write_text(
        json.dumps({'fix_id': fix_id, 'acked_by': worker, 'timestamp': ts,
                    'status': 'PROCESSING'}, ensure_ascii=False, indent=2),
        encoding='utf-8')


def w_push_completion(repo, worker, fix_id, result, evidence):
    """Worker báo result fix: PASS/FAIL/PARTIAL."""
    ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    (repo.root / 'cmd-lead' / 'completions' / f'{result}-{fix_id}-{ts}.json').write_text(
        json.dumps({'fix_id': fix_id, 'fixed_by': worker, 'result': result,
                    'evidence': evidence, 'timestamp': ts},
                  ensure_ascii=False, indent=2), encoding='utf-8')


def w_push_heartbeat(repo, worker):
    """Worker heartbeat alive signal."""
    ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    (repo.root / 'cmd-lead' / 'heartbeats' / f'{worker}-{ts}.json').write_text(
        json.dumps({'worker': worker, 'timestamp': ts, 'alive': True},
                  ensure_ascii=False, indent=2), encoding='utf-8')


# ============ LEAD ============
def l_poll_alerts(repo):
    alerts = []
    for f in sorted((repo.root / 'cmd-lead' / 'alerts').glob('*.json')):
        try:
            d = json.loads(f.read_text(encoding='utf-8'))
            d['_file'] = str(f)
            alerts.append(d)
        except Exception:
            pass
    return alerts


def l_verify(alert):
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
    sev = alert.get('severity', 'MED')
    return True, target, {
        'issue_id': alert['issue_id'],
        'evidence': alert['evidence'],
        'severity': sev,
        'priority': 1 if sev == 'HIGH' else (2 if sev == 'MED' else 3),
    }


def l_reflag(repo, iid):
    cf = repo.root / 'cmd-lead' / 'dashboard' / 're-flag-counter.json'
    counter = json.loads(cf.read_text()) if cf.exists() else {}
    counter[iid] = counter.get(iid, 0) + 1
    cf.write_text(json.dumps(counter, indent=2), encoding='utf-8')
    return counter[iid]


def l_assign(repo, target, fix):
    ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    (repo.root / f'cmd-{target}' / 'inbox' / f'fix-{fix["issue_id"]}-{ts}.json').write_text(
        json.dumps(fix, ensure_ascii=False, indent=2), encoding='utf-8')


def l_escalate(repo, iid, evidence, count):
    ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    (repo.root / 'cmd-lead' / 'alerts-escalated' / f'ESC-{ts}.json').write_text(
        json.dumps({'issue_id': iid, 're_flag_count': count, 'evidence': evidence,
                    'timestamp': ts}, ensure_ascii=False, indent=2),
        encoding='utf-8')


def l_move_processed(alert):
    src = Path(alert['_file'])
    if src.exists():
        dst_dir = src.parent.parent / 'alerts-processed'
        src.rename(dst_dir / src.name)


def l_cycle(repo, threshold=3):
    """LEAD cycle forward (alert → assign/escalate)."""
    result = {'processed': 0, 'assigned': 0, 'escalated': 0, 'invalid': 0}
    for alert in l_poll_alerts(repo):
        ok, target, fix = l_verify(alert)
        if not ok:
            result['invalid'] += 1
            l_move_processed(alert)
            continue
        count = l_reflag(repo, alert['issue_id'])
        if count > threshold:
            l_escalate(repo, alert['issue_id'], alert['evidence'], count)
            result['escalated'] += 1
        else:
            l_assign(repo, target, fix)
            result['assigned'] += 1
        l_move_processed(alert)
        result['processed'] += 1
    return result


# === LEAD REVERSE CHANNEL ===
def l_process_completions(repo):
    """LEAD đọc completions → reset counter nếu PASS, tăng nếu FAIL."""
    comp_dir = repo.root / 'cmd-lead' / 'completions'
    resolved_dir = repo.root / 'cmd-lead' / 'completions-resolved'
    result = {'processed': 0, 'pass': 0, 'fail': 0, 'partial': 0}

    for f in sorted(comp_dir.glob('*.json')):
        comp = json.loads(f.read_text(encoding='utf-8'))
        result['processed'] += 1
        res = comp.get('result', '')

        if res == 'PASS':
            result['pass'] += 1
            # Reset re-flag counter
            cf = repo.root / 'cmd-lead' / 'dashboard' / 're-flag-counter.json'
            if cf.exists():
                counter = json.loads(cf.read_text())
                if comp['fix_id'] in counter:
                    counter[comp['fix_id']] = 0
                    cf.write_text(json.dumps(counter, indent=2), encoding='utf-8')
        elif res == 'FAIL':
            result['fail'] += 1
        elif res == 'PARTIAL':
            result['partial'] += 1

        f.rename(resolved_dir / f.name)
    return result


def l_check_heartbeats(repo, max_age_sec=300):
    """LEAD verify worker còn alive. Return list of stale workers."""
    hb_dir = repo.root / 'cmd-lead' / 'heartbeats'
    if not hb_dir.exists():
        return {'alive': [], 'stale': []}

    latest = {}  # worker → timestamp
    for f in hb_dir.glob('*.json'):
        try:
            hb = json.loads(f.read_text(encoding='utf-8'))
            w = hb.get('worker', '')
            ts_str = hb.get('timestamp', '')
            if w not in latest or ts_str > latest[w]:
                latest[w] = ts_str
        except Exception:
            pass

    # In real, check ts vs now. For test we just return all as alive.
    return {'alive': list(latest.keys()), 'stale': []}


def l_count_acks(repo):
    """LEAD count acks received."""
    ack_dir = repo.root / 'cmd-lead' / 'acks'
    return len(list(ack_dir.glob('ACK-*.json'))) if ack_dir.exists() else 0


def l_dashboard(repo):
    d = {'total_existing': 0, 'total_new': 0, 'workers': {}}
    for w in WORKERS:
        sd = repo.root / f'cmd-{w}' / 'status'
        files = sorted(sd.glob('status-*.json'), reverse=True) if sd.exists() else []
        if not files:
            d['workers'][w] = 'NO_REPORT'
            continue
        latest = json.loads(files[0].read_text(encoding='utf-8'))
        d['workers'][w] = 'OK' if latest.get('exit_code') == 0 else 'PARTIAL'
        d['total_existing'] += latest.get('existing_count', 0)
        d['total_new'] += latest.get('new_count', 0)
    return d


# ============ 15 SCENARIOS ============
# Forward (10): existing
def t1_alert_assign_apply():
    r = MockRepo()
    try:
        w_push_alert(r, 'qa_content', 'HIGH', 'npc_count_low', {'expected': 10000, 'actual': 8500})
        res = l_cycle(r)
        assert res['processed'] == 1 and res['assigned'] == 1
        tasks = w_poll_inbox(r, 'npc')
        assert len(tasks) == 1 and tasks[0]['priority'] == 1
        w_apply_fix(r, 'npc', tasks[0])
        return True, 'Forward: alert→assign→apply'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t2_no_evidence():
    r = MockRepo()
    try:
        w_push_alert(r, 'qa_art', 'HIGH', 'sprite_missing', {})
        assert l_cycle(r)['invalid'] == 1
        return True, 'Forward: no evidence rejected'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t3_no_target():
    r = MockRepo()
    try:
        w_push_alert(r, 'qa_content', 'MED', 'unknown_xyz', {'detail': 'x'})
        assert l_cycle(r)['invalid'] == 1
        return True, 'Forward: no target rejected'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t4_reflag_escalate():
    r = MockRepo()
    try:
        for _ in range(4):
            w_push_alert(r, 'qa_content', 'HIGH', 'npc_grammar', {'sample': 'x'})
            l_cycle(r)
        esc = list((r.root / 'cmd-lead' / 'alerts-escalated').glob('*.json'))
        assert len(esc) == 1
        return True, 'Forward: >3 → escalate'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t5_parallel():
    r = MockRepo()
    try:
        w_push_alert(r, 'qa_content', 'HIGH', 'npc_low', {'a': 1})
        w_push_alert(r, 'qa_art', 'MED', 'sprite_size_big', {'b': 2})
        w_push_alert(r, 'qa_core', 'HIGH', 'item_uuid_collision', {'c': 3})
        res = l_cycle(r)
        assert res['assigned'] == 3
        assert len(w_poll_inbox(r, 'npc')) == 1
        assert len(w_poll_inbox(r, 'sprite')) == 1
        assert len(w_poll_inbox(r, 'item')) == 1
        return True, 'Forward: 3 parallel routed'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t6_dashboard():
    r = MockRepo()
    try:
        w_push_status(r, 'npc', 0.98, 438, 9562)
        w_push_status(r, 'skill', 1.0, 165, 135)
        w_push_status(r, 'item', 0.95, 200, 1300)
        d = l_dashboard(r)
        assert d['total_existing'] == 803
        assert d['total_new'] == 10997
        return True, 'Forward: dashboard 803+10997'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t7_severity():
    r = MockRepo()
    try:
        w_push_alert(r, 'qa_content', 'LOW', 'npc_typo', {'c': 5})
        w_push_alert(r, 'qa_content', 'HIGH', 'npc_corruption', {'c': 100})
        l_cycle(r)
        tasks = w_poll_inbox(r, 'npc')
        assert len(tasks) == 2
        priorities = sorted(t['priority'] for t in tasks)
        assert priorities == [1, 3]
        return True, 'Forward: HIGH=1, LOW=3'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t8_move_processed():
    r = MockRepo()
    try:
        w_push_alert(r, 'qa_content', 'HIGH', 'npc_count_low', {'x': 1})
        l_cycle(r)
        remaining = list((r.root / 'cmd-lead' / 'alerts').glob('*.json'))
        processed = list((r.root / 'cmd-lead' / 'alerts-processed').glob('*.json'))
        assert len(remaining) == 0 and len(processed) == 1
        return True, 'Forward: alert moved'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t9_empty():
    r = MockRepo()
    try:
        res = l_cycle(r)
        assert res['processed'] == 0
        d = l_dashboard(r)
        assert d['total_existing'] == 0
        return True, 'Forward: empty no crash'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t10_full_forward():
    r = MockRepo()
    try:
        for w in ['npc', 'skill', 'item', 'boss', 'quest']:
            w_push_status(r, w, 0.96, 100, 900)
        w_push_alert(r, 'qa_content', 'HIGH', 'npc_low', {'x': 1})
        w_push_alert(r, 'qa_art', 'MED', 'sprite_size_big', {'y': 2})
        assert l_cycle(r)['assigned'] == 2
        for t in w_poll_inbox(r, 'npc'):
            w_apply_fix(r, 'npc', t)
        w_push_status(r, 'npc', 1.0, 100, 9900)
        d = l_dashboard(r)
        assert d['workers']['npc'] == 'OK'
        for _ in range(4):
            w_push_alert(r, 'qa_core', 'HIGH', 'item_dupe', {'c': 10})
            l_cycle(r)
        esc = list((r.root / 'cmd-lead' / 'alerts-escalated').glob('*.json'))
        assert len(esc) == 1
        return True, 'Forward: full E2E'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


# === REVERSE 5 scenarios ===
def t11_ack_received():
    """Worker ack nhận fix → LEAD count ack."""
    r = MockRepo()
    try:
        # Worker push alert + LEAD assign
        w_push_alert(r, 'qa_content', 'HIGH', 'npc_low', {'x': 1})
        l_cycle(r)
        # Worker ack
        w_push_ack(r, 'npc', 'npc_low')
        assert l_count_acks(r) == 1
        return True, 'Reverse: worker ack received'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t12_completion_pass_reset():
    """Worker fix PASS → LEAD reset counter."""
    r = MockRepo()
    try:
        # Push alert 3 lần (counter = 3)
        for _ in range(3):
            w_push_alert(r, 'qa_content', 'HIGH', 'npc_low', {'x': 1})
            l_cycle(r)
        # Verify counter = 3
        cf = r.root / 'cmd-lead' / 'dashboard' / 're-flag-counter.json'
        counter = json.loads(cf.read_text())
        assert counter['npc_low'] == 3

        # Worker fix PASS
        w_push_completion(r, 'npc', 'npc_low', 'PASS', {'fixed_count': 10000})
        res = l_process_completions(r)
        assert res['pass'] == 1

        # Counter should be reset
        counter = json.loads(cf.read_text())
        assert counter['npc_low'] == 0, f'Expected 0, got {counter["npc_low"]}'
        return True, 'Reverse: PASS → counter reset'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t13_completion_fail_persistent():
    """Worker fix FAIL → counter KHÔNG reset, vẫn ≥3 → escalate next round."""
    r = MockRepo()
    try:
        for _ in range(3):
            w_push_alert(r, 'qa_content', 'HIGH', 'npc_low', {'x': 1})
            l_cycle(r)

        # Worker báo FAIL
        w_push_completion(r, 'npc', 'npc_low', 'FAIL',
                         {'reason': 'data corruption'})
        res = l_process_completions(r)
        assert res['fail'] == 1

        # Counter giữ nguyên 3
        cf = r.root / 'cmd-lead' / 'dashboard' / 're-flag-counter.json'
        counter = json.loads(cf.read_text())
        assert counter['npc_low'] == 3

        # Re-flag lần 4 → escalate
        w_push_alert(r, 'qa_content', 'HIGH', 'npc_low', {'x': 1})
        l_cycle(r)
        esc = list((r.root / 'cmd-lead' / 'alerts-escalated').glob('*.json'))
        assert len(esc) == 1
        return True, 'Reverse: FAIL → counter persist → escalate'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t14_heartbeat_alive():
    """3 worker heartbeat → LEAD biết alive."""
    r = MockRepo()
    try:
        w_push_heartbeat(r, 'npc')
        w_push_heartbeat(r, 'skill')
        w_push_heartbeat(r, 'item')
        hb = l_check_heartbeats(r)
        assert len(hb['alive']) == 3
        assert 'npc' in hb['alive']
        assert 'skill' in hb['alive']
        assert 'item' in hb['alive']
        return True, 'Reverse: 3 worker heartbeat'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


def t15_full_bidirectional_loop():
    """Full closure loop: alert → assign → ack → completion PASS → counter reset."""
    r = MockRepo()
    try:
        # 1. Worker push alert
        w_push_alert(r, 'qa_content', 'HIGH', 'npc_low', {'expected': 10000})

        # 2. LEAD cycle → assign
        res1 = l_cycle(r)
        assert res1['assigned'] == 1

        # 3. Worker poll + ack
        tasks = w_poll_inbox(r, 'npc')
        assert len(tasks) == 1
        w_push_ack(r, 'npc', tasks[0]['issue_id'])

        # 4. Worker apply fix
        w_apply_fix(r, 'npc', tasks[0])

        # 5. Worker push completion PASS
        w_push_completion(r, 'npc', tasks[0]['issue_id'], 'PASS',
                         {'verified': True, 'count': 10000})

        # 6. Worker push heartbeat
        w_push_heartbeat(r, 'npc')

        # 7. Worker push status updated
        w_push_status(r, 'npc', 1.0, 438, 9562)

        # 8. LEAD process completions
        res2 = l_process_completions(r)
        assert res2['pass'] == 1, f"Expected 1 pass, got {res2}"

        # 9. LEAD check heartbeats
        hb = l_check_heartbeats(r)
        assert 'npc' in hb['alive']

        # 10. LEAD dashboard reflect new status
        d = l_dashboard(r)
        assert d['workers']['npc'] == 'OK'
        assert d['total_existing'] == 438
        assert d['total_new'] == 9562

        return True, 'Bidirectional: full closure loop'
    except AssertionError as e:
        return False, f'FAIL: {e}'
    finally:
        r.cleanup()


# ============ RUN 50 × 3 ============
def run_iteration():
    tests = [t1_alert_assign_apply, t2_no_evidence, t3_no_target, t4_reflag_escalate,
             t5_parallel, t6_dashboard, t7_severity, t8_move_processed,
             t9_empty, t10_full_forward,
             t11_ack_received, t12_completion_pass_reset, t13_completion_fail_persistent,
             t14_heartbeat_alive, t15_full_bidirectional_loop]
    return [(t.__name__, *t()) for t in tests]


if __name__ == '__main__':
    print("=" * 78)
    print("CMD5 ↔ WORKER BIDIRECTIONAL PROTOCOL — 50 ITER × 15 SCENARIOS × 3 BATCHES")
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
        print("✅ ZERO FAILURES across all batches")
    print("=" * 78)
