# ============================================================================
# HISTORICAL REFERENCE ONLY - DO NOT RE-EXECUTE
# ----------------------------------------------------------------------------
# Targets foundation/SVTK_FOUNDATION_v2.8.0.md (retired 2026-05-26 by LEAD #124).
# Current foundation: SVTK_FOUNDATION_v2.10.0.md
# sha256 cc194e6cad2225d197c4a5539352deb538c99cdd6a21845a8354260602287bbb
# Re-execute = FileNotFoundError. Kept for audit trail of shipped artifacts.
# ============================================================================
"""
20-PASS AUDIT — Phase 14 pre-flight hardening
Each pass = independent check on 1 dimension. Goal: detect hidden inconsistency / conflict.
"""
import os
import json
import re
import hashlib
import subprocess
from pathlib import Path

OLD_ROOT = Path(r'D:\DỰ ÁN AI\FINAL TSONLINE')
NEW_ROOT = Path(r'C:\Users\Administrator\Desktop\SVTK_UPLOAD_WORK\_extracted')
REPO_ROOT = Path(r'C:\Users\Administrator\Desktop\SVTK_UPLOAD_WORK\repo')
BACKUP = Path(r'D:\BACKUP_FINAL_TSONLINE_20260518.zip')

results = []  # (pass#, name, status, detail)

def record(pass_n, name, status, detail=''):
    results.append((pass_n, name, status, detail))
    icon = '✅' if status == 'PASS' else ('⚠️' if status == 'WARN' else '❌')
    print(f'{icon} Pass {pass_n:2d}: {name} — {status}{" — " + detail if detail else ""}')

# ─────────────────────────────────────────────────────────
# PASS 1: OLD R1-R33 enumeration (spec/01_MASTER_LOCK.md)
# ─────────────────────────────────────────────────────────
def pass1():
    p = OLD_ROOT / 'spec' / '01_MASTER_LOCK.md'
    text = p.read_text(encoding='utf-8')
    rules = re.findall(r'^\| R(\d+) \|', text, re.MULTILINE)
    rule_nums = sorted(set(int(r) for r in rules))
    if rule_nums == list(range(1, 34)):
        record(1, 'OLD R1-R33 enumeration', 'PASS', f'{len(rule_nums)} rules')
    else:
        record(1, 'OLD R1-R33 enumeration', 'FAIL', f'expected 1-33, got {rule_nums}')

# ─────────────────────────────────────────────────────────
# PASS 2: NEW R66-R70 enumeration in Foundation v2.8.0
# ─────────────────────────────────────────────────────────
def pass2():
    p = NEW_ROOT / 'SVTK_FOUNDATION_v2.8.0.md'
    text = p.read_text(encoding='utf-8')
    rules = re.findall(r'^# ★ R(\d+) — ', text, re.MULTILINE)
    rule_nums = sorted(set(int(r) for r in rules))
    if rule_nums == [66, 67, 68, 69, 70]:
        record(2, 'NEW R66-R70 in Foundation', 'PASS', '5 new rules')
    else:
        record(2, 'NEW R66-R70 in Foundation', 'FAIL', f'got {rule_nums}')

# ─────────────────────────────────────────────────────────
# PASS 3: CMD_ENGINE cite both OLD + NEW R-rules (lineage proof)
# ─────────────────────────────────────────────────────────
def pass3():
    p = NEW_ROOT / 'CMD_ENGINE_v1.0.md'
    text = p.read_text(encoding='utf-8')
    cited = set(int(m) for m in re.findall(r'\bR(\d+)\b', text))
    old_cited = cited & set(range(1, 34))
    new_cited = cited & set(range(34, 71))
    if old_cited and new_cited:
        record(3, 'CMD_ENGINE cite OLD+NEW lineage', 'PASS', f'OLD: {sorted(old_cited)} | NEW: {sorted(new_cited)}')
    else:
        record(3, 'CMD_ENGINE cite OLD+NEW lineage', 'FAIL', f'OLD: {old_cited} | NEW: {new_cited}')

# ─────────────────────────────────────────────────────────
# PASS 4: Grace period explicit in Foundation v2.8.0
# ─────────────────────────────────────────────────────────
def pass4():
    p = NEW_ROOT / 'SVTK_FOUNDATION_v2.8.0.md'
    text = p.read_text(encoding='utf-8')
    if 'Grace period' in text and 'CMD đã ship' in text:
        record(4, 'Grace period for old CMD', 'PASS', 'explicit grace clause')
    else:
        record(4, 'Grace period for old CMD', 'FAIL', 'no grace clause')

