#!/usr/bin/env python3
"""CMD_PLACE v1.0 — audit deep 23 vòng (logic-driven, NO hypothesis).

Mỗi round = invariant check thực tế trên artefact đã ship. Fail → report exact evidence.
Bám rules brief CMD_PLACE: R8 idempotent, R30 cultural lock, R31 F-prefix, R44/45/47/49/50,
R68.6 determinism unit test, R5.9 branch naming, R10.8 anti-snowball cap.
"""
from __future__ import annotations
import json, hashlib, re, sys, subprocess, time, os
from pathlib import Path
from collections import Counter, defaultdict

ROOT = Path(r"C:\Users\Administrator\Desktop\CMD_PLACE_WORK\svtk-status")
OUT = ROOT / "cmd-place" / "output"
REG = OUT / "registry"
SCHEMA = OUT / "schema"
TESTS = OUT / "tests"
BUILDER = Path(r"C:\Users\Administrator\Desktop\CMD_PLACE_WORK\build_place.py")

ERAS = ["ly", "tran", "le", "tay_son", "nguyen"]
BIOMES = ["forest", "mountain", "river", "plain", "sea", "capital", "village"]
TARGET_MAPS = 10000
TARGET_SHARDS = 64
F_PREFIX_VALID = {"f1", "f2", "f3", "f4", "f5", "g1"}

CJK = re.compile(r"[一-鿿]")
HIRAGANA = re.compile(r"[぀-ゟ]")
KATAKANA = re.compile(r"[゠-ヿ]")
TAM_QUOC = re.compile(
    r"(Tào Tháo|Lưu Bị|Quan Vũ|Trương Phi|Khổng Minh|Cao Cao|Liu Bei|Zhuge Liang|Guan Yu|Zhang Fei|Tam Quốc)"
)

ANTI_SNOWBALL_STAT_CAP = 2.5
ANTI_SNOWBALL_BUFF_CAP = 0.05


def split_block(total: int, parts: int) -> list[int]:
    base = total // parts
    extra = total - base * parts
    return [base + (1 if i < extra else 0) for i in range(parts)]


