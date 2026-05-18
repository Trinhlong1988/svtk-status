#!/usr/bin/env python3
"""Audit ALL CMD prompts decisive rule (skip code blocks)."""
import re
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

BAD_PATTERNS = {
    'anh_chon_123':    r'anh chọn\s*\d',
    'option_1_2_3_choice': r'option\s*[123]\s*[:\.]',  # narrow
    'phuong_an_abcd':  r'phương án\s+[abcd]\b',
    'anh_ok_khong':    r'anh\s*OK\s*không',
    'anh_quyet':       r'anh\s*quyết',
    'em_de_xuat':      r'em\s*(đề\s*xuất|vote)',
    'should_i_q':      r'should\s+i\s+(proceed|continue|do)',
    'do_you_want':     r'do\s+you\s+want\s+me\s+to',
    'em_lam_luon':     r'em\s*làm\s*luôn\s*(không|nhé)\?',
    'yes_no_q':        r'\byes\s*/\s*no\?',
    'co_khong_q':      r'\bcó\s+không\s*\?',
    'choose_option':   r'choose\s+(an\s+)?option',
    'pick_one':        r'\bpick\s+one|select\s+one\b',
}

def strip_code_blocks(content):
    """Remove ```...``` code blocks và inline `code`."""
    # Remove fenced code blocks
    content = re.sub(r'```[\s\S]*?```', '', content)
    # Remove inline code
    content = re.sub(r'`[^`]+`', '', content)
    return content


def audit_file(filepath):
    p = Path(filepath)
    if not p.exists():
        return None
    c = p.read_text()
    c_no_code = strip_code_blocks(c)

    violations = []
    for line_num, line in enumerate(c_no_code.split('\n'), 1):
        # Skip ban statements
        if any(kw in line for kw in ['KHÔNG', 'NEVER', 'BAN:', 'KHONG',
                                       'banned', 'no_', 'NO ']):
            continue
        for pname, pat in BAD_PATTERNS.items():
            if re.search(pat, line, re.IGNORECASE):
                violations.append((line_num, pname, line.strip()[:80]))
    return violations


def main():
    print("=" * 90)
    print("AUDIT DECISIVE — ALL CMD PROMPTS (skip code blocks)")
    print("=" * 90)
    total = 0
    print(f'{"File":<35} {"Violations":>12}')
    print('-' * 90)
    all_v = {}
    for f in ALL_CMDS:
        v = audit_file(f)
        if v is None:
            continue
        n = len(v)
        total += n
        short = f.replace('CMD_', '').replace('.md', '')[:34]
        status = '✓ CLEAN' if n == 0 else '✗ BAD'
        print(f'{short:<35} {n:>12}  {status}')
        if v:
            all_v[f] = v
    print('-' * 90)
    print(f'{"TOTAL":<35} {total:>12}')

    if all_v:
        print()
        print("DETAILS:")
        for f, viols in all_v.items():
            for ln, p, line in viols[:5]:
                print(f'  {f} L{ln} [{p}]: {line}')
    return total


if __name__ == '__main__':
    main()
