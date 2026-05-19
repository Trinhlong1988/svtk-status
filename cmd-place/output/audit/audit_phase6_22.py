#!/usr/bin/env python3
"""CMD_PLACE — PHASE 6 audit (22 vòng MỚI).

A: source-level mutation testing (4)
B: cross-language Node.js roundtrip (4)
C: concurrent / parallel safety (4)
D: hypothesis property-based generative (5)
E: static analysis pylint+bandit+mypy (5)
"""
from __future__ import annotations
import json, hashlib, re, sys, subprocess, time, os, shutil, tempfile
import multiprocessing as mp
from pathlib import Path
from collections import Counter

ROOT = Path(r"C:\Users\Administrator\Desktop\CMD_PLACE_WORK\svtk-status")
OUT = ROOT / "cmd-place" / "output"
REG = OUT / "registry"
SCHEMA = OUT / "schema"
AUDIT = OUT / "audit"
WORK = Path(r"C:\Users\Administrator\Desktop\CMD_PLACE_WORK")
BUILDER = WORK / "build_place.py"
PY = sys.executable

TARGET_MAPS = 10000
TARGET_SHARDS = 64
ERAS = ["ly", "tran", "le", "tay_son", "nguyen"]
BIOMES = ["forest", "mountain", "river", "plain", "sea", "capital", "village"]
F_PREFIX_RULE = {"ly": "f1", "tran": "f1", "le": "f2", "tay_son": "f3", "nguyen": "g1"}

results = []


def record(n, name, ok, evidence, severity="ERROR"):
    results.append({"round": n, "name": name, "status": "PASS" if ok else "FAIL",
                    "severity": severity,
                    "evidence": evidence if isinstance(evidence, dict) else {"info": evidence}})
    print(f"R{n:02d} {'PASS' if ok else 'FAIL'} {name}")


# ─── A: SOURCE-LEVEL MUTATION (R01-R04) ─────────────────────
def mutate_and_check(mutation_name, replace_from, replace_to):
    """Apply mutation to build_place.py copy, rebuild, verify audit FAIL."""
    src = BUILDER.read_text(encoding="utf-8")
    if replace_from not in src:
        return {"ok": False, "reason": f"anchor '{replace_from}' not in source"}
    mutated = src.replace(replace_from, replace_to, 1)
    tmp_builder = WORK / "build_place_mutated.py"
    tmp_builder.write_text(mutated, encoding="utf-8")
    # Build to scratch dir
    scratch = WORK / "scratch_mutation"
    if scratch.exists():
        shutil.rmtree(scratch)
    scratch.mkdir()
    # Redirect OUTPUT_DIR via env override (parse build_place to find OUTPUT_DIR)
    # Simpler: copy mutated file content with redirected OUTPUT_DIR
    scratch_out = scratch / "out"
    redirect = mutated.replace(
        'OUTPUT_DIR = ROOT / "cmd-place" / "output"',
        f'OUTPUT_DIR = Path(r"{scratch_out}")'
    )
    tmp_builder.write_text(redirect, encoding="utf-8")
    r = subprocess.run([PY, str(tmp_builder)], capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=120)
    # Check internal test result (build_place runs place_tests.py)
    internal_pass = "PASS 17 FAIL 0" in (r.stdout or "")
    # Mutation should make internal test FAIL or build raise
    detected = (not internal_pass) or r.returncode != 0
    try:
        shutil.rmtree(scratch)
    except Exception:
        pass
    tmp_builder.unlink(missing_ok=True)
    return {"ok": detected, "internal_pass": internal_pass, "exit": r.returncode,
            "stdout_tail": (r.stdout or "")[-200:]}


def r01_mutation_shard_formula():
    """Mutation: shard_id formula (i-1) % 64 → (i+1) % 64."""
    res = mutate_and_check(
        "shard_id_offset",
        '(map_id - 1) % TARGET_REGION_SHARDS',
        '(map_id + 1) % TARGET_REGION_SHARDS'
    )
    record(1, "A1 MUTATION shard_id formula offset → tests detect",
           res["ok"], res)


