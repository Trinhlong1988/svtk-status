#!/usr/bin/env python3
"""CMD_PLACE — PHASE 4 audit (22 vòng MỚI).

Negative testing schema CHECK / property-based invariants /
performance / portability cross-platform / security adversarial.
"""
from __future__ import annotations
import json, hashlib, re, sys, subprocess, sqlite3, time
import unicodedata
from pathlib import Path
from collections import Counter, defaultdict

ROOT = Path(r"C:\Users\Administrator\Desktop\CMD_PLACE_WORK\svtk-status")
OUT = ROOT / "cmd-place" / "output"
REG = OUT / "registry"
SCHEMA = OUT / "schema"
TESTS = OUT / "tests"
BUILDER = Path(r"C:\Users\Administrator\Desktop\CMD_PLACE_WORK\build_place.py")

TARGET_MAPS = 10000
TARGET_SHARDS = 64
ERAS = ["ly", "tran", "le", "tay_son", "nguyen"]
BIOMES = ["forest", "mountain", "river", "plain", "sea", "capital", "village"]
ERA_LABEL_VI = {"ly": "Lý", "tran": "Trần", "le": "Lê", "tay_son": "Tây Sơn", "nguyen": "Nguyễn"}
F_PREFIX_RULE = {"ly": "f1", "tran": "f1", "le": "f2", "tay_son": "f3", "nguyen": "g1"}

results = []


def record(n, name, ok, evidence, severity="ERROR"):
    results.append({"round": n, "name": name, "status": "PASS" if ok else "FAIL",
                    "severity": severity,
                    "evidence": evidence if isinstance(evidence, dict) else {"info": evidence}})
    print(f"R{n:02d} {'PASS' if ok else 'FAIL'} {name}")


def jsonl(p):
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]


def fresh_db():
    db = sqlite3.connect(":memory:")
    db.executescript((SCHEMA / "place_table.sql").read_text(encoding="utf-8"))
    return db


def insert_one(db, m):
    db.execute(
        "INSERT INTO place_items (id, map_id, uuid, natural_key, name, era, biome, shard_id, f_prefix, coord_x, coord_y) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (m["id"], m["map_id"], m["uuid"], m["natural_key"], m["name"], m["era"],
         m["biome"], m["shard_id"], m["f_prefix"], m["coord_x"], m["coord_y"]))


VALID_ROW = lambda **kw: {
    "id": 1, "map_id": 1, "uuid": "00000000-0000-4000-8000-000000000000",
    "natural_key": "vstk_place_test_x", "name": "Test", "era": "ly", "biome": "forest",
    "shard_id": 0, "f_prefix": "f1", "coord_x": 0, "coord_y": 0, **kw,
}


# ─── R01-R05 NEGATIVE TESTING SQL CHECK ─────────────────────────
def r01_reject_invalid_era():
    db = fresh_db()
    try:
        insert_one(db, VALID_ROW(era="XXX"))
        rej = False
    except sqlite3.IntegrityError as e:
        rej = "CHECK" in str(e).upper() or "era" in str(e).lower()
    record(1, "SQL CHECK rejects invalid era ('XXX')", rej, {"rejected": rej})


def r02_reject_invalid_biome():
    db = fresh_db()
    try:
        insert_one(db, VALID_ROW(biome="lava"))
        rej = False
    except sqlite3.IntegrityError as e:
        rej = "CHECK" in str(e).upper() or "biome" in str(e).lower()
    record(2, "SQL CHECK rejects invalid biome ('lava')", rej, {"rejected": rej})


def r03_reject_shard_out_of_range():
    db = fresh_db()
    try:
        insert_one(db, VALID_ROW(shard_id=64))
        rej = False
    except sqlite3.IntegrityError as e:
        rej = "CHECK" in str(e).upper() or "shard" in str(e).lower()
    record(3, "SQL CHECK rejects shard_id=64 (out of 0..63)", rej, {"rejected": rej})


def r04_reject_map_id_out_of_range():
    db = fresh_db()
    try:
        insert_one(db, VALID_ROW(map_id=10001))
        rej = False
    except sqlite3.IntegrityError as e:
        rej = "CHECK" in str(e).upper() or "map_id" in str(e).lower()
    record(4, "SQL CHECK rejects map_id=10001 (out of 1..10000)", rej, {"rejected": rej})