def load_maps() -> list[dict]:
    with open(REG / "map_registry.jsonl", encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def load_regions() -> list[dict]:
    with open(REG / "region.jsonl", encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def load_shard_config() -> dict:
    return json.loads((REG / "shard_config.json").read_text(encoding="utf-8"))


results: list[dict] = []


def record(round_no: int, name: str, ok: bool, evidence: dict | str):
    results.append({
        "round": round_no,
        "name": name,
        "status": "PASS" if ok else "FAIL",
        "evidence": evidence if isinstance(evidence, dict) else {"info": evidence},
    })
    flag = "PASS" if ok else "FAIL"
    print(f"R{round_no:02d} {flag} {name}")


def r01_map_id_range(maps):
    ids = sorted(m["map_id"] for m in maps)
    ok = ids[0] == 1 and ids[-1] == TARGET_MAPS and len(ids) == TARGET_MAPS
    record(1, "map_id range strict [1..7047]", ok, {"min": ids[0], "max": ids[-1], "count": len(ids)})


def r02_map_id_contiguous(maps):
    ids = sorted(m["map_id"] for m in maps)
    gaps = [i for i in range(1, TARGET_MAPS + 1) if i not in set(ids)]
    record(2, "map_id contiguous no gap (R50)", len(gaps) == 0, {"gap_count": len(gaps), "first_gaps": gaps[:5]})


def r03_map_id_unique(maps):
    ids = [m["map_id"] for m in maps]
    dups = [k for k, v in Counter(ids).items() if v > 1]
    record(3, "map_id unique (R45 anti-dupe)", len(dups) == 0, {"dup_count": len(dups), "dups_sample": dups[:5]})


def r04_natural_key_unique(maps):
    keys = [m["natural_key"] for m in maps]
    dups = [k for k, v in Counter(keys).items() if v > 1]
    record(4, "natural_key unique (R45/R50)", len(dups) == 0, {"dup_count": len(dups), "dups_sample": dups[:5]})


def r05_uuid_unique(maps):
    u = [m["uuid"] for m in maps]
    dups = [k for k, v in Counter(u).items() if v > 1]
    record(5, "uuid unique (R8.4 traceability)", len(dups) == 0, {"dup_count": len(dups)})


def r06_name_unique(maps):
    n = [m["name"] for m in maps]
    dups = [k for k, v in Counter(n).items() if v > 1]
    record(6, "name unique (display dedup)", len(dups) == 0, {"dup_count": len(dups), "dups_sample": dups[:5]})


def r07_era_distribution_exact(maps):
    counts = Counter(m["era"] for m in maps)
    expected = dict(zip(ERAS, split_block(TARGET_MAPS, len(ERAS))))
    actual = dict(counts)
    ok = actual == expected
    record(7, "era distribution exact match split_block (R49)",
           ok, {"expected": expected, "actual": actual})


def r08_biome_all_eras(maps):
    pairs = defaultdict(set)
    for m in maps:
        pairs[m["era"]].add(m["biome"])
    missing = {e: sorted(set(BIOMES) - b) for e, b in pairs.items() if set(BIOMES) - b}
    record(8, "each era covers all 7 biomes (R49)",
           len(missing) == 0, {"missing": missing or "none"})


def r09_shard_balance_delta(maps):
    counts = Counter(m["shard_id"] for m in maps)
    delta = max(counts.values()) - min(counts.values())
    record(9, "shard balance delta <= 2", delta <= 2,
           {"delta": delta, "min": min(counts.values()), "max": max(counts.values())})


def r10_shard_id_formula(maps):
    bad = [(m["map_id"], m["shard_id"]) for m in maps if m["shard_id"] != (m["map_id"] - 1) % TARGET_SHARDS]
    record(10, "shard_id == (map_id-1) % 64 (formula determinism)",
           len(bad) == 0, {"violations": len(bad), "sample": bad[:5]})


def r11_shard_code_format(maps):
    rx = re.compile(r"^R\d{2}$")
    bad = [m["shard_code"] for m in maps if not rx.match(m["shard_code"])]
    bad += [m["shard_code"] for m in maps if int(m["shard_code"][1:]) != m["shard_id"]]
    record(11, "shard_code format R\\d{2} + match shard_id",
           len(bad) == 0, {"bad_count": len(bad), "sample": bad[:5]})


def r12_f_prefix_per_era(maps):
    rule = {"ly": "f1", "tran": "f1", "le": "f2", "tay_son": "f3", "nguyen": "g1"}
    bad = [(m["map_id"], m["era"], m["f_prefix"]) for m in maps if m["f_prefix"] != rule[m["era"]]]
    record(12, "f_prefix per era mapping (R31)",
           len(bad) == 0, {"violations": len(bad), "sample": bad[:5]})


def r13_no_cjk(maps):
    bad = [m["name"] for m in maps if CJK.search(m["name"])]
    record(13, "no CJK Han characters (R30)", len(bad) == 0, {"bad_count": len(bad), "sample": bad[:5]})


def r14_no_hiragana_katakana(maps):
    bad_h = [m["name"] for m in maps if HIRAGANA.search(m["name"])]
    bad_k = [m["name"] for m in maps if KATAKANA.search(m["name"])]
    record(14, "no Hiragana/Katakana (R30)",
           not (bad_h or bad_k), {"hiragana": bad_h[:3], "katakana": bad_k[:3]})


def r15_no_tam_quoc(maps):
    bad = [m["name"] for m in maps if TAM_QUOC.search(m["name"])]
    record(15, "no Tam Quoc references (R30)", len(bad) == 0, {"bad_count": len(bad), "sample": bad[:5]})


def r16_coord_range(maps):
    bad = [m["map_id"] for m in maps if not (0 <= m["coord_x"] <= 99999 and 0 <= m["coord_y"] <= 99999)]
    record(16, "coord_x/y in [0,99999]", len(bad) == 0, {"bad_count": len(bad), "sample": bad[:5]})


def r17_tsonline_cross_ref(maps):
    rx = re.compile(r"^tsonline_map_pool/\d{4}\.jpg$")
    bad = [m["map_id"] for m in maps if not rx.match(m.get("tsonline_cross_ref", ""))]
    record(17, "tsonline_cross_ref format (R47)", len(bad) == 0, {"bad_count": len(bad), "sample": bad[:5]})


def r18_sha256_companion():
    bad = []
    for p in [REG / "region.jsonl", REG / "map_registry.jsonl", REG / "shard_config.json",
              SCHEMA / "place_table.sql", TESTS / "place_tests.py", OUT / "status.json"]:
        sp = p.with_suffix(p.suffix + ".sha256")
        if not sp.exists():
            bad.append({"file": p.name, "issue": "sha256_missing"})
            continue
        expected = sp.read_text(encoding="utf-8").strip().split()[0]
        actual = hashlib.sha256(p.read_bytes()).hexdigest()
        if expected != actual:
            bad.append({"file": p.name, "expected": expected, "actual": actual})
    record(18, "SHA256 companion match actual (R8 idempotent)", len(bad) == 0, {"violations": bad})


def r19_schema_unique_constraints():
    sql = (SCHEMA / "place_table.sql").read_text(encoding="utf-8")
    needed = ["UNIQUE(map_id)", "UNIQUE(natural_key)", "UNIQUE(uuid)",
              "CHECK (map_id BETWEEN 1 AND 10000)",
              "CHECK (era IN ('ly','tran','le','tay_son','nguyen'))",
              "CHECK (biome IN ('forest','mountain','river','plain','sea','capital','village'))",
              "CHECK (shard_id BETWEEN 0 AND 63)",
              "place_region"]
    missing = [n for n in needed if n not in sql]
    record(19, "schema UNIQUE + CHECK constraints (R8.3/R44/R50)", len(missing) == 0, {"missing": missing})


def r20_region_consistent_with_maps(maps, regions):
    actual = Counter(m["shard_id"] for m in maps)
    bad = []
    for r in regions:
        if r["actual_map_count"] != actual[r["shard_id"]]:
            bad.append({"shard_id": r["shard_id"], "region_count": r["actual_map_count"],
                       "map_count": actual[r["shard_id"]]})
    record(20, "region.actual_map_count consistent với map_registry",
           len(bad) == 0, {"mismatches": bad[:5], "count": len(bad)})


def r21_shard_config_consistent(maps, cfg):
    actual = Counter(m["shard_id"] for m in maps)
    bad = []
    for i, v in enumerate(cfg["shard_size_actual"]):
        if actual[i] != v:
            bad.append({"shard_id": i, "config": v, "map_count": actual[i]})
    total_ok = sum(cfg["shard_size_actual"]) == TARGET_MAPS
    record(21, "shard_config consistent + sum=7047",
           len(bad) == 0 and total_ok, {"mismatches": bad[:5], "total_ok": total_ok})


def r22_jsonl_parseability():
    bad = []
    for p in [REG / "region.jsonl", REG / "map_registry.jsonl"]:
        for ln, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                json.loads(line)
            except json.JSONDecodeError as e:
                bad.append({"file": p.name, "line": ln, "err": str(e)[:80]})
                if len(bad) > 10:
                    break
    record(22, "JSONL strict parseability", len(bad) == 0, {"errors": bad[:5]})


def r23_deterministic_rebuild():
    """R68.6 — rerun builder, verify same SHA256 cho registry files (replay determinism)."""
    before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in [REG / "region.jsonl", REG / "map_registry.jsonl", REG / "shard_config.json"]}
    r = subprocess.run([sys.executable, str(BUILDER)], capture_output=True, text=True, encoding="utf-8")
    after = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
             for p in [REG / "region.jsonl", REG / "map_registry.jsonl", REG / "shard_config.json"]}
    diffs = {k: {"before": before[k], "after": after[k]} for k in before if before[k] != after[k]}
    ok = not diffs and r.returncode == 0
    record(23, "deterministic rebuild same hash (R68.6)",
           ok, {"rebuild_exit": r.returncode, "diffs": diffs})