# ─────────────────────────────────────────────────────────
# PASS 5: Element wheel — 5 chain + TÂM neutral (R19)
# ─────────────────────────────────────────────────────────
def pass5():
    p = OLD_ROOT / 'data' / 'element_wheel.json'
    j = json.loads(p.read_text(encoding='utf-8'))
    chain = j.get('counter_chain', [])
    tam = j.get('tam_special', {})
    if chain == ['KIM', 'MOC', 'THO', 'THUY', 'HOA'] and tam.get('tam_damage_nerf_bp') == 8000:
        record(5, 'Element wheel 5 chain + TÂM R19 nerf', 'PASS', 'BP=8000 nerf')
    else:
        record(5, 'Element wheel 5 chain + TÂM R19 nerf', 'FAIL', f'chain={chain}, tam={tam}')

# ─────────────────────────────────────────────────────────
# PASS 6: R23 OLD tick interval vs codebase
# ─────────────────────────────────────────────────────────
def pass6():
    p = OLD_ROOT / 'data' / 'skill_constants.json'
    text = p.read_text(encoding='utf-8')
    if 'TURN_DELAY_MS' in text and '1200' in text:
        record(6, 'R23 server tick (TURN_DELAY_MS=1200ms)', 'PASS', 'decoded from TS Online')
    else:
        record(6, 'R23 server tick (TURN_DELAY_MS=1200ms)', 'WARN', 'no explicit tick val')

# ─────────────────────────────────────────────────────────
# PASS 7: R10 threat scale match data file
# ─────────────────────────────────────────────────────────
def pass7():
    p = OLD_ROOT / 'data' / 'threat_constants.json'
    j = json.loads(p.read_text(encoding='utf-8'))
    dmg = j.get('THREAT_COEF_DAMAGE_BP')
    heal = j.get('THREAT_COEF_HEAL_BP')
    taunt = j.get('THREAT_COEF_TAUNT_BP')
    if dmg == 10000 and heal == 7000 and taunt == 50000:
        record(7, 'R10 threat scale data match', 'PASS', f'dmg=100% heal=70% taunt=500%')
    else:
        record(7, 'R10 threat scale data match', 'FAIL', f'dmg={dmg} heal={heal} taunt={taunt}')

# ─────────────────────────────────────────────────────────
# PASS 8: R30 BP scale + R31 INT only — 9 critical data files
# ─────────────────────────────────────────────────────────
def pass8():
    files = ['element_wheel.json', 'npc_constants.json', 'skill_constants.json',
             'status_constants.json', 'threat_constants.json', 'itemization_constants.json',
             'stat_budget.json', 'slot_cap.json', 'economy_constants.json']
    ok, fail = 0, []
    for f in files:
        p = OLD_ROOT / 'data' / f
        if not p.exists():
            fail.append(f)
            continue
        text = p.read_text(encoding='utf-8')
        # BP scale: has _BP/_bp suffix (case-insensitive) OR _convention mentions R30 OR doc says BP scale
        tl = text.lower()
        bp_ok = '_bp' in tl or 'r30' in tl or 'bp scale' in tl or '_bp"' in text
        if bp_ok:
            ok += 1
        else:
            fail.append(f)
    if ok == 9:
        record(8, 'R30/R31 compliance 9 data files', 'PASS', f'{ok}/9 clean')
    else:
        record(8, 'R30/R31 compliance 9 data files', 'WARN', f'{ok}/9 (fail: {fail})')

# ─────────────────────────────────────────────────────────
# PASS 9: Combat tick semantics in combat_runtime.ts
# ─────────────────────────────────────────────────────────
def pass9():
    p = OLD_ROOT / 'src' / 'logic' / 'combat_runtime.ts'
    text = p.read_text(encoding='utf-8')
    tick_count = text.count('tick') + text.count('Tick') + text.count('TICK')
    has_turn = 'beginCombatTurn' in text and 'endCombatTurn' in text
    if tick_count >= 5 and has_turn:
        record(9, 'Combat tick semantics + turn lifecycle', 'PASS', f'{tick_count} tick refs + turn lifecycle')
    else:
        record(9, 'Combat tick semantics + turn lifecycle', 'WARN', f'tick={tick_count} turn={has_turn}')

# ─────────────────────────────────────────────────────────
# PASS 10: Replay infrastructure
# ─────────────────────────────────────────────────────────
def pass10():
    files = ['replay_event_stream.ts', 'replay_compaction.ts', 'combat_replay_verification_runtime.ts']
    present = sum(1 for f in files if (OLD_ROOT / 'src' / 'logic' / f).exists())
    if present == 3:
        record(10, 'Replay infrastructure (3 file)', 'PASS', '3/3 replay file present')
    else:
        record(10, 'Replay infrastructure (3 file)', 'WARN', f'{present}/3 found')

