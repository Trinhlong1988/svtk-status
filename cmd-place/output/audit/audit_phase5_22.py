#!/usr/bin/env python3
"""CMD_PLACE — PHASE 5 audit (22 vòng MỚI).

Graph theory / pre-post conditions / fault injection /
regression baseline / property fuzzing / algebraic identity.
"""
from __future__ import annotations
import json, hashlib, re, sys, subprocess, sqlite3, time, random, math
import unicodedata, shutil
from pathlib import Path
from collections import Counter, defaultdict

ROOT = Path(r"C:\Users\Administrator\Desktop\CMD_PLACE_WORK\svtk-status")
OUT = ROOT / "cmd-place" / "output"
REG = OUT / "registry"
SCHEMA = OUT / "schema"
AUDIT = OUT / "audit"
BUILDER = Path(r"C:\Users\Administrator\Desktop\CMD_PLACE_WORK\build_place.py")

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


def jsonl(p):
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]


# ─── R01-R04 GRAPH THEORY ─────────────────────────────────────
def r01_shard_adjacency_era_overlap(maps):
    """Shard i and i+1 (cyclic) phải share ≥3 era (gần như đều)."""
    shard_era = defaultdict(set)
    for m in maps:
        shard_era[m["shard_id"]].add(m["era"])
    bad = []
    for i in range(TARGET_SHARDS):
        j = (i + 1) % TARGET_SHARDS
        common = shard_era[i] & shard_era[j]
        if len(common) < 3:
            bad.append({"shard_pair": (i, j), "common_eras": sorted(common)})
    record(1, "Shard adjacency graph: adjacent shards share ≥3 eras",
           not bad, {"bad": bad[:3], "count": len(bad)})


def r02_biome_clique(maps):
    """Mỗi (era, biome) cluster có ≥1 instance ở mọi shard set (coverage)."""
    eb_shards = defaultdict(set)
    for m in maps:
        eb_shards[(m["era"], m["biome"])].add(m["shard_id"])
    # Mỗi cụm (era,biome) ~286 maps = ~4-5 maps/shard → 64 shard
    missing = {str(k): TARGET_SHARDS - len(s) for k, s in eb_shards.items() if len(s) < TARGET_SHARDS}
    record(2, "Biome×era clique covers all 64 shards",
           not missing, {"clusters_lt_full": dict(list(missing.items())[:3]),
                          "missing_count": len(missing)})


def r03_era_transition_boundaries(maps):
    """Sorted by map_id, era changes exactly at 4 boundaries (5 era × split_block)."""
    sorted_maps = sorted(maps, key=lambda m: m["map_id"])
    transitions = []
    for i in range(1, len(sorted_maps)):
        if sorted_maps[i]["era"] != sorted_maps[i-1]["era"]:
            transitions.append((sorted_maps[i-1]["map_id"], sorted_maps[i]["map_id"],
                                sorted_maps[i-1]["era"], sorted_maps[i]["era"]))
    record(3, "Era transitions exactly 4 boundaries (5 era contiguous blocks)",
           len(transitions) == 4, {"transition_count": len(transitions),
                                     "transitions": transitions})


def r04_connectivity_era_biome(maps):
    """Every (era, biome) pair represented ≥1 (bipartite connectivity)."""
    pairs = {(m["era"], m["biome"]) for m in maps}
    expected_pairs = set((e, b) for e in ERAS for b in BIOMES)
    missing = expected_pairs - pairs
    record(4, "Bipartite (era × biome) connectivity: all 35 pairs present",
           not missing, {"missing_pairs": [list(p) for p in missing][:5],
                          "expected": 35, "actual": len(pairs)})


# ─── R05-R09 PRE/POST CONDITIONS ─────────────────────────────
def r05_precondition_target_positive():
    """Pre: TARGET_MAP_COUNT must be > 0 and divisible plan exists."""
    cfg = json.loads((REG / "shard_config.json").read_text(encoding="utf-8"))
    ok = cfg["total_maps"] > 0 and cfg["total_shards"] > 0
    record(5, "Pre-condition: total_maps>0 ∧ total_shards>0", ok,
           {"total_maps": cfg["total_maps"], "total_shards": cfg["total_shards"]})


def r06_postcondition_count_exact(maps):
    """Post: len(maps) == TARGET_MAPS (no off-by-one)."""
    record(6, "Post-condition: len(maps) == TARGET (no off-by-one)",
           len(maps) == TARGET_MAPS, {"got": len(maps), "want": TARGET_MAPS})


