#!/usr/bin/env python3
"""Layer 32 mutmut subset runner — auto-mutate operators/literals in
generate_items.py and verify deep_audit kills each. Bounded sample to
keep runtime reasonable (full mutmut on 342 stmt is ~30 min).

Strategy: pick N random AST-level mutations (constant flip, operator
swap, return-None, etc.), apply each in-place, run deep_audit, expect
non-zero exit. Restore. Repeat.
"""
import ast
import json
import os
import random
import shutil
import subprocess
import sys
import time
from pathlib import Path

WORKSPACE = Path(__file__).parent
REPO_DIR = WORKSPACE / "svtk-status"
REPORTS = REPO_DIR / "cmd-item" / "output" / "reports"
GEN = WORKSPACE / "generate_items.py"
BACKUP = WORKSPACE / "generate_items.py.mut_backup"
AUDIT = WORKSPACE / "deep_audit.py"

MAX_MUTATIONS = int(os.environ.get("MUT_N", "30"))


class ConstantFlipper(ast.NodeTransformer):
    """Flip integer constants by adding 1 (or returning empty list)."""
    def __init__(self, target_line: int, kind: str):
        self.target_line = target_line
        self.kind = kind
        self.applied = False

    def visit_Constant(self, node):
        if self.applied or getattr(node, "lineno", -1) != self.target_line:
            return node
        if self.kind == "int_inc" and isinstance(node.value, int):
            node.value = node.value + 1
            self.applied = True
        elif self.kind == "int_neg" and isinstance(node.value, int):
            node.value = -node.value
            self.applied = True
        elif self.kind == "str_empty" and isinstance(node.value, str):
            node.value = ""
            self.applied = True
        elif self.kind == "true_to_false" and node.value is True:
            node.value = False
            self.applied = True
        elif self.kind == "false_to_true" and node.value is False:
            node.value = True
            self.applied = True
        return node


def candidates(src: str):
    """Find candidate lines/kinds for mutation."""
    tree = ast.parse(src)
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant):
            continue
        ln = getattr(node, "lineno", -1)
        if ln < 0:
            continue
        v = node.value
        # Skip docstrings/lines in atomic_write helpers (would break gen)
        if ln < 80:
            continue
        if isinstance(v, int) and 1 <= v <= 50000:
            out.append((ln, "int_inc"))
        elif v is True:
            out.append((ln, "true_to_false"))
        elif v is False:
            out.append((ln, "false_to_true"))
        elif isinstance(v, str) and 2 <= len(v) <= 30 and "{" not in v:
            out.append((ln, "str_empty"))
    return out


def apply_and_run(src: str, line: int, kind: str) -> dict:
    tree = ast.parse(src)
    tr = ConstantFlipper(line, kind)
    tr.visit(tree)
    ast.fix_missing_locations(tree)
    if not tr.applied:
        return {"applied": False}
    mutated = ast.unparse(tree)
    GEN.write_text(mutated, encoding="utf-8")
    # Run audit with NO_WARMUP=0 so generator re-runs with mutation
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    r = subprocess.run([sys.executable, str(AUDIT)],
                       capture_output=True, text=True, encoding="utf-8",
                       env=env, timeout=120)
    return {"applied": True, "rc": r.returncode,
            "killed": r.returncode != 0,
            "stdout_tail": (r.stdout or "")[-300:]}


def main() -> int:
    REPORTS.mkdir(parents=True, exist_ok=True)
    src = GEN.read_text(encoding="utf-8")
    shutil.copy(GEN, BACKUP)
    cands = candidates(src)
    random.seed(42)
    random.shuffle(cands)
    cands = cands[:MAX_MUTATIONS]
    results = []
    killed = 0
    survived = 0
    print(f"Running {len(cands)} mutations...")
    try:
        for i, (line, kind) in enumerate(cands, 1):
            print(f"  [{i}/{len(cands)}] line={line} kind={kind}", flush=True)
            res = apply_and_run(src, line, kind)
            res["line"] = line
            res["kind"] = kind
            if res.get("killed"):
                killed += 1
            elif res.get("applied"):
                survived += 1
            results.append(res)
            # Restore to original src for next iteration
            GEN.write_text(src, encoding="utf-8")
    finally:
        # Final restore
        shutil.copy(BACKUP, GEN)
        BACKUP.unlink(missing_ok=True)
    # Regen for clean state
    subprocess.run([sys.executable, str(GEN)],
                   capture_output=True, text=True, timeout=60)
    applied = killed + survived
    report = {
        "tool": "mutmut_runner (AST constant-flipper)",
        "mutations_attempted": len(cands),
        "mutations_applied": applied,
        "killed": killed,
        "survived": survived,
        "kill_rate": round(killed / applied, 3) if applied else 0.0,
        "survivors": [{"line": r["line"], "kind": r["kind"]}
                      for r in results if r.get("applied")
                      and not r.get("killed")][:10],
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    out = REPORTS / "mutmut_runner_report.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False),
                   encoding="utf-8")
    print(f"\nKill rate: {report['kill_rate']*100:.1f}% "
          f"({killed}/{applied} applied)")
    print(f"Wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
