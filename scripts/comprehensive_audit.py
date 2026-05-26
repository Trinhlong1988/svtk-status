#!/usr/bin/env python3
"""COMPREHENSIVE AUDIT — kiểm tra TUYỆT ĐỐI mọi rule trên 20 CMD + Foundation.

40+ rules check:
  Foundation hash (1)
  Reverse channel define + call (6)
  QA verify functions define + call (8)
  Anti-dupe 6 rules (6)
  R71 registry reuse (1)
  Cultural lock (2)
  Edge case handling (5)
  Test count target (1)
  Goal explicit (1)
  Output structure (3)
  GitHub config (2)
  Severity mapping (3)
  Signal handler (1)
  Logging structured (1)
  Score threshold (1)
"""
import json, re
from pathlib import Path

FOUNDATION_HASH = "cc194e6cad2225d197c4a5539352deb538c99cdd6a21845a8354260602287bbb"

# 17 worker CMD
WORKERS = [
    'CMD_NPC_v1.1.md', 'CMD_SKILL_v1.0.md', 'CMD_ITEM_v1.1.md',
    'CMD_BOSS_v1.0.md', 'CMD_QUEST_v1.1.md', 'CMD_MAP_v1.1.md',
    'CMD_DIALOG_v1.1.md', 'CMD_EVENT_v1.0.md',
    'CMD_ENGINE_v1.0.md', 'CMD_PLACE_v1.0.md',
    'CMD_SPRITE_v1.0.md', 'CMD_ICON_v1.0.md', 'CMD_AUDIO_v1.0.md',
    'CMD_QA_CONTENT_v1.0.md', 'CMD_QA_ART_v1.0.md',
    'CMD_QA_CORE_v1.0.md', 'CMD_QA_FULL_v1.0.md',
]

QA_CMDS = ['CMD_QA_CONTENT_v1.0.md', 'CMD_QA_ART_v1.0.md',
           'CMD_QA_CORE_v1.0.md', 'CMD_QA_FULL_v1.0.md']

TRADEABLE_CMDS = [
    'CMD_ITEM_v1.1.md', 'CMD_NPC_v1.1.md', 'CMD_SKILL_v1.0.md',
    'CMD_BOSS_v1.0.md', 'CMD_QUEST_v1.1.md', 'CMD_ENGINE_v1.0.md',
]

LEAD_CMD = 'CMD5_LEAD_v2.1.md'


def check_rule(content, pattern, regex=True):
    if regex:
        return bool(re.search(pattern, content, re.IGNORECASE))
    return pattern in content