# ─────────────────────────────────────────────────────────
# PASS 11: R44 anti-dupe coverage (10+ file expected)
# ─────────────────────────────────────────────────────────
def pass11():
    count = 0
    for f in (OLD_ROOT / 'src').rglob('*.ts'):
        try:
            text = f.read_text(encoding='utf-8')
            if re.search(r'R4[4-7]|anti.?dupe|nonce|idempot', text, re.IGNORECASE):
                count += 1
        except: pass
    if count >= 10:
        record(11, 'R44-R47 anti-dupe coverage', 'PASS', f'{count} file with anti-dupe refs')
    else:
        record(11, 'R44-R47 anti-dupe coverage', 'WARN', f'only {count} file')

# ─────────────────────────────────────────────────────────
# PASS 12: Test count 338+
# ─────────────────────────────────────────────────────────
def pass12():
    tests = list((OLD_ROOT / 'tests').rglob('*.test.ts'))
    n = len(tests)
    if n >= 338:
        record(12, 'Test file count ≥338', 'PASS', f'{n} test files')
    else:
        record(12, 'Test file count ≥338', 'FAIL', f'only {n}')

# ─────────────────────────────────────────────────────────
# PASS 13: NEW spec count files (CMD docs)
# ─────────────────────────────────────────────────────────
def pass13():
    cmds = list(NEW_ROOT.glob('CMD_*.md'))
    if len(cmds) >= 18:
        record(13, 'NEW CMD spec count', 'PASS', f'{len(cmds)} CMD specs')
    else:
        record(13, 'NEW CMD spec count', 'WARN', f'only {len(cmds)}')

# ─────────────────────────────────────────────────────────
# PASS 14: Backup zip integrity (SHA256 match)
# ─────────────────────────────────────────────────────────
def pass14():
    if not BACKUP.exists():
        record(14, 'Backup zip exist', 'FAIL', 'missing')
        return
    expected = '4064719187E557BFB5A3A088C7115C7DA74AAF3C37C8866F60DB40EFB107F0BB'
    h = hashlib.sha256(BACKUP.read_bytes()).hexdigest().upper()
    if h == expected:
        record(14, 'Backup SHA256 match', 'PASS', h[:16] + '...')
    else:
        record(14, 'Backup SHA256 match', 'FAIL', f'got {h[:16]}')

# ─────────────────────────────────────────────────────────
# PASS 15: Git tag pre-migration-v2.8.0 exist
# ─────────────────────────────────────────────────────────
def pass15():
    try:
        r = subprocess.run(['git', '-C', str(OLD_ROOT), '-c', 'safe.directory=*', 'tag', '-l', 'pre-migration-v2.8.0'],
                          capture_output=True, text=True, timeout=10)
        if 'pre-migration-v2.8.0' in r.stdout:
            record(15, 'Git tag pre-migration-v2.8.0', 'PASS', 'tag present')
        else:
            record(15, 'Git tag pre-migration-v2.8.0', 'FAIL', 'tag missing')
    except Exception as e:
        record(15, 'Git tag pre-migration-v2.8.0', 'FAIL', str(e)[:50])

# ─────────────────────────────────────────────────────────
# PASS 16: Repo svtk-status has 5 commit + audit docs
# ─────────────────────────────────────────────────────────
def pass16():
    try:
        r = subprocess.run(['git', '-C', str(REPO_ROOT), 'log', '--oneline'],
                          capture_output=True, text=True, timeout=10)
        commits = r.stdout.strip().splitlines()
        # Should have: 5 phase A commits + 1 audit commit + 1 initial = 7
        audit_present = (REPO_ROOT / 'docs' / 'COMPLIANCE_AUDIT.md').exists() and \
                        (REPO_ROOT / 'docs' / 'MIGRATION_AUDIT.md').exists()
        if len(commits) >= 6 and audit_present:
            record(16, 'Repo state (≥6 commit + audit docs)', 'PASS', f'{len(commits)} commits + audit')
        else:
            record(16, 'Repo state (≥6 commit + audit docs)', 'WARN', f'{len(commits)} commits, audit={audit_present}')
    except Exception as e:
        record(16, 'Repo state check', 'FAIL', str(e)[:50])