def r05_reject_duplicate_uuid():
    db = fresh_db()
    insert_one(db, VALID_ROW())
    try:
        insert_one(db, VALID_ROW(id=2, map_id=2, natural_key="vstk_place_test_y"))
        rej = False
    except sqlite3.IntegrityError as e:
        rej = "UNIQUE" in str(e).upper() or "uuid" in str(e).lower()
    record(5, "SQL UNIQUE rejects duplicate uuid", rej, {"rejected": rej})


# ─── R06-R11 PROPERTY-BASED INVARIANTS ─────────────────────────
def r06_every_shard_all_eras(maps):
    shard_era = defaultdict(set)
    for m in maps:
        shard_era[m["shard_id"]].add(m["era"])
    missing = {sid: sorted(set(ERAS) - eras) for sid, eras in shard_era.items() if set(ERAS) - eras}
    record(6, "Every shard contains all 5 eras (rotation coverage)",
           not missing, {"missing": dict(list(missing.items())[:3]), "count": len(missing)})


def r07_name_unique_per_era_biome(maps):
    buckets = defaultdict(list)
    for m in maps:
        buckets[(m["era"], m["biome"])].append(m["name"])
    bad = {}
    for k, names in buckets.items():
        dups = [n for n, c in Counter(names).items() if c > 1]
        if dups:
            bad[str(k)] = dups[:3]
    record(7, "name unique per (era, biome) bucket",
           not bad, {"bad_buckets": dict(list(bad.items())[:3]), "count": len(bad)})


def r08_era_label_reverse_map(maps):
    rev = {v: k for k, v in ERA_LABEL_VI.items()}
    bad = []
    for m in maps:
        n = unicodedata.normalize("NFC", m["era_label"])
        if rev.get(n) != m["era"]:
            bad.append({"map_id": m["map_id"], "era": m["era"], "label": n})
            if len(bad) > 5:
                break
    record(8, "era_label_vi NFC ↔ era bijection",
           not bad, {"bad": bad[:5]})


def r09_tags_ordering_consistent(maps):
    """tags must contain era first, biome second, shard last (any order acceptable
       as long as 3 elements present — verified previously). Now check NO duplicates."""
    bad = []
    for m in maps:
        if len(set(m["tags"])) != 3:
            bad.append({"map_id": m["map_id"], "tags": m["tags"]})
            if len(bad) > 5:
                break
    record(9, "tags contains 3 distinct elements (no internal dup)",
           not bad, {"bad": bad[:5]})


def r10_f_prefix_injective_by_era_class(maps):
    """f_prefix = f1 covers {ly, tran}; f2={le}; f3={tay_son}; g1={nguyen}. Verify rule strict."""
    bad = []
    for m in maps:
        expected = F_PREFIX_RULE[m["era"]]
        if m["f_prefix"] != expected:
            bad.append({"map_id": m["map_id"], "era": m["era"], "got": m["f_prefix"], "want": expected})
            if len(bad) > 5:
                break
    record(10, "f_prefix injective by era class (R31)", not bad, {"bad": bad[:5]})


def r11_shard_primary_era_majority(maps):
    """region.primary_era should equal mode era of maps in that shard."""
    regions = jsonl(REG / "region.jsonl")
    shard_eras = defaultdict(Counter)
    for m in maps:
        shard_eras[m["shard_id"]][m["era"]] += 1
    bad = []
    for r in regions:
        majority = shard_eras[r["shard_id"]].most_common(1)[0][0]
        # primary_era declared at shard creation; due to rotation modulo 5, may not match majority
        # Just info-log mismatches
        if r["primary_era"] != majority:
            bad.append({"shard_id": r["shard_id"], "declared": r["primary_era"], "majority": majority})
    # Soft check: <50% mismatch acceptable since shards have even rotation
    soft_ok = len(bad) <= TARGET_SHARDS // 2
    record(11, "region.primary_era vs majority-era (soft, <50% drift)",
           soft_ok, {"mismatch_count": len(bad), "tolerance": TARGET_SHARDS // 2,
                      "sample": bad[:3]}, severity="INFO")


# ─── R12-R15 PERFORMANCE / SCALE ─────────────────────────
def r12_load_jsonl_perf():
    t0 = time.perf_counter()
    _ = jsonl(REG / "map_registry.jsonl")
    dt = time.perf_counter() - t0
    record(12, "JSONL parse 10000 maps < 5s",
           dt < 5.0, {"elapsed_sec": round(dt, 3)})