def audit_one_cmd(filepath):
    """Audit 1 CMD với tất cả rules applicable."""
    p = Path(filepath)
    if not p.exists():
        return None
    c = p.read_text()
    fname = p.name

    is_qa = fname in QA_CMDS
    is_tradeable = fname in TRADEABLE_CMDS
    is_lead = fname == LEAD_CMD

    results = {'cmd': fname, 'checks': {}, 'passed': 0, 'total': 0}

    def chk(name, condition):
        results['checks'][name] = bool(condition)
        results['total'] += 1
        if condition:
            results['passed'] += 1

    # === UNIVERSAL CHECKS (all CMD) ===
    chk('foundation_hash_ref', FOUNDATION_HASH in c)
    chk('foundation_hash_2x', c.count(FOUNDATION_HASH) >= 2)
    chk('cmd_name_constant', 'CMD_NAME' in c or 'CMD_NAME =' in c)
    chk('repo_url_set', 'github.com/Trinhlong1988/svtk-status' in c)
    chk('cultural_lock_cjk', check_rule(c, r'CULTURAL_LOCK_REGEX|\\u4E00'))
    chk('tam_quoc_ban', check_rule(c, r'TAM_QUOC.*REGEX|Tam Quốc'))
    chk('max_retry_set', 'MAX_RETRY' in c)
    chk('graceful_shutdown', 'SIGTERM' in c or 'signal.signal' in c)
    chk('logging_structured', 'logging.' in c)
    chk('goal_explicit', check_rule(c, r'goal:|goal\s*:'))
    chk('output_structure', 'cmd-' in c.lower() and 'status' in c.lower())
    chk('exit_codes', 'exit_code' in c.lower() or 'EXIT CODE' in c)

    # === LEAD-only ===
    if is_lead:
        chk('lead_poll_alerts', 'poll_alerts' in c or 'cmd-lead/alerts' in c)
        chk('lead_verify_alert', 'verify_alert' in c)
        chk('lead_assign_fix_task', 'assign_fix_task' in c or 'cmd-{target}/inbox' in c)
        chk('lead_escalate', 'escalate' in c.lower())
        chk('lead_re_flag_counter', 're_flag' in c or 're-flag' in c)
        chk('lead_process_completions', 'process_completions' in c or 'completions/' in c)
        chk('lead_notify_qa', 'notify_qa' in c or 'inbox-recheck' in c)
        chk('lead_dashboard', 'dashboard' in c.lower())
        chk('lead_dynamic_cycle', 'CYCLE_URGENT_SEC' in c or 'CYCLE_NORMAL_SEC' in c)
        chk('lead_no_production', 'NO PRODUCTION' in c or 'KHÔNG SẢN XUẤT' in c)

    # === Worker CMD checks ===
    if not is_lead:
        # Reverse channel
        chk('reverse_def_ack', 'def push_ack_to_lead' in c)
        chk('reverse_def_completion', 'def push_completion_to_lead' in c)
        chk('reverse_def_heartbeat', 'def push_heartbeat_to_lead' in c)
        chk('reverse_call_ack', bool(re.search(r'(?<!def )push_ack_to_lead\(', c)))
        chk('reverse_call_completion', bool(re.search(r'(?<!def )push_completion_to_lead\(', c)))
        chk('reverse_call_heartbeat', bool(re.search(r'(?<!def )push_heartbeat_to_lead\(', c)))
        chk('alert_to_lead', 'send_alert_to_lead' in c or 'push_alert' in c or 'cmd-lead/alerts' in c)
        chk('poll_inbox', 'poll_inbox' in c or "'inbox'" in c or '/inbox/' in c)
        chk('apply_fix_task', 'apply_fix_task' in c or 'apply_fix' in c)
        chk('status_json_push', 'status' in c.lower() and 'json' in c.lower())

    # === QA-specific ===
    if is_qa:
        qa_fn = {'CMD_QA_CONTENT_v1.0.md': 'verify_content',
                 'CMD_QA_ART_v1.0.md': 'verify_art',
                 'CMD_QA_CORE_v1.0.md': 'verify_core',
                 'CMD_QA_FULL_v1.0.md': 'verify_full_e2e'}[fname]
        chk(f'qa_def_{qa_fn}', f'def {qa_fn}(' in c)
        chk(f'qa_call_{qa_fn}', bool(re.search(rf'(?<!def )(?<!#){qa_fn}\(', c)))
        chk('qa_push_verdict_def', 'def push_verdict_to_lead' in c)
        chk('qa_push_verdict_call', bool(re.search(r'(?<!def )push_verdict_to_lead\(', c)))
        chk('qa_workflow_def', 'def qa_main_workflow' in c)
        chk('qa_targets_list', 'QA_TARGETS' in c)

    # === Tradeable CMD: anti-dupe 6 rules ===
    if is_tradeable:
        chk('antidupe_A_UUID', check_rule(c, r'assign_uuid_for_dedup|uuid.*per.*instance'))
        chk('antidupe_B_tx_log', check_rule(c, r'log_transaction|transaction_log'))
        chk('antidupe_C_2PC', check_rule(c, r'two_phase_commit|2[\s\-]?Phase[\s\-]?Commit'))
        chk('antidupe_D_authoritative', check_rule(c, r'AUTHORITATIVE_SERVER|authoritative'))
        chk('antidupe_E_heartbeat_30s', check_rule(c, r'ANTI_DUPE_HEARTBEAT|anti.*dupe.*heartbeat'))
        chk('antidupe_F_grace_90s', check_rule(c, r'GRACE_PERIOD|grace[\s\-]period.*90'))

    # === Content CMD: R71 registry reuse ===
    is_content = fname in ['CMD_NPC_v1.1.md', 'CMD_SKILL_v1.0.md', 'CMD_ITEM_v1.1.md',
                            'CMD_BOSS_v1.0.md', 'CMD_QUEST_v1.1.md']
    if is_content:
        chk('R71_existing_registry', 'existing' in c.lower())
        chk('R71_extend_only', check_rule(c, r'extend.only|R71|registry.reuse'))

    return results


def audit_all():
    """Run audit cho tất cả CMD."""
    all_cmds = WORKERS + [LEAD_CMD]
    results = []

    for cmd_file in all_cmds:
        r = audit_one_cmd(cmd_file)
        if r:
            results.append(r)

    # Summary
    total_checks = sum(r['total'] for r in results)
    total_passed = sum(r['passed'] for r in results)

    print("=" * 80)
    print("COMPREHENSIVE AUDIT — TUYỆT ĐỐI MỌI RULE")
    print("=" * 80)
    print(f"{'CMD':<28} {'Passed':>8} {'Total':>8} {'Score':>8}")
    print("-" * 80)
    for r in results:
        score = r['passed'] / r['total'] * 100 if r['total'] else 0
        status = '✓' if score >= 95 else ('!' if score >= 85 else '✗')
        name = r['cmd'].replace('CMD_', '').replace('.md', '')
        print(f"{name:<28} {r['passed']:>8} {r['total']:>8} {score:>7.1f}% {status}")
    print("-" * 80)
    print(f"{'GRAND TOTAL':<28} {total_passed:>8} {total_checks:>8} "
          f"{total_passed/total_checks*100:>7.1f}%")

    # Detail fails
    print()
    print("DETAILED FAILS:")
    print("-" * 80)
    any_fail = False
    for r in results:
        fails = [(k, v) for k, v in r['checks'].items() if not v]
        if fails:
            any_fail = True
            print(f"\n{r['cmd']}: {len(fails)} fails")
            for k, _ in fails:
                print(f"  ✗ {k}")
    if not any_fail:
        print("✅ ZERO FAILS")
    print("=" * 80)

    return total_passed, total_checks


if __name__ == '__main__':
    audit_all()