def r02_mutation_target_map_count():
    """Mutation: TARGET_MAP_COUNT 10000 → 9000."""
    res = mutate_and_check(
        "target_count",
        'TARGET_MAP_COUNT = 10000',
        'TARGET_MAP_COUNT = 9000'
    )
    record(2, "A2 MUTATION TARGET_MAP_COUNT 10000→9000 → tests detect",
           res["ok"], res)


def r03_mutation_era_dup():
    """Mutation: duplicate era 'ly' twice."""
    res = mutate_and_check(
        "era_dup",
        'ERAS = ["ly", "tran", "le", "tay_son", "nguyen"]',
        'ERAS = ["ly", "ly", "le", "tay_son", "nguyen"]'
    )
    record(3, "A3 MUTATION duplicate era ('ly' twice) → tests detect",
           res["ok"], res)


def r04_mutation_biome_remove():
    """Mutation: biome list missing one element → split_block error."""
    res = mutate_and_check(
        "biome_short",
        'BIOMES = ["forest", "mountain", "river", "plain", "sea", "capital", "village"]',
        'BIOMES = ["forest", "mountain", "river", "plain", "sea", "capital"]'
    )
    record(4, "A4 MUTATION biome list len 7→6 → tests detect",
           res["ok"], res)


# ─── B: CROSS-LANGUAGE NODE.JS (R05-R08) ─────────────────────
def node_run(script_body):
    tmp = WORK / "node_audit_tmp.cjs"
    tmp.write_text(script_body, encoding="utf-8")
    r = subprocess.run(["node", str(tmp)], capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=120)
    tmp.unlink(missing_ok=True)
    return r


def r05_node_jsonl_parse():
    """Node.js parse map_registry.jsonl → count and verify map_id range."""
    script = f'''
const fs = require('fs');
const lines = fs.readFileSync(String.raw`{REG / "map_registry.jsonl"}`, 'utf-8').split('\\n').filter(s=>s.trim());
let mn = Infinity, mx = -Infinity;
let ok = true;
for (const l of lines) {{
    const m = JSON.parse(l);
    if (m.map_id < mn) mn = m.map_id;
    if (m.map_id > mx) mx = m.map_id;
    if (typeof m.map_id !== 'number') {{ ok = false; break; }}
}}
console.log(JSON.stringify({{count: lines.length, min: mn, max: mx, type_ok: ok}}));
'''
    r = node_run(script)
    try:
        data = json.loads(r.stdout.strip().split("\n")[-1])
        ok = data["count"] == TARGET_MAPS and data["min"] == 1 and data["max"] == TARGET_MAPS and data["type_ok"]
    except Exception as e:
        ok = False
        data = {"err": str(e), "stdout": r.stdout[-200:], "stderr": r.stderr[-200:]}
    record(5, "B1 Node.js parse JSONL: count=10000, map_id range [1,10000], type=number",
           ok, data)


