#!/usr/bin/env python3
"""Layer 32 coverage runner — measure generate_items.py line coverage.

Output: coverage_report.json with stats compatible with deep_audit L32.
"""
import json
import subprocess
import sys
import time
from pathlib import Path

WORKSPACE = Path(__file__).parent
REPO_DIR = WORKSPACE / "svtk-status"
REPORTS = REPO_DIR / "cmd-item" / "output" / "reports"
GEN = WORKSPACE / "generate_items.py"


def main() -> int:
    REPORTS.mkdir(parents=True, exist_ok=True)
    # Run with coverage
    t0 = time.perf_counter()
    r = subprocess.run(
        [sys.executable, "-m", "coverage", "run", "--source=generate_items",
         str(GEN)],
        capture_output=True, text=True, encoding="utf-8",
        cwd=str(WORKSPACE), timeout=120,
    )
    if r.returncode != 0:
        print(f"coverage run failed: {r.stderr[:300]}")
        return 1
    elapsed = time.perf_counter() - t0
    # JSON report
    rj = subprocess.run(
        [sys.executable, "-m", "coverage", "json", "-o", "-",
         "--include=generate_items.py"],
        capture_output=True, text=True, encoding="utf-8",
        cwd=str(WORKSPACE), timeout=60,
    )
    data = json.loads(rj.stdout)
    files = data.get("files", {})
    gen_data = list(files.values())[0] if files else {}
    summary = gen_data.get("summary", {})

    report = {
        "tool": "coverage.py",
        "version": data.get("meta", {}).get("version"),
        "target": "generate_items.py",
        "elapsed_sec": round(elapsed, 2),
        "covered_lines": summary.get("covered_lines"),
        "missing_lines": summary.get("missing_lines"),
        "num_statements": summary.get("num_statements"),
        "percent_covered": summary.get("percent_covered"),
        "excluded_lines": summary.get("excluded_lines", 0),
        "missing_line_numbers": gen_data.get("missing_lines", [])[:50],
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    out = REPORTS / "coverage_report.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False),
                   encoding="utf-8")
    print(f"Coverage {report['percent_covered']:.1f}% "
          f"({report['covered_lines']}/{report['num_statements']})")
    print(f"Wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