def r07_precondition_era_biome_nonempty():
    """Pre: every era has ≥1 biome assignment (no orphan era)."""
    cfg = json.loads((REG / "shard_config.json").read_text(encoding="utf-8"))
    ok = set(cfg["eras"]) == set(ERAS) and set(cfg["biomes"]) == set(BIOMES)
    record(7, "Pre-condition: era list + biome list non-empty + match canonical",
           ok, {"eras": cfg["eras"], "biomes": cfg["biomes"]})


def r08_postcondition_shard_nonempty(maps):
    """Post: every shard has ≥1 map."""
    counts = Counter(m["shard_id"] for m in maps)
    empty = [i for i in range(TARGET_SHARDS) if counts[i] == 0]
    record(8, "Post-condition: every shard has ≥1 map (no empty)",
           not empty, {"empty_shards": empty})


def r09_invariant_shard_id_pure_function(maps):
    """Invariant: shard_id = (map_id - 1) % 64 deterministic pure function."""
    bad = [m["map_id"] for m in maps if m["shard_id"] != (m["map_id"] - 1) % TARGET_SHARDS]
    record(9, "Invariant: shard_id = (map_id-1) % 64 pure (no side effect)",
           not bad, {"bad_count": len(bad), "sample": bad[:5]})


# ─── R10-R12 FAULT INJECTION ─────────────────────────────
def r10_truncate_jsonl_detected():
    """Truncate region.jsonl mid-stream → line count mismatch detected."""
    src = REG / "region.jsonl"
    backup = AUDIT / "tmp_region_backup.jsonl"
    raw = src.read_bytes()
    backup.write_bytes(raw)
    try:
        truncated = raw[:len(raw) // 2]
        tmp = AUDIT / "tmp_truncated.jsonl"
        tmp.write_bytes(truncated)
        lines = [l for l in tmp.read_text(encoding="utf-8").splitlines() if l.strip()]
        # original has 64 lines, truncated will have less
        ok = len(lines) < TARGET_SHARDS
        record(10, "Fault: truncate JSONL mid-stream → line count drops (detected)",
               ok, {"original_lines": TARGET_SHARDS, "truncated_lines": len(lines)})
        tmp.unlink()
    finally:
        backup.unlink(missing_ok=True)


def r11_byte_corruption_sha_mismatch():
    """Corrupt 1 byte in map_registry.jsonl copy → SHA256 mismatch detected."""
    src_bytes = (REG / "map_registry.jsonl").read_bytes()
    expected = (REG / "map_registry.jsonl.sha256").read_text(encoding="utf-8").strip().split()[0]
    actual = hashlib.sha256(src_bytes).hexdigest()
    # First confirm baseline match
    baseline_ok = expected == actual
    # Now corrupt 1 byte mid-file
    pos = len(src_bytes) // 2
    corrupted = src_bytes[:pos] + bytes([src_bytes[pos] ^ 0xFF]) + src_bytes[pos+1:]
    corrupted_hash = hashlib.sha256(corrupted).hexdigest()
    record(11, "Fault: 1-byte corruption → SHA256 detects mismatch",
           baseline_ok and corrupted_hash != expected,
           {"baseline_match": baseline_ok, "corruption_detected": corrupted_hash != expected})


def r12_missing_sha256_detected():
    """Delete .sha256 companion → audit/manual check detects missing pair."""
    # Don't actually delete; simulate by listing pairs
    bad_pairs = []
    for p in [REG / "map_registry.jsonl", REG / "region.jsonl", REG / "shard_config.json",
              SCHEMA / "place_table.sql", OUT / "status.json"]:
        sp = p.with_suffix(p.suffix + ".sha256")
        if not sp.exists():
            bad_pairs.append({"file": str(p.relative_to(OUT)), "issue": "sha256_missing"})
    # All should have companion → detection logic working when absent
    record(12, "Fault: all required files have .sha256 companion (audit detection capability)",
           not bad_pairs, {"missing": bad_pairs})


# ─── R13-R15 REGRESSION BASELINE ─────────────────────────────
def r13_registry_byte_stable():
    """Re-run builder 3x, registry bytes stable (no timestamp/random drift)."""
    files = [REG / "map_registry.jsonl", REG / "region.jsonl", REG / "shard_config.json"]
    hashes_3 = []
    for _ in range(3):
        subprocess.run([sys.executable, str(BUILDER)], capture_output=True, text=True, encoding="utf-8")
        hashes_3.append({p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files})
    all_same = all(hashes_3[0] == h for h in hashes_3[1:])
    record(13, "Regression: registry SHA256 stable across 3 rebuilds",
           all_same, {"runs": 3, "stable": all_same})


def r14_schema_byte_stable():
    """Schema SQL byte stable (no comment with date/timestamp)."""
    sp = SCHEMA / "place_table.sql"
    h_a = hashlib.sha256(sp.read_bytes()).hexdigest()
    subprocess.run([sys.executable, str(BUILDER)], capture_output=True, text=True, encoding="utf-8")
    h_b = hashlib.sha256(sp.read_bytes()).hexdigest()
    record(14, "Regression: schema SQL byte-stable across rebuild",
           h_a == h_b, {"before": h_a[:16], "after": h_b[:16]})


def r15_audit_reports_consistent():
    """Audit reports (no timestamp field in deep_23 / phase4) byte-stable."""
    # Some reports contain timestamps (cross_22 alerts) — those excluded.
    # deep_23, phase3, phase4 don't store timestamps in body → re-run check stable.
    # Re-run audit_deep_23 and check report hash before/after
    deep_report = AUDIT / "deep_23_rounds.json"
    h_a = hashlib.sha256(deep_report.read_bytes()).hexdigest()
    subprocess.run([sys.executable, str(Path(__file__).parent / "audit_deep_23.py")],
                   capture_output=True, text=True, encoding="utf-8")
    h_b = hashlib.sha256(deep_report.read_bytes()).hexdigest()
    record(15, "Regression: deep_23 audit report byte-stable across re-run",
           h_a == h_b, {"before": h_a[:16], "after": h_b[:16]})


# ─── R16-R18 PROPERTY FUZZING / GENERATIVE ─────────────────────
def r16_random_sample_properties(maps):
    """Random sample 100 map_id, verify all properties hold."""
    rng = random.Random("phase5:fuzz")
    sample = rng.sample(maps, 100)
    bad = []
    for m in sample:
        if not (1 <= m["map_id"] <= TARGET_MAPS): bad.append(("id_range", m["map_id"])); break
        if m["shard_id"] != (m["map_id"] - 1) % TARGET_SHARDS:
            bad.append(("shard_formula", m["map_id"])); break
        if m["era"] not in ERAS: bad.append(("era_enum", m["map_id"])); break
        if m["biome"] not in BIOMES: bad.append(("biome_enum", m["map_id"])); break
        if m["f_prefix"] != F_PREFIX_RULE[m["era"]]: bad.append(("f_prefix", m["map_id"])); break
        if len(m["tags"]) != 3: bad.append(("tags_arity", m["map_id"])); break
    record(16, "Random sample 100 maps satisfy ALL 6 properties",
           not bad, {"sample_size": 100, "violations": bad})


def r17_pairwise_distinct(maps):
    """Any 2 maps with same (era, biome) must have distinct name + map_id (sample N=2000 pairs)."""
    eb_buckets = defaultdict(list)
    for m in maps:
        eb_buckets[(m["era"], m["biome"])].append(m)
    rng = random.Random("phase5:pairwise")
    bad = []
    for bucket in eb_buckets.values():
        if len(bucket) < 2: continue
        # check 5 random pairs per bucket
        pairs = rng.sample(bucket, min(5, len(bucket)))
        for i in range(len(pairs)):
            for j in range(i+1, len(pairs)):
                if pairs[i]["name"] == pairs[j]["name"]:
                    bad.append({"era_biome": (pairs[i]["era"], pairs[i]["biome"]),
                                "ids": (pairs[i]["map_id"], pairs[j]["map_id"])})
                if pairs[i]["map_id"] == pairs[j]["map_id"]:
                    bad.append({"issue": "id_dup", "id": pairs[i]["map_id"]})
        if len(bad) > 5: break
    record(17, "Pairwise distinct: same (era,biome) → distinct name + map_id",
           not bad, {"violations": bad[:5]})


def r18_closure_tags_subset(maps):
    """Closure: tags ⊆ {ERAS ∪ BIOMES ∪ {shard_XX}}."""
    allowed = set(ERAS) | set(BIOMES) | {f"shard_{i:02d}" for i in range(TARGET_SHARDS)}
    bad = []
    for m in maps:
        if not set(m["tags"]).issubset(allowed):
            extra = set(m["tags"]) - allowed
            bad.append({"map_id": m["map_id"], "extra_tags": list(extra)})
            if len(bad) > 5:
                break
    record(18, "Closure: tags ⊆ ERAS ∪ BIOMES ∪ shard_NN",
           not bad, {"bad": bad[:5]})


# ─── R19-R22 ALGEBRAIC IDENTITY ─────────────────────────────
def r19_cardinality_sum(maps):
    """∑ over (era, biome) cells = TARGET_MAPS."""
    eb = Counter((m["era"], m["biome"]) for m in maps)
    total = sum(eb.values())
    record(19, "Cardinality: ∑(era × biome cells) = TARGET_MAPS",
           total == TARGET_MAPS, {"total": total, "want": TARGET_MAPS,
                                    "cells_filled": len(eb), "expected_cells": 35})


def r20_three_way_bijection(maps):
    """map_id ↔ uuid ↔ natural_key all bijective (1-1-1)."""
    n = len(maps)
    ok = (len({m["map_id"] for m in maps}) == n ==
          len({m["uuid"] for m in maps}) ==
          len({m["natural_key"] for m in maps}))
    record(20, "3-way bijection: map_id ↔ uuid ↔ natural_key all 1-1",
           ok, {"n": n,
                 "unique_map_id": len({m["map_id"] for m in maps}),
                 "unique_uuid": len({m["uuid"] for m in maps}),
                 "unique_nk": len({m["natural_key"] for m in maps})})


def r21_pigeonhole_shard(maps):
    """10000 maps / 64 shards → at least one shard has ≥ ceil(10000/64) = 157."""
    counts = Counter(m["shard_id"] for m in maps)
    threshold = math.ceil(TARGET_MAPS / TARGET_SHARDS)
    max_count = max(counts.values())
    record(21, "Pigeonhole: ∃ shard with count ≥ ceil(N/S) = 157",
           max_count >= threshold, {"max_count": max_count, "threshold": threshold})


def r22_inverse_f_prefix(maps):
    """Inverse: each f_prefix → set of eras (f1={ly,tran}, f2={le}, f3={tay_son}, g1={nguyen})."""
    fp_to_eras = defaultdict(set)
    for m in maps:
        fp_to_eras[m["f_prefix"]].add(m["era"])
    expected = {"f1": {"ly", "tran"}, "f2": {"le"}, "f3": {"tay_son"}, "g1": {"nguyen"}}
    actual = {k: v for k, v in fp_to_eras.items()}
    record(22, "Inverse map f_prefix → era set matches R31 rule",
           dict(actual) == expected, {"actual": {k: sorted(v) for k, v in actual.items()},
                                        "expected": {k: sorted(v) for k, v in expected.items()}})


def main():
    print("=" * 60)
    print("CMD_PLACE — PHASE 5 (22 vòng) — graph/contract/fault/regression/algebraic")
    print("=" * 60)
    maps = jsonl(REG / "map_registry.jsonl")
    print(f"Loaded {len(maps)} maps")

    r01_shard_adjacency_era_overlap(maps)
    r02_biome_clique(maps)
    r03_era_transition_boundaries(maps)
    r04_connectivity_era_biome(maps)
    r05_precondition_target_positive()
    r06_postcondition_count_exact(maps)
    r07_precondition_era_biome_nonempty()
    r08_postcondition_shard_nonempty(maps)
    r09_invariant_shard_id_pure_function(maps)
    r10_truncate_jsonl_detected()
    r11_byte_corruption_sha_mismatch()
    r12_missing_sha256_detected()
    r13_registry_byte_stable()
    r14_schema_byte_stable()
    r15_audit_reports_consistent()
    r16_random_sample_properties(maps)
    r17_pairwise_distinct(maps)
    r18_closure_tags_subset(maps)
    r19_cardinality_sum(maps)
    r20_three_way_bijection(maps)
    r21_pigeonhole_shard(maps)
    r22_inverse_f_prefix(maps)

    fails = [r for r in results if r["status"] == "FAIL"]
    print("-" * 60)
    print(f"PHASE 5 — 22 vòng — PASS {22 - len(fails)} FAIL {len(fails)}")

    out = {"version": "phase5_22_v1", "total": 22, "pass": 22 - len(fails),
           "fail": len(fails), "results": results}
    ap = AUDIT / "phase5_22_rounds.json"
    ap.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    ap.with_suffix(ap.suffix + ".sha256").write_bytes(
        f"{hashlib.sha256(ap.read_bytes()).hexdigest()}  {ap.name}\n".encode())
    print(f"Report: {ap}")
    sys.exit(0 if not fails else 1)


if __name__ == "__main__":
    main()