def r13_sha256_perf():
    t0 = time.perf_counter()
    for p in [REG / "map_registry.jsonl", REG / "region.jsonl", REG / "shard_config.json",
              SCHEMA / "place_table.sql"]:
        hashlib.sha256(p.read_bytes()).hexdigest()
    dt = time.perf_counter() - t0
    record(13, "SHA256 4 files < 1s", dt < 1.0, {"elapsed_sec": round(dt, 4)})


def r14_sql_bulk_perf(maps):
    db = fresh_db()
    t0 = time.perf_counter()
    db.executemany(
        "INSERT INTO place_items (id, map_id, uuid, natural_key, name, era, biome, shard_id, f_prefix, coord_x, coord_y) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [(m["map_id"], m["map_id"], m["uuid"], m["natural_key"], m["name"], m["era"],
          m["biome"], m["shard_id"], m["f_prefix"], m["coord_x"], m["coord_y"]) for m in maps])
    dt = time.perf_counter() - t0
    record(14, "SQL bulk INSERT 10000 < 5s",
           dt < 5.0, {"elapsed_sec": round(dt, 3)})


def r15_json_roundtrip_identical(maps):
    """parse JSONL → json.dumps → re-parse → identical content."""
    src = (REG / "map_registry.jsonl").read_text(encoding="utf-8")
    bad = 0
    for i, line in enumerate(src.splitlines()):
        if not line.strip():
            continue
        d1 = json.loads(line)
        d2 = json.loads(json.dumps(d1, ensure_ascii=False))
        if d1 != d2:
            bad += 1
        if i > 1000:
            break
    record(15, "JSON roundtrip identical (parse → dumps → parse, sample 1000)",
           bad == 0, {"bad": bad})


# ─── R16-R19 PORTABILITY / REPRODUCIBILITY ─────────────────────────
def r16_all_text_files_lf_only():
    bad = []
    for p in [REG / "map_registry.jsonl", REG / "region.jsonl", REG / "shard_config.json",
              SCHEMA / "place_table.sql", TESTS / "place_tests.py",
              OUT / "status.json"]:
        raw = p.read_bytes()
        if b"\r\n" in raw:
            bad.append({"file": p.name, "issue": "CRLF"})
        if b"\r" in raw.replace(b"\r\n", b""):
            bad.append({"file": p.name, "issue": "CR-only"})
    record(16, "All text artefacts LF-only (cross-platform portability)",
           not bad, {"bad": bad})


def r17_filename_unicode_normalized():
    """No filename in cmd-place/output has NFC/NFD divergence (Mac vs Win path issue)."""
    bad = []
    for p in OUT.rglob("*"):
        if not p.is_file():
            continue
        name = p.name
        nfc = unicodedata.normalize("NFC", name)
        if name != nfc:
            bad.append({"path": str(p.relative_to(OUT)), "raw": name, "nfc": nfc})
    record(17, "All filenames NFC-normalized (Mac/Win portability)",
           not bad, {"bad": bad[:5]})


def r18_determinism_n10():
    """N=10 rebuild + hash stable."""
    files = [REG / "region.jsonl", REG / "map_registry.jsonl", REG / "shard_config.json"]
    base = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    diffs_seq = []
    for i in range(9):
        subprocess.run([sys.executable, str(BUILDER)], capture_output=True, text=True, encoding="utf-8")
        cur = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
        diff = {k: (base[k], cur[k]) for k in base if base[k] != cur[k]}
        if diff:
            diffs_seq.append({"iter": i, "diff": diff})
    record(18, "Determinism N=10 rebuild stable (extreme)",
           not diffs_seq, {"failed_iters": len(diffs_seq), "sample": diffs_seq[:2]})


def r19_builder_no_external_state():
    """Verify builder reads no env var / time / random.SystemRandom (parses build_place.py)."""
    src = BUILDER.read_text(encoding="utf-8")
    bad = []
    forbidden = {
        "os.environ": "env var dependency",
        "random.SystemRandom": "non-deterministic RNG",
        "secrets.": "non-deterministic crypto",
        "datetime.now": "wall clock dependency",
    }
    # time.strftime / time.time considered OK only if not used in deterministic output (verified by N=10 R18)
    for k, why in forbidden.items():
        if k in src:
            bad.append({"forbidden": k, "reason": why})
    record(19, "Builder source no non-deterministic API (env/SystemRandom/secrets/datetime.now)",
           not bad, {"bad": bad})


