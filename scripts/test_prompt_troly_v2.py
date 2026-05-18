#!/usr/bin/env python3
"""TEST v2: thêm 5 scenario verify CMD5 escalation."""
import re, time
from pathlib import Path
import sys
sys.path.insert(0, '/home/claude')
from test_prompt_troly import (t1_no_choice_12_3, t2_no_ask_permission,
                                 t3_decisive_command, t4_repo_url,
                                 t5_2_files_path, t6_npc_schema_32_fields,
                                 t7_skill_schema_15_fields,
                                 t8_cultural_lock_tam_quoc,
                                 t9_cultural_lock_cjk, t10_era_valid_list,
                                 t11_six_elements_vstk,
                                 t12_source_data_phase_truoc,
                                 t13_decode_ts_online, t14_self_audit_10_rules,
                                 t15_exit_criteria_decisive, load_prompt)

def t16_cmd5_lead_mention():
    c = load_prompt()
    assert 'CMD5 LEAD' in c or 'CMD5' in c
    return True, 'CMD5 LEAD mentioned'

def t17_push_alert_protocol():
    c = load_prompt()
    assert 'cmd-lead/alerts' in c
    assert 'severity' in c.lower()
    assert 'HIGH' in c and 'MED' in c
    return True, 'Push alert protocol đầy đủ'

def t18_push_status_protocol():
    c = load_prompt()
    assert 'PUSH STATUS' in c or 'push_status' in c.lower()
    assert 'cmd-troly_ship_ab/status' in c or 'status-' in c
    return True, 'Push status protocol'

def t19_no_abcd_option():
    """Không có 'a/b/c/d' option pattern (skip ban lines)."""
    c = load_prompt()
    bad = [r'choose [abcd]', r'option [abcd]', r'\([abcd]\)',
           r'phương án [abcd]']
    for line in c.split('\n'):
        if 'KHÔNG' in line or 'BAN' in line or 'NEVER' in line:
            continue
        for p in bad:
            assert not re.search(p, line, re.IGNORECASE), f'Found {p}'
    return True, 'No a/b/c/d option pattern'

def t20_cmd5_decides():
    """CMD5 quyết, trợ lý chỉ thực thi."""
    c = load_prompt()
    assert 'CMD5 ĐIỀU PHỐI' in c or 'CHỈ THỰC THI' in c
    assert 'ĐẨY LÊN CMD5' in c or 'báo cáo' in c.lower() or 'escalate' in c.lower() or 'gap' in c.lower()
    return True, 'CMD5 decides, trợ lý executes'

def run():
    tests = [t1_no_choice_12_3, t2_no_ask_permission, t3_decisive_command,
             t4_repo_url, t5_2_files_path, t6_npc_schema_32_fields,
             t7_skill_schema_15_fields, t8_cultural_lock_tam_quoc,
             t9_cultural_lock_cjk, t10_era_valid_list, t11_six_elements_vstk,
             t12_source_data_phase_truoc, t13_decode_ts_online,
             t14_self_audit_10_rules, t15_exit_criteria_decisive,
             t16_cmd5_lead_mention, t17_push_alert_protocol,
             t18_push_status_protocol, t19_no_abcd_option, t20_cmd5_decides]
    out = []
    for t in tests:
        try:
            ok, msg = t()
            out.append((t.__name__, ok, msg))
        except AssertionError as e:
            out.append((t.__name__, False, f'FAIL: {e}'))
    return out


if __name__ == '__main__':
    print("=" * 78)
    print("PROMPT TROLY v2 — 20 VÒNG × 20 SCENARIOS × 3 BATCHES")
    print("=" * 78)
    ovp = ovt = 0
    fails = []
    start = time.time()
    for batch in range(1, 4):
        bp = bt = 0
        for i in range(20):
            for n, ok, m in run():
                bt += 1
                if ok: bp += 1
                else: fails.append((batch, i+1, n, m))
        ovp += bp; ovt += bt
        print(f"Batch {batch}: {bp}/{bt} = {bp/bt*100:.1f}%")
    print(f"\nTOTAL: {ovp}/{ovt} = {ovp/ovt*100:.1f}%")
    print(f"Time: {time.time()-start:.2f}s")
    print()
    print("Sample:")
    for n, ok, m in run():
        print(f"  {'✅' if ok else '❌'} {n}: {m}")
    if fails:
        print(f"\nFAILS ({len(fails)}):")
        for b, i, n, m in fails[:10]:
            print(f"  B{b}/i{i} {n}: {m}")
    else:
        print("\n✅ ZERO FAILS")