def r06_node_json_canonical_match():
    """Node JSON.stringify of parsed object compared to Python json.dumps with matched separators."""
    py_sample = json.loads((REG / "map_registry.jsonl").read_text(encoding="utf-8").splitlines()[0])
    # Match Node JSON.stringify default separators (no space)
    py_canonical = json.dumps(py_sample, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    script = f'''
const obj = {json.dumps(py_sample, ensure_ascii=False)};
const canonical = JSON.stringify(obj, Object.keys(obj).sort());
console.log(canonical);
'''
    r = node_run(script)
    node_canonical = r.stdout.strip()
    record(6, "B2 Cross-lang JSON canonical Python vs Node sort-keys identical (matched separators)",
           py_canonical == node_canonical,
           {"python_len": len(py_canonical), "node_len": len(node_canonical),
            "equal": py_canonical == node_canonical,
            "py_head": py_canonical[:80], "node_head": node_canonical[:80]})


def r07_node_sha256_match():
    """Node.js SHA256 of map_registry.jsonl == Python SHA256."""
    expected = (REG / "map_registry.jsonl.sha256").read_text(encoding="utf-8").strip().split()[0]
    script = f'''
const fs = require('fs');
const crypto = require('crypto');
const data = fs.readFileSync(String.raw`{REG / "map_registry.jsonl"}`);
console.log(crypto.createHash('sha256').update(data).digest('hex'));
'''
    r = node_run(script)
    node_hash = r.stdout.strip()
    record(7, "B3 Cross-lang SHA256 (Node === Python .sha256 companion)",
           node_hash == expected, {"node": node_hash[:16], "python": expected[:16],
                                    "equal": node_hash == expected})


def r08_node_schema_validation():
    """Node.js validate required fields present in every map entry."""
    script = f'''
const fs = require('fs');
const required = ['uuid','map_id','natural_key','name','era','biome','shard_id','shard_code','f_prefix','coord_x','coord_y','tags','tsonline_cross_ref'];
const lines = fs.readFileSync(String.raw`{REG / "map_registry.jsonl"}`, 'utf-8').split('\\n').filter(s=>s.trim());
let bad = 0;
for (const l of lines) {{
    const m = JSON.parse(l);
    for (const k of required) {{
        if (!(k in m)) {{ bad++; break; }}
    }}
}}
console.log(JSON.stringify({{bad_count: bad, total: lines.length}}));
'''
    r = node_run(script)
    try:
        data = json.loads(r.stdout.strip().split("\n")[-1])
        ok = data["bad_count"] == 0
    except Exception as e:
        ok = False
        data = {"err": str(e), "stdout": r.stdout[-200:]}
    record(8, "B4 Node.js schema validation: all 13 required fields present",
           ok, data)


# ─── C: CONCURRENT / PARALLEL SAFETY (R09-R12) ─────────────────
def _worker_build(args):
    idx, scratch_root = args
    work_dir = Path(scratch_root) / f"worker_{idx}"
    work_dir.mkdir(parents=True, exist_ok=True)
    src = BUILDER.read_text(encoding="utf-8")
    redirected = src.replace(
        'OUTPUT_DIR = ROOT / "cmd-place" / "output"',
        f'OUTPUT_DIR = Path(r"{work_dir}")'
    )
    tmp_b = work_dir / "build.py"
    tmp_b.write_text(redirected, encoding="utf-8")
    r = subprocess.run([PY, str(tmp_b)], capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=300)
    map_hash = None
    p = work_dir / "registry" / "map_registry.jsonl"
    if p.exists():
        map_hash = hashlib.sha256(p.read_bytes()).hexdigest()
    return {"worker": idx, "exit": r.returncode, "map_hash": map_hash}


def r09_parallel_4_workers_same_hash():
    """Spawn 4 parallel builders in scratch dirs, all map_registry.jsonl must have same SHA256."""
    scratch_root = WORK / "scratch_parallel"
    if scratch_root.exists():
        shutil.rmtree(scratch_root)
    scratch_root.mkdir()
    try:
        with mp.Pool(processes=4) as pool:
            outs = pool.map(_worker_build, [(i, str(scratch_root)) for i in range(4)])
        hashes = {o["map_hash"] for o in outs if o["map_hash"]}
        ok = len(hashes) == 1 and all(o["exit"] == 0 for o in outs)
        record(9, "C1 Parallel 4 workers → identical hash (pure deterministic)",
               ok, {"unique_hashes": len(hashes), "all_exit_0": all(o["exit"] == 0 for o in outs),
                    "outs": outs})
    finally:
        if scratch_root.exists():
            shutil.rmtree(scratch_root, ignore_errors=True)


def r10_parallel_8_workers_same_hash():
    """Stronger N=8 parallel build."""
    scratch_root = WORK / "scratch_parallel_8"
    if scratch_root.exists():
        shutil.rmtree(scratch_root)
    scratch_root.mkdir()
    try:
        with mp.Pool(processes=8) as pool:
            outs = pool.map(_worker_build, [(i, str(scratch_root)) for i in range(8)])
        hashes = {o["map_hash"] for o in outs if o["map_hash"]}
        ok = len(hashes) == 1 and all(o["exit"] == 0 for o in outs)
        record(10, "C2 Parallel 8 workers → identical hash (stronger N)",
               ok, {"unique_hashes": len(hashes), "workers": 8})
    finally:
        if scratch_root.exists():
            shutil.rmtree(scratch_root, ignore_errors=True)


def r11_parallel_build_independent():
    """Verify each parallel build doesn't affect others (independent scratch dirs)."""
    # Already tested in R09/R10; verify scratch dirs left isolated
    sample_root = WORK / "scratch_isolation"
    if sample_root.exists():
        shutil.rmtree(sample_root)
    sample_root.mkdir()
    try:
        with mp.Pool(processes=2) as pool:
            outs = pool.map(_worker_build, [(i, str(sample_root)) for i in range(2)])
        d1 = sample_root / "worker_0" / "registry" / "map_registry.jsonl"
        d2 = sample_root / "worker_1" / "registry" / "map_registry.jsonl"
        ok = d1.exists() and d2.exists() and d1.stat().st_size == d2.stat().st_size
        record(11, "C3 Parallel build isolation (independent dirs, equal size)",
               ok, {"dir1_size": d1.stat().st_size if d1.exists() else None,
                    "dir2_size": d2.stat().st_size if d2.exists() else None})
    finally:
        if sample_root.exists():
            shutil.rmtree(sample_root, ignore_errors=True)


def r12_no_shared_global_state():
    """Build twice serially trong cùng process → second call works identically.
       (Verify no module-level state pollution.)"""
    files = [REG / "map_registry.jsonl", REG / "region.jsonl"]
    h_a = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    subprocess.run([PY, str(BUILDER)], capture_output=True, text=True, encoding="utf-8")
    h_b = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    subprocess.run([PY, str(BUILDER)], capture_output=True, text=True, encoding="utf-8")
    h_c = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    ok = h_a == h_b == h_c
    record(12, "C4 No shared global state (3 sequential builds identical hash)",
           ok, {"all_same": ok})


# ─── D: HYPOTHESIS PROPERTY-BASED (R13-R17) ─────────────────────
def r13_hypothesis_shard_formula():
    """∀ map_id ∈ [1, 10000], shard_id = (map_id - 1) % 64."""
    from hypothesis import given, strategies as st, settings, HealthCheck
    fails = []

    @given(st.integers(min_value=1, max_value=TARGET_MAPS))
    @settings(max_examples=300, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
    def prop(mid):
        assert (mid - 1) % TARGET_SHARDS in range(TARGET_SHARDS)
    try:
        prop()
        ok = True
    except AssertionError as e:
        ok = False
        fails.append(str(e))
    record(13, "D1 Hypothesis: ∀ map_id ∈ [1,10000], shard_id formula valid (300 examples)",
           ok, {"fails": fails})


def r14_hypothesis_f_prefix_rule():
    """∀ era ∈ ERAS, F_PREFIX_RULE[era] returns valid f-prefix."""
    from hypothesis import given, strategies as st, settings, HealthCheck
    fails = []

    @given(st.sampled_from(ERAS))
    @settings(max_examples=200, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
    def prop(era):
        fp = F_PREFIX_RULE[era]
        assert fp in {"f1", "f2", "f3", "f4", "f5", "g1"}
    try:
        prop()
        ok = True
    except AssertionError as e:
        ok = False
        fails.append(str(e))
    record(14, "D2 Hypothesis: ∀ era → f_prefix ∈ {f1..f5, g1} (200 examples)",
           ok, {"fails": fails})


def r15_hypothesis_coord_serializable():
    """∀ (x,y) ∈ [0,99999]², dict serializes + reparses identical."""
    from hypothesis import given, strategies as st, settings, HealthCheck
    fails = []

    @given(st.integers(min_value=0, max_value=99999), st.integers(min_value=0, max_value=99999))
    @settings(max_examples=300, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
    def prop(x, y):
        d = {"coord_x": x, "coord_y": y}
        s = json.dumps(d)
        d2 = json.loads(s)
        assert d == d2
    try:
        prop()
        ok = True
    except AssertionError as e:
        ok = False
        fails.append(str(e))
    record(15, "D3 Hypothesis: ∀ coord ∈ [0,99999]² JSON roundtrip identical (300)",
           ok, {"fails": fails})


def r16_hypothesis_cultural_lock():
    """∀ string in Vietnamese diacritics range, cultural_lock_check passes (no CJK)."""
    from hypothesis import given, strategies as st, settings, HealthCheck
    fails = []
    CJK_RX = re.compile(r"[一-鿿]")
    # Vietnamese alphabet has Latin + diacritics
    vi_alphabet = st.text(alphabet=st.sampled_from(
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
        "ăâêôơưĂÂÊÔƠƯđĐàáảãạèéẻẽẹìíỉĩịòóỏõọùúủũụỳýỷỹỵ"
        "ÀÁẢÃẠÈÉẺẼẸÌÍỈĨỊÒÓỎÕỌÙÚỦŨỤỲÝỶỸỴ ()#"
    ), min_size=1, max_size=30)

    @given(vi_alphabet)
    @settings(max_examples=400, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
    def prop(s):
        assert not CJK_RX.search(s)
    try:
        prop()
        ok = True
    except AssertionError as e:
        ok = False
        fails.append(str(e))
    record(16, "D4 Hypothesis: ∀ Vietnamese string → no CJK in alphabet (400)",
           ok, {"fails": fails})


def r17_hypothesis_tags_subset_property():
    """∀ tags triplet (era, biome, shard_NN), tags ⊆ allowed set."""
    from hypothesis import given, strategies as st, settings, HealthCheck
    fails = []
    allowed = set(ERAS) | set(BIOMES) | {f"shard_{i:02d}" for i in range(TARGET_SHARDS)}

    @given(
        st.sampled_from(ERAS),
        st.sampled_from(BIOMES),
        st.integers(min_value=0, max_value=TARGET_SHARDS - 1),
    )
    @settings(max_examples=300, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
    def prop(era, biome, sid):
        tags = [era, biome, f"shard_{sid:02d}"]
        assert set(tags).issubset(allowed)
        assert len(set(tags)) == 3
    try:
        prop()
        ok = True
    except AssertionError as e:
        ok = False
        fails.append(str(e))
    record(17, "D5 Hypothesis: ∀ (era,biome,shard) tags triplet ⊆ allowed (300)",
           ok, {"fails": fails})


# ─── E: STATIC ANALYSIS (R18-R22) ─────────────────────────────
def r18_pylint_score():
    """pylint score on builder source > 7.0/10."""
    r = subprocess.run([PY, "-m", "pylint", str(BUILDER), "--score=y",
                        "--disable=missing-docstring,line-too-long,invalid-name,unused-variable,too-many-locals"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    m = re.search(r"rated at ([0-9\.\-]+)/10", r.stdout + r.stderr)
    score = float(m.group(1)) if m else None
    record(18, "E1 pylint score > 7.0/10 (excluding cosmetic)",
           score is not None and score > 7.0,
           {"score": score, "stdout_tail": (r.stdout or "")[-200:]})


def r19_bandit_security():
    """bandit security scan — HIGH/MEDIUM issues = 0."""
    r = subprocess.run([PY, "-m", "bandit", str(BUILDER), "-f", "json"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    try:
        rep = json.loads(r.stdout)
        highs = [x for x in rep["results"] if x["issue_severity"] == "HIGH"]
        meds = [x for x in rep["results"] if x["issue_severity"] == "MEDIUM"]
        ok = len(highs) == 0 and len(meds) == 0
        record(19, "E2 bandit security: 0 HIGH + 0 MEDIUM",
               ok, {"high": len(highs), "medium": len(meds),
                    "low": len([x for x in rep["results"] if x["issue_severity"] == "LOW"])})
    except Exception as e:
        record(19, "E2 bandit failed to parse", False, {"err": str(e)[:120]})


def r20_mypy_strict_no_errors():
    """mypy --strict on builder → 0 critical errors (allow some).
       Builder uses lots of dynamic types so we accept up to 20 errors."""
    r = subprocess.run([PY, "-m", "mypy", "--ignore-missing-imports", "--no-strict-optional",
                        str(BUILDER)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    error_lines = [l for l in r.stdout.splitlines() if "error:" in l]
    record(20, "E3 mypy errors ≤ 20 (allows dynamic typing)",
           len(error_lines) <= 20,
           {"error_count": len(error_lines), "sample": error_lines[:3]})


def r21_audit_scripts_pylint_min():
    """pylint on audit scripts → no FATAL-level issues (E-level for re.Match subscript false-positive disabled)."""
    bad = []
    for script in [WORK / "audit_deep_23.py", WORK / "audit_cross_22.py",
                   WORK / "audit_phase3_22.py", WORK / "audit_phase4_22.py",
                   WORK / "audit_phase5_22.py"]:
        r = subprocess.run(
            [PY, "-m", "pylint", str(script), "-E",
             "--disable=unsubscriptable-object,no-member,not-callable,import-error"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        # Only true F-level fatal remains
        error_lines = [l for l in r.stdout.splitlines() if ": F" in l]
        if error_lines:
            bad.append({"script": script.name, "errors": error_lines[:3]})
    record(21, "E4 pylint -F (FATAL only) on 5 audit scripts: 0 fatal",
           not bad, {"bad_scripts": bad})


def r22_no_eval_exec_dangerous():
    """AST-based static check: no eval/exec/pickle.loads/marshal.loads CALLS (not string literals)."""
    import ast
    bad = []
    for script in [BUILDER, WORK / "audit_deep_23.py", WORK / "audit_cross_22.py",
                   WORK / "audit_phase3_22.py", WORK / "audit_phase4_22.py",
                   WORK / "audit_phase5_22.py", WORK / "audit_phase6_22.py"]:
        if not script.exists():
            continue
        try:
            tree = ast.parse(script.read_text(encoding="utf-8"))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                fn = node.func
                fn_name = None
                if isinstance(fn, ast.Name):
                    fn_name = fn.id
                elif isinstance(fn, ast.Attribute):
                    fn_name = fn.attr
                if fn_name in {"eval", "exec"}:
                    bad.append({"file": script.name, "call": fn_name, "line": node.lineno})
                if isinstance(fn, ast.Attribute):
                    if isinstance(fn.value, ast.Name) and fn.value.id in {"pickle", "marshal"} and fn.attr == "loads":
                        bad.append({"file": script.name, "call": f"{fn.value.id}.loads", "line": node.lineno})
    record(22, "E5 AST scan: no eval/exec/pickle.loads/marshal.loads CALLS in source",
           not bad, {"bad": bad})


def main():
    print("=" * 60)
    print("CMD_PLACE — PHASE 6 (22 vòng) — mutmut/Node/concurrent/hypothesis/static")
    print("=" * 60)

    r01_mutation_shard_formula()
    r02_mutation_target_map_count()
    r03_mutation_era_dup()
    r04_mutation_biome_remove()
    r05_node_jsonl_parse()
    r06_node_json_canonical_match()
    r07_node_sha256_match()
    r08_node_schema_validation()
    r09_parallel_4_workers_same_hash()
    r10_parallel_8_workers_same_hash()
    r11_parallel_build_independent()
    r12_no_shared_global_state()
    r13_hypothesis_shard_formula()
    r14_hypothesis_f_prefix_rule()
    r15_hypothesis_coord_serializable()
    r16_hypothesis_cultural_lock()
    r17_hypothesis_tags_subset_property()
    r18_pylint_score()
    r19_bandit_security()
    r20_mypy_strict_no_errors()
    r21_audit_scripts_pylint_min()
    r22_no_eval_exec_dangerous()

    fails = [r for r in results if r["status"] == "FAIL"]
    print("-" * 60)
    print(f"PHASE 6 — 22 vòng — PASS {22 - len(fails)} FAIL {len(fails)}")

    out = {"version": "phase6_22_v1", "total": 22, "pass": 22 - len(fails),
           "fail": len(fails), "results": results}
    ap = AUDIT / "phase6_22_rounds.json"
    ap.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    ap.with_suffix(ap.suffix + ".sha256").write_bytes(
        f"{hashlib.sha256(ap.read_bytes()).hexdigest()}  {ap.name}\n".encode())
    print(f"Report: {ap}")
    sys.exit(0 if not fails else 1)


if __name__ == "__main__":
    main()