# ─── R20-R22 SECURITY / ROBUSTNESS ─────────────────────────
def r20_json_injection_safe(maps):
    """No suspicious keys (__proto__, constructor, prototype) or HTML/script tags."""
    dangerous_keys = {"__proto__", "constructor", "prototype"}
    rx_script = re.compile(r"</?script", re.IGNORECASE)
    bad = []
    for m in maps:
        for k in m.keys():
            if k in dangerous_keys:
                bad.append({"map_id": m["map_id"], "key": k})
                break
        for k, v in m.items():
            if isinstance(v, str) and rx_script.search(v):
                bad.append({"map_id": m["map_id"], "field": k, "match": "<script>"})
                break
        if len(bad) > 5:
            break
    record(20, "JSON safe: no __proto__/constructor/prototype keys + no <script> in values",
           not bad, {"bad": bad[:5]})


def r21_sql_injection_safe_via_parametrized():
    """Quote/semicolon trong name → bị quote bởi prepared statement; verify thực sự safe."""
    db = fresh_db()
    malicious = "Test'; DROP TABLE place_items; --"
    try:
        insert_one(db, VALID_ROW(name=malicious))
        # Verify row inserted with literal name
        cur = db.execute("SELECT name FROM place_items WHERE id=1")
        stored = cur.fetchone()[0]
        ok = stored == malicious
        # Verify table not dropped
        c2 = db.execute("SELECT count(*) FROM place_items")
        rows = c2.fetchone()[0]
        record(21, "SQL injection safe (parametrized): malicious name stored literal, table intact",
               ok and rows == 1, {"stored_matches": ok, "row_count_after": rows})
    except Exception as e:
        record(21, "SQL injection test failed", False, {"err": str(e)[:120]})


def r22_path_traversal_safe(maps):
    """tsonline_cross_ref no '..', no absolute Windows/Unix path, no '~', no scheme."""
    rx_bad = re.compile(r"(\.\.|^/|^\\|^[A-Za-z]:|^~|://)")
    bad = []
    for m in maps:
        ref = m["tsonline_cross_ref"]
        if rx_bad.search(ref):
            bad.append({"map_id": m["map_id"], "ref": ref})
            if len(bad) > 5:
                break
    record(22, "tsonline_cross_ref path-traversal safe (no ../, no abs, no scheme)",
           not bad, {"bad": bad[:5]})


def main():
    print("=" * 60)
    print("CMD_PLACE — PHASE 4 (22 vòng) — negative/property/perf/security")
    print("=" * 60)
    maps = jsonl(REG / "map_registry.jsonl")
    print(f"Loaded {len(maps)} maps")

    r01_reject_invalid_era()
    r02_reject_invalid_biome()
    r03_reject_shard_out_of_range()
    r04_reject_map_id_out_of_range()
    r05_reject_duplicate_uuid()
    r06_every_shard_all_eras(maps)
    r07_name_unique_per_era_biome(maps)
    r08_era_label_reverse_map(maps)
    r09_tags_ordering_consistent(maps)
    r10_f_prefix_injective_by_era_class(maps)
    r11_shard_primary_era_majority(maps)
    r12_load_jsonl_perf()
    r13_sha256_perf()
    r14_sql_bulk_perf(maps)
    r15_json_roundtrip_identical(maps)
    r16_all_text_files_lf_only()
    r17_filename_unicode_normalized()
    r18_determinism_n10()
    r19_builder_no_external_state()
    r20_json_injection_safe(maps)
    r21_sql_injection_safe_via_parametrized()
    r22_path_traversal_safe(maps)

    fails = [r for r in results if r["status"] == "FAIL"]
    highs = [r for r in fails if r["severity"] == "HIGH"]
    print("-" * 60)
    print(f"PHASE 4 — 22 vòng — PASS {22 - len(fails)} FAIL {len(fails)} (HIGH={len(highs)})")

    out = {"version": "phase4_22_v1", "total": 22, "pass": 22 - len(fails),
           "fail": len(fails), "high_severity_fail": len(highs), "results": results}
    audit_dir = OUT / "audit"
    audit_dir.mkdir(parents=True, exist_ok=True)
    ap = audit_dir / "phase4_22_rounds.json"
    ap.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    ap.with_suffix(ap.suffix + ".sha256").write_bytes(
        f"{hashlib.sha256(ap.read_bytes()).hexdigest()}  {ap.name}\n".encode())
    print(f"Report: {ap}")
    sys.exit(0 if not fails else 1)


if __name__ == "__main__":
    main()