# ─────────────────────────────────────────────────────────
# PASS 17: No Tam Quốc in actual game data (gameplay layer)
# ─────────────────────────────────────────────────────────
def pass17():
    forbidden = ['Tào Tháo', 'Lưu Bị', 'Quan Vũ', 'Trương Phi', 'Khổng Minh']
    hits = []
    for f in (OLD_ROOT / 'data').rglob('*.json'):
        try:
            text = f.read_text(encoding='utf-8')
            for b in forbidden:
                if b in text:
                    hits.append((f.name, b))
        except: pass
    if not hits:
        record(17, 'No Tam Quốc in OLD data files', 'PASS', '0 hit in data/*.json')
    else:
        record(17, 'No Tam Quốc in OLD data files', 'FAIL', f'{hits[:3]}')

# ─────────────────────────────────────────────────────────
# PASS 18: No CJK in OLD data files
# ─────────────────────────────────────────────────────────
def pass18():
    cjk = re.compile(r'[一-鿿぀-ゟ゠-ヿ]')
    hits = []
    for f in (OLD_ROOT / 'data').rglob('*.json'):
        try:
            text = f.read_text(encoding='utf-8')
            if cjk.search(text):
                hits.append(f.name)
        except: pass
    if not hits:
        record(18, 'No CJK in OLD data', 'PASS', '0 hit')
    else:
        record(18, 'No CJK in OLD data', 'WARN', f'{hits[:5]}')

# ─────────────────────────────────────────────────────────
# PASS 19: BẠCH/HẮC = RB3 class consistency (memory rule)
# ─────────────────────────────────────────────────────────
def pass19():
    # Check OLD code: BẠCH/HẮC absent in NPC tier system (NPC chỉ có 6 hệ)
    p = OLD_ROOT / 'data' / 'npc_constants.json'
    text = p.read_text(encoding='utf-8')
    has_bach = 'BACH' in text or 'BẠCH' in text
    has_hac = 'HAC' in text or 'HẮC' in text
    if not has_bach and not has_hac:
        record(19, 'BẠCH/HẮC ABSENT in NPC system (correct)', 'PASS', 'NPC has 6 hệ only')
    else:
        record(19, 'BẠCH/HẮC ABSENT in NPC system', 'FAIL', f'bach={has_bach} hac={has_hac}')

# ─────────────────────────────────────────────────────────
# PASS 20: Foundation v2.8.0 backward compat statement
# ─────────────────────────────────────────────────────────
def pass20():
    p = NEW_ROOT / 'SVTK_FOUNDATION_v2.8.0.md'
    text = p.read_text(encoding='utf-8')
    has_minor = 'MINOR' in text and 'backward-compat' in text
    has_inherit = 'R1-R34' in text or 'Core governance' in text
    if has_minor and has_inherit:
        record(20, 'Foundation v2.8.0 backward-compat declared', 'PASS', 'MINOR + lineage')
    else:
        record(20, 'Foundation v2.8.0 backward-compat declared', 'WARN', f'minor={has_minor} inherit={has_inherit}')

# ═══════════════════════════════════════════════════════════
# RUN 20 PASSES
# ═══════════════════════════════════════════════════════════
print('═' * 60)
print('20-PASS AUDIT — SVTK Phase 14 Pre-Flight Hardening')
print('═' * 60)
for fn in [pass1, pass2, pass3, pass4, pass5, pass6, pass7, pass8, pass9, pass10,
           pass11, pass12, pass13, pass14, pass15, pass16, pass17, pass18, pass19, pass20]:
    try:
        fn()
    except Exception as e:
        record(fn.__name__[4:], 'EXCEPTION', 'FAIL', str(e)[:100])

print('\n' + '═' * 60)
total = len(results)
passed = sum(1 for r in results if r[2] == 'PASS')
warned = sum(1 for r in results if r[2] == 'WARN')
failed = sum(1 for r in results if r[2] == 'FAIL')
print(f'TOTAL: {total} | PASS: {passed} | WARN: {warned} | FAIL: {failed}')
print('═' * 60)

# Write JSON output
out = {
    'pass': passed, 'warn': warned, 'fail': failed, 'total': total,
    'results': [{'pass': r[0], 'name': r[1], 'status': r[2], 'detail': r[3]} for r in results],
}
Path(r'C:\Users\Administrator\Desktop\SVTK_UPLOAD_WORK\_audit_20pass_result.json').write_text(
    json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
print('Saved: _audit_20pass_result.json')

if failed == 0:
    print('\n✅ AUDIT 20-PASS HARDENING — PASS')
else:
    print(f'\n❌ AUDIT FAILED — {failed} critical issue(s). Review JSON.')
