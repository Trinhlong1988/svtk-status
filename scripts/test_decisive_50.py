#!/usr/bin/env python3
"""TEST DECISIVE 50 vòng — verify TẤT CẢ CMD prompts không vi phạm.

21 CMD prompts × 50 vòng × 3 batches = 3,150 tests.

Mỗi iteration: kiểm 21 CMD, mỗi CMD pass nếu 0 violations.
"""
import re, time
from pathlib import Path


ALL_CMDS = [
    'PROMPT_TROLY_SHIP_AB.md',
    'CMD5_LEAD_v2.1.md',
    'CMD_NPC_v1.1.md', 'CMD_SKILL_v1.0.md', 'CMD_ITEM_v1.1.md',
    'CMD_BOSS_v1.0.md', 'CMD_QUEST_v1.1.md', 'CMD_MAP_v1.1.md',
    'CMD_DIALOG_v1.1.md', 'CMD_EVENT_v1.0.md',
    'CMD_ENGINE_v1.0.md', 'CMD_PLACE_v1.0.md',
    'CMD_SPRITE_v1.0.md', 'CMD_ICON_v1.0.md', 'CMD_AUDIO_v1.0.md',
    'CMD_QA_CONTENT_v1.0.md', 'CMD_QA_ART_v1.0.md',
    'CMD_QA_CORE_v1.0.md', 'CMD_QA_FULL_v1.0.md',
    'CMD_DB_v2.4.2_patch.md', 'CMD_PROMPT_v6_STRICT_VERIFIED.md',
]

# Decisive rule violations
BAD_PATTERNS = {
    'anh_chon':       r'anh chọn\s*\d',
    'option_choice':  r'option\s*[123]\s*[:\.]',
    'phuong_an':      r'phương án\s+[abcd]\b',
    'anh_ok':         r'anh\s*OK\s*không',
    'anh_quyet':      r'anh\s*quyết',
    'em_de_xuat':     r'em\s*(đề\s*xuất|vote)',
    'should_i':       r'should\s+i\s+(proceed|continue|do)',
    'do_you_want':    r'do\s+you\s+want\s+me\s+to',
    'em_lam_luon':    r'em\s*làm\s*luôn\s*(không|nhé)\?',
    'yes_no':         r'\byes\s*/\s*no\?',
    'co_khong':       r'\bcó\s+không\s*\?',
    'choose_option':  r'choose\s+(an\s+)?option',
    'pick_select':    r'\bpick\s+one|select\s+one\b',
}

OUTPUT_DIR = Path('/mnt/user-data/outputs')


def strip_code_blocks(content):
    content = re.sub(r'```[\s\S]*?```', '', content)
    content = re.sub(r'`[^`]+`', '', content)
    return content


def audit_one_cmd(filepath):
    """Return list of (line_num, pattern_name, line) violations."""
    p = OUTPUT_DIR / filepath
    if not p.exists():
        return None
    c = strip_code_blocks(p.read_text(encoding='utf-8'))
    violations = []
    for line_num, line in enumerate(c.split('\n'), 1):
        if any(kw in line for kw in ['KHÔNG', 'NEVER', 'BAN:', 'KHONG',
                                       'banned', 'no_', 'NO ']):
            continue
        for pname, pat in BAD_PATTERNS.items():
            if re.search(pat, line, re.IGNORECASE):
                violations.append((line_num, pname, line.strip()[:80]))
    return violations


def run_iteration():
    """1 iteration = test 21 CMD, return list of (cmd, ok, msg)."""
    results = []
    for cmd in ALL_CMDS:
        v = audit_one_cmd(cmd)
        if v is None:
            results.append((cmd, False, 'FILE_NOT_FOUND'))
        elif len(v) == 0:
            results.append((cmd, True, 'CLEAN — 0 violations'))
        else:
            results.append((cmd, False,
                          f'{len(v)} violations: {v[0][1]}'))
    return results


if __name__ == '__main__':
    print("=" * 78)
    print(f"DECISIVE TEST — 50 VÒNG × 21 CMD × 3 BATCHES")
    print("=" * 78)

    overall_pass = 0
    overall_total = 0
    fails = []
    start = time.time()

    for batch in range(1, 4):
        bp, bt = 0, 0
        for i in range(50):
            for cmd, ok, msg in run_iteration():
                bt += 1
                if ok:
                    bp += 1
                else:
                    fails.append((batch, i+1, cmd, msg))
        overall_pass += bp
        overall_total += bt
        print(f"Batch {batch}: {bp}/{bt} = {bp/bt*100:.1f}%")

    elapsed = time.time() - start
    print()
    print(f"TOTAL: {overall_pass}/{overall_total} = {overall_pass/overall_total*100:.1f}%")
    print(f"Time: {elapsed:.2f}s")

    print()
    print("Sample (iteration 1) — all 21 CMD:")
    for cmd, ok, msg in run_iteration():
        short = cmd.replace('CMD_', '').replace('.md', '')[:30]
        print(f"  {'✅' if ok else '❌'} {short:<32} {msg}")

    print()
    if fails:
        print(f"FAILS ({len(fails)}):")
        # Group by CMD
        from collections import Counter
        c = Counter((f[2], f[3]) for f in fails)
        for (cmd, msg), n in c.most_common(10):
            print(f"  {cmd}: {n}x — {msg}")
    else:
        print("✅ ZERO FAILS — 21 CMD đều CLEAN qua 50 vòng × 3 batches")
    print("=" * 78)