def main():
    print("=" * 60)
    print("CMD_PLACE v1.0 — AUDIT DEEP 23 vòng")
    print("=" * 60)

    maps = load_maps()
    regions = load_regions()
    cfg = load_shard_config()

    r01_map_id_range(maps)
    r02_map_id_contiguous(maps)
    r03_map_id_unique(maps)
    r04_natural_key_unique(maps)
    r05_uuid_unique(maps)
    r06_name_unique(maps)
    r07_era_distribution_exact(maps)
    r08_biome_all_eras(maps)
    r09_shard_balance_delta(maps)
    r10_shard_id_formula(maps)
    r11_shard_code_format(maps)
    r12_f_prefix_per_era(maps)
    r13_no_cjk(maps)
    r14_no_hiragana_katakana(maps)
    r15_no_tam_quoc(maps)
    r16_coord_range(maps)
    r17_tsonline_cross_ref(maps)
    r18_sha256_companion()
    r19_schema_unique_constraints()
    r20_region_consistent_with_maps(maps, regions)
    r21_shard_config_consistent(maps, cfg)
    r22_jsonl_parseability()
    r23_deterministic_rebuild()

    fails = [r for r in results if r["status"] == "FAIL"]
    print("-" * 60)
    print(f"TOTAL 23 rounds — PASS {23 - len(fails)} FAIL {len(fails)}")
    out = {
        "version": "deep_23_v1",
        "total": 23,
        "pass": 23 - len(fails),
        "fail": len(fails),
        "results": results,
    }
    audit_dir = OUT / "audit"
    audit_dir.mkdir(parents=True, exist_ok=True)
    ap = audit_dir / "deep_23_rounds.json"
    ap.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    sp = ap.with_suffix(ap.suffix + ".sha256")
    sp.write_text(f"{hashlib.sha256(ap.read_bytes()).hexdigest()}  {ap.name}\n", encoding="utf-8")
    print(f"Report: {ap}")
    sys.exit(0 if not fails else 1)


if __name__ == "__main__":
    main()
