#!/usr/bin/env python3
"""Tuan 3 audit runner — patches OUTPUT path for Windows + collects 3 audit results.

Runs audit_v280_strict / comprehensive_audit / audit_decisive_all against
the local repo foundation/ directory (vs Linux /mnt/user-data/outputs).
Emits a consolidated JSON to cmd-lead/completions/AUDIT_TUAN3_{ts}.json.
"""
import io
import json
import os
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
FOUNDATION = REPO / 'foundation'
SCRIPTS = REPO / 'scripts'

os.environ['PYTHONIOENCODING'] = 'utf-8'
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

results = {}

def run_one(name: str, script_path: Path):
    """Patch OUTPUT then exec as __main__ so the script's `if __name__ == '__main__'` block fires."""
    print(f"\n========== {name} ==========")
    src = script_path.read_text(encoding='utf-8')
    # Replace hardcoded /mnt/user-data/outputs with our local foundation/ dir
    patched = src.replace(
        "Path('/mnt/user-data/outputs')",
        f"Path(r'{FOUNDATION}')",
    )
    captured = io.StringIO()
    real_stdout = sys.stdout
    sys.stdout = captured
    ns = {'__name__': '__main__', '__file__': str(script_path)}
    try:
        exec(compile(patched, str(script_path), 'exec'), ns)
    except SystemExit as e:
        captured.write(f"\n[SystemExit code={e.code}]\n")
    except Exception as e:
        captured.write(f"\n[ERROR {type(e).__name__}: {e}]\n")
    finally:
        sys.stdout = real_stdout
    out = captured.getvalue()
    print(out)
    return out

out_v280 = run_one('audit_v280_strict', SCRIPTS / 'audit_v280_strict.py')
out_comp = run_one('comprehensive_audit', SCRIPTS / 'comprehensive_audit.py')
out_dec = run_one('audit_decisive_all', SCRIPTS / 'audit_decisive_all.py')

def parse_summary(text: str) -> dict:
    """Pull '✅ N ROUNDS ZERO BUGS' or 'X/Y = Z%' lines from stdout."""
    last_round = None
    final_marker = None
    for line in text.splitlines():
        if 'ROUND' in line and '%' in line:
            last_round = line.strip()
        if 'ZERO BUGS' in line or 'COMPLETE' in line or 'BUGS FOUND' in line:
            final_marker = line.strip()
    return {'last_round': last_round, 'final_marker': final_marker}

summary = {
    'audit_v280_strict': parse_summary(out_v280),
    'comprehensive_audit': parse_summary(out_comp),
    'audit_decisive_all': parse_summary(out_dec),
}

ts = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
verdict = {
    'cmd': 'cmd-qa-core',
    'parent': 'CMD4',
    'phase': '14',
    'version': 'v2.8.0',
    'week': 'Tuan 3 — full audit suite',
    'ts_utc': ts,
    'audits_run': ['audit_v280_strict.py', 'comprehensive_audit.py', 'audit_decisive_all.py'],
    'summary': summary,
    'note': 'OUTPUT path monkey-patched from /mnt/user-data/outputs (Linux) to foundation/ (Windows).',
}

out_file = REPO / 'cmd-lead' / 'completions' / f'AUDIT_TUAN3_{ts}.json'
out_file.write_text(json.dumps(verdict, ensure_ascii=False, indent=2), encoding='utf-8')
print(f"\n[VERDICT] {out_file}")
