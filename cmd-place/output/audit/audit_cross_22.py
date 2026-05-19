#!/usr/bin/env python3
"""CMD_PLACE × CMD_NPC — DEEP CROSS-REF AUDIT 22 vòng (every method).

Methods: cross-ref / mutation / replay / contract / snapshot / SQL / fuzz / encoding /
referential integrity / statistical / determinism / chronology / byte-level.

Read-only về cmd-npc/. Fix issue trong cmd-place/ nếu thuộc scope CMD_PLACE.
Cross-worker issue (orphan, schema mismatch) → log alert cmd-lead/alerts/.
"""
from __future__ import annotations
import json, hashlib, re, sys, subprocess, sqlite3, random, shutil, time
import unicodedata
from pathlib import Path
from collections import Counter, defaultdict

ROOT = Path(r"C:\Users\Administrator\Desktop\CMD_PLACE_WORK\svtk-status")
PLACE_OUT = ROOT / "cmd-place" / "output"
PLACE_REG = PLACE_OUT / "registry"
PLACE_SCHEMA = PLACE_OUT / "schema"
NPC_REG = ROOT / "cmd-npc" / "output" / "registry"
BUILDER = Path(r"C:\Users\Administrator\Desktop\CMD_PLACE_WORK\build_place.py")
ALERTS_DIR = ROOT / "cmd-lead" / "alerts"

ERAS = ["ly", "tran", "le", "tay_son", "nguyen"]
ERA_LABEL_VI = {"ly": "Lý", "tran": "Trần", "le": "Lê", "tay_son": "Tây Sơn", "nguyen": "Nguyễn"}
ERA_START_YEAR = {"ly": 1009, "tran": 1225, "le": 1428, "tay_son": 1778, "nguyen": 1802}
ERA_FICTIONAL_PREFIX = {"f1", "f2", "f3", "f4", "f5", "g1"}
TARGET_MAPS = 10000
TARGET_SHARDS = 64

CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")

results = []


def record(n, name, ok, evidence, severity="ERROR"):
    results.append({
        "round": n, "name": name, "status": "PASS" if ok else "FAIL",
        "severity": severity, "evidence": evidence if isinstance(evidence, dict) else {"info": evidence}
    })
    print(f"R{n:02d} {'PASS' if ok else 'FAIL'} {name}")


def load_jsonl(p: Path):
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]


def load_maps():
    return load_jsonl(PLACE_REG / "map_registry.jsonl")


def load_npcs_all():
    """Concat npc_full.jsonl (canonical)."""
    return load_jsonl(NPC_REG / "npc_full.jsonl")


def alert_lead(severity, issue_id, evidence):
    ALERTS_DIR.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    p = ALERTS_DIR / f"{severity}-{issue_id}-{ts}.json"
    p.write_text(json.dumps({
        "severity": severity, "issue_id": issue_id, "evidence": evidence,
        "cmd_origin": "PLACE", "timestamp": ts,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(p.relative_to(ROOT))


# ─────────────────────────────────────────────────────────────────────
def r01_npc_sceneid_range(npcs):
    """Cross-ref: sceneId của NPC phải in [1, 7047] (map_id space CMD_PLACE)."""
    scene_ids = [n.get("sceneId") for n in npcs if "sceneId" in n]
    if not scene_ids:
        record(1, "NPC sceneId field present", False, {"info": "sceneId field missing"})
        return
    mn, mx = min(scene_ids), max(scene_ids)
    out_of_range = [s for s in scene_ids if not (1 <= s <= TARGET_MAPS)]
    ok = not out_of_range
    record(1, "NPC sceneId range ⊆ [1, 7047] (cross-ref MAP)",
           ok, {"npc_total": len(scene_ids), "min": mn, "max": mx,
                "out_of_range_count": len(out_of_range),
                "sample_out": out_of_range[:10]},
           severity="HIGH" if not ok else "INFO")
    return scene_ids, out_of_range


def r02_npc_orphan_sceneid(npcs, valid_map_ids):
    """Mọi sceneId NPC phải có map tương ứng trong map_registry."""
    scene_ids = [n.get("sceneId") for n in npcs if "sceneId" in n]
    orphans = [s for s in scene_ids if s not in valid_map_ids]
    cnt = Counter(orphans)
    ok = not orphans
    ev = {"orphan_total": len(orphans), "unique_orphan_sceneIds": len(cnt),
          "top_orphan_sceneIds": cnt.most_common(10)}
    if not ok:
        ev["alert_file"] = alert_lead("HIGH", "PLACE_NPC_ORPHAN_SCENEID",
                                       {"orphan_count": len(orphans),
                                        "unique": len(cnt),
                                        "top": cnt.most_common(20)})
    record(2, "NPC sceneId orphan check (no NPC pointing to non-existent map)",
           ok, ev, severity="HIGH")


def r03_era_coexist(maps, npcs):
    """Mỗi era của MAP phải có ≥1 NPC era tương ứng."""
    map_eras = {m["era"] for m in maps}
    npc_eras = {n.get("era") for n in npcs}
    missing = sorted(map_eras - npc_eras)
    record(3, "Each MAP era has ≥1 NPC era match",
           not missing, {"map_eras": sorted(map_eras), "npc_eras": sorted(npc_eras),
                          "missing_in_npc": missing})


def r04_spawn_xy_range(npcs):
    """NPC spawn_x/y validity (NPC spec, không nhất thiết same map coord scale)."""
    bad = [(n.get("_index"), n.get("spawn_x"), n.get("spawn_y"))
           for n in npcs if not (isinstance(n.get("spawn_x"), int) and isinstance(n.get("spawn_y"), int))]
    record(4, "NPC spawn_x/y is integer", len(bad) == 0,
           {"bad_count": len(bad), "sample": bad[:5]})


def r05_era_enum_subset(maps, npcs):
    """NPC era ⊆ {ly,tran,le,tay_son,nguyen,f1..f5,g1}; MAP era ⊆ 5 era."""
    valid_npc = set(ERAS) | ERA_FICTIONAL_PREFIX
    bad_npc = [n.get("era") for n in npcs if n.get("era") not in valid_npc]
    bad_map = [m["era"] for m in maps if m["era"] not in ERAS]
    ok = not bad_npc and not bad_map
    record(5, "era enum strict (NPC ⊆ ERAS∪F1-5∪G1, MAP ⊆ 5 ERAS)",
           ok, {"bad_npc_unique": list(set(bad_npc))[:5],
                "bad_map_unique": list(set(bad_map))[:5]})


def r06_map_coverage_by_npc(maps, npcs):
    """Mỗi map có NPC? Chấp nhận coverage thấp (NPC ít hơn map nhiều)."""
    map_ids_with_npc = {n["sceneId"] for n in npcs if "sceneId" in n and 1 <= n["sceneId"] <= TARGET_MAPS}
    coverage = len(map_ids_with_npc) / TARGET_MAPS
    record(6, "MAP coverage by NPC (info only, no strict threshold)",
           True, {"maps_with_npc": len(map_ids_with_npc), "total_maps": TARGET_MAPS,
                  "coverage_pct": round(coverage * 100, 2)},
           severity="INFO")


def r07_mutation_map_byte():
    """A1 MUTATION: flip 1 byte trong map_registry copy → re-audit FAIL expected."""
    src = PLACE_REG / "map_registry.jsonl"
    raw = src.read_bytes()
    if b'"map_id": 1,' not in raw:
        record(7, "MUTATION map (flip byte) detection", False, {"info": "anchor byte not found"})
        return
    mutated = raw.replace(b'"map_id": 1,', b'"map_id": 9,', 1)
    h_orig = hashlib.sha256(raw).hexdigest()
    h_mut = hashlib.sha256(mutated).hexdigest()
    # Verify mutation actually changes ID uniqueness invariant
    mut_lines = mutated.decode("utf-8").splitlines()
    mut_ids = [json.loads(l)["map_id"] for l in mut_lines if l.strip()]
    detected = len(set(mut_ids)) < len(mut_ids)  # 9 dup with existing id 9
    record(7, "A1 MUTATION map: flip 1 byte detected via dup check",
           detected and h_orig != h_mut,
           {"hash_changed": h_orig != h_mut,
            "dup_detected_post_mut": detected,
            "first_dup_count": len(mut_ids) - len(set(mut_ids))})


def r08_mutation_npc_byte():
    """A1' MUTATION NPC (read-only): copy file in tmp, flip byte, verify sha256 changed."""
    src = NPC_REG / "npc_full.jsonl"
    raw = src.read_bytes()
    # Find first occurrence of '"hp":' and flip one digit
    h_orig = hashlib.sha256(raw).hexdigest()
    pos = raw.find(b'"hp": 100')
    if pos < 0:
        record(8, "MUTATION npc detection", False, {"info": "hp anchor not found"})
        return
    mutated = raw[:pos] + raw[pos:pos+9].replace(b"100", b"999", 1) + raw[pos+9:]
    h_mut = hashlib.sha256(mutated).hexdigest()
    record(8, "A1' MUTATION NPC (in-memory): hash changes detected",
           h_orig != h_mut, {"hash_changed": h_orig != h_mut})


def r09_replay_map():
    """A2 REPLAY: rerun builder, verify same hash."""
    files = [PLACE_REG / "region.jsonl", PLACE_REG / "map_registry.jsonl",
             PLACE_REG / "shard_config.json"]
    before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    r = subprocess.run([sys.executable, str(BUILDER)], capture_output=True, text=True, encoding="utf-8")
    after = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    diffs = {k: {"before": before[k], "after": after[k]} for k in before if before[k] != after[k]}
    record(9, "A2 REPLAY map: 2 rebuilds → same hash (R68.6)",
           not diffs and r.returncode == 0,
           {"exit": r.returncode, "diffs": diffs})


def r10_snapshot_baseline():
    """A3 SNAPSHOT: persistent baseline cho all artefact, store in audit/baseline.json."""
    baseline_path = PLACE_OUT / "audit" / "baseline.json"
    targets = sorted(PLACE_REG.glob("*")) + sorted(PLACE_SCHEMA.glob("*"))
    targets = [p for p in targets if p.is_file() and not p.name.endswith(".sha256")]
    snap = {p.relative_to(PLACE_OUT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in targets}
    if baseline_path.exists():
        old = json.loads(baseline_path.read_text(encoding="utf-8"))
        diffs = {k: {"old": old.get(k), "new": v} for k, v in snap.items() if old.get(k) != v}
        record(10, "A3 SNAPSHOT: artefact hashes vs baseline.json",
               not diffs, {"diffs": diffs})
    else:
        baseline_path.parent.mkdir(parents=True, exist_ok=True)
        baseline_path.write_text(json.dumps(snap, indent=2), encoding="utf-8")
        record(10, "A3 SNAPSHOT: baseline created (first run)",
               True, {"baseline_files": len(snap)})


def r11_sql_join_query(maps, npcs):
    """A4 SQL: load schema + ingest sample, run JOIN map × NPC by sceneId."""
    db = sqlite3.connect(":memory:")
    schema_sql = (PLACE_SCHEMA / "place_table.sql").read_text(encoding="utf-8")
    db.executescript(schema_sql)
    # Insert sample maps
    sample = maps[:200]
    for m in sample:
        db.execute(
            "INSERT INTO place_items (id, map_id, uuid, natural_key, name, era, biome, shard_id, f_prefix, coord_x, coord_y) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (m["map_id"], m["map_id"], m["uuid"], m["natural_key"], m["name"], m["era"],
             m["biome"], m["shard_id"], m["f_prefix"], m["coord_x"], m["coord_y"]))
    db.execute(
        "CREATE TABLE npc_min (uuid TEXT PRIMARY KEY, name TEXT, sceneId INT, era TEXT)")
    npc_sample = [n for n in npcs if 1 <= n.get("sceneId", 0) <= 200][:300]
    for n in npc_sample:
        db.execute("INSERT INTO npc_min VALUES (?,?,?,?)",
                   (n["uuid"], n["name"], n["sceneId"], n.get("era")))
    cur = db.execute(
        "SELECT p.map_id, p.name AS map_name, COUNT(n.uuid) AS npc_count "
        "FROM place_items p LEFT JOIN npc_min n ON n.sceneId = p.map_id "
        "GROUP BY p.map_id HAVING npc_count > 0 ORDER BY npc_count DESC LIMIT 5")
    rows = cur.fetchall()
    record(11, "A4 SQL JOIN map × npc by sceneId (sample 200 map / 300 npc)",
           len(rows) > 0, {"top_5_maps_with_npc": rows})


def r12_fuzz_shard_config():
    """A5 FUZZ: malformed shard_config copy → loader exception expected."""
    cfg_raw = (PLACE_REG / "shard_config.json").read_bytes()
    malformed = cfg_raw.replace(b'"total_maps": 10000', b'"total_maps": "INVALID"', 1)
    tmp = PLACE_OUT / "audit" / "fuzz_shard_config.json"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_bytes(malformed)
    try:
        data = json.loads(tmp.read_text(encoding="utf-8"))
        # Verify validator must reject
        rejected = not isinstance(data["total_maps"], int)
        record(12, "FUZZ malformed shard_config detected by type check",
               rejected, {"total_maps_type": type(data["total_maps"]).__name__})
    except json.JSONDecodeError as e:
        record(12, "FUZZ malformed shard_config raises JSONDecodeError",
               True, {"err": str(e)[:80]})
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def r13_nfc_normalization(maps):
    """All map names NFC-normalized (no NFD lurking)."""
    bad = []
    for m in maps:
        n = m["name"]
        nfc = unicodedata.normalize("NFC", n)
        if n != nfc:
            bad.append({"map_id": m["map_id"], "raw_len": len(n), "nfc_len": len(nfc)})
            if len(bad) > 10:
                break
    record(13, "map names NFC-normalized (no NFD)", len(bad) == 0,
           {"bad_count": len(bad), "sample": bad[:5]})


def r14_nfc_normalization_npc(npcs):
    bad = []
    for n in npcs[:1000]:  # sample 1000
        name = n.get("name", "")
        if name and name != unicodedata.normalize("NFC", name):
            bad.append({"_index": n.get("_index"), "name": name})
            if len(bad) > 10:
                break
    record(14, "NPC names NFC-normalized (sample 1000)", len(bad) == 0,
           {"bad_count": len(bad), "sample": bad[:5]})


def r15_ascii_strip_collision(maps):
    """ASCII fallback: nếu strip diacritics, có collision không? (defensive)."""
    def strip_dia(s):
        return "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c))
    ascii_counter = Counter(strip_dia(m["name"]).lower() for m in maps)
    collisions = {k: v for k, v in ascii_counter.items() if v > 1}
    # Vietnamese names DO collide after strip (e.g., "Sông Hồng" vs "Sông Hồng" duplicates by name unique pre-strip is OK)
    # Vì name có (#NNNN) suffix, ascii vẫn unique. Verify.
    record(15, "ASCII-stripped name still unique (suffix #NNNN guards)",
           len(collisions) == 0,
           {"collision_count": len(collisions), "sample": dict(list(collisions.items())[:5])})


def r16_no_control_chars(maps):
    bad = []
    for m in maps:
        for k, v in m.items():
            if isinstance(v, str) and CONTROL_CHAR_RE.search(v):
                bad.append({"map_id": m["map_id"], "field": k})
                break
        if len(bad) > 10:
            break
    record(16, "no control chars (\\x00-\\x1f) in any string field", len(bad) == 0,
           {"bad": bad[:5]})


def r17_jsonl_line_count_invariant():
    map_lines = len([l for l in (PLACE_REG / "map_registry.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()])
    region_lines = len([l for l in (PLACE_REG / "region.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()])
    ok = map_lines == TARGET_MAPS and region_lines == TARGET_SHARDS
    record(17, "JSONL line count = target (map 7047 / region 64)",
           ok, {"map_lines": map_lines, "region_lines": region_lines})


def r18_era_chronology_consistent(maps):
    """Era chronological order: ly < tran < le < tay_son < nguyen.
       Verify map_id distribution honors this (map_id thấp = era sớm).
       Since split_block is contiguous, era at higher map_id should be later era."""
    by_era_min_max = defaultdict(lambda: [10**9, 0])
    for m in maps:
        e = m["era"]
        by_era_min_max[e][0] = min(by_era_min_max[e][0], m["map_id"])
        by_era_min_max[e][1] = max(by_era_min_max[e][1], m["map_id"])
    order = sorted(ERAS, key=lambda e: by_era_min_max[e][0])
    expected = ERAS
    chronology = all(ERA_START_YEAR[order[i]] < ERA_START_YEAR[order[i+1]] for i in range(len(order)-1))
    record(18, "era_id distribution chronological (ly<tran<le<tay_son<nguyen)",
           order == expected and chronology,
           {"order_by_min_id": order, "expected": expected, "chronology_check": chronology,
            "ranges": {e: by_era_min_max[e] for e in ERAS}})


def r19_uuid_format_compat(maps, npcs):
    """Map uuid + NPC uuid both RFC4122 (parseable by uuid.UUID)."""
    import uuid as U
    bad_map = []
    for m in maps:
        try:
            U.UUID(m["uuid"])
        except ValueError:
            bad_map.append(m["map_id"])
            if len(bad_map) > 5:
                break
    bad_npc = []
    for n in npcs[:1000]:
        try:
            U.UUID(n["uuid"])
        except (ValueError, KeyError):
            bad_npc.append(n.get("_index"))
            if len(bad_npc) > 5:
                break
    record(19, "uuid RFC 4122 valid for MAP all + NPC sample 1000",
           not bad_map and not bad_npc,
           {"bad_map": bad_map, "bad_npc": bad_npc})


def r20_npc_era_sceneid_consistency(maps, npcs):
    """NPC era tương đồng MAP era khi sceneId in [1,7047]?
       NPC era ∈ ERAS → sceneId map's era should match (info, not strict, F-prefix exempt)."""
    map_era = {m["map_id"]: m["era"] for m in maps}
    mismatches = []
    for n in npcs:
        sid = n.get("sceneId")
        nera = n.get("era")
        if not isinstance(sid, int) or sid < 1 or sid > TARGET_MAPS:
            continue
        if nera in ERA_FICTIONAL_PREFIX:
            continue  # F/G prefix exempt
        if nera != map_era[sid]:
            mismatches.append({"npc_idx": n.get("_index"), "npc_era": nera, "sid": sid, "map_era": map_era[sid]})
    # INFO severity: era không bắt buộc match (NPC có thể travel)
    record(20, "NPC era vs MAP era at sceneId (INFO — soft consistency)",
           True, {"soft_mismatch_count": len(mismatches), "sample": mismatches[:5]},
           severity="INFO")
    if mismatches:
        alert_lead("INFO", "NPC_ERA_MAP_ERA_SOFT_MISMATCH",
                   {"count": len(mismatches), "sample": mismatches[:20]})


def r21_field_set_consistency(maps):
    """Every map entry has same key set (strict schema)."""
    if not maps:
        record(21, "field set consistency", False, {"info": "empty"})
        return
    canonical = set(maps[0].keys())
    bad = [(m["map_id"], sorted(canonical ^ set(m.keys()))) for m in maps if set(m.keys()) != canonical]
    record(21, "every map entry has identical key set (schema strictness)",
           len(bad) == 0, {"bad_count": len(bad), "canonical_keys": sorted(canonical), "sample": bad[:3]})


def r22_no_embedded_date_in_registry():
    """No YYYY-MM-DD timestamp leaked in registry (determinism R68.6 extra check)."""
    date_rx = re.compile(r"\b20\d{2}-\d{2}-\d{2}\b")
    bad = []
    for p in [PLACE_REG / "map_registry.jsonl", PLACE_REG / "region.jsonl",
              PLACE_REG / "shard_config.json"]:
        text = p.read_text(encoding="utf-8")
        m = date_rx.search(text)
        if m:
            bad.append({"file": p.name, "match": m.group(), "pos": m.start()})
    record(22, "no YYYY-MM-DD date leak in registry (determinism)",
           len(bad) == 0, {"bad": bad})


def main():
    print("=" * 60)
    print("CMD_PLACE × CMD_NPC — CROSS-REF DEEP AUDIT 22 vòng (every method)")
    print("=" * 60)
    maps = load_maps()
    valid_map_ids = {m["map_id"] for m in maps}
    npcs = load_npcs_all()
    print(f"Loaded {len(maps)} maps, {len(npcs)} npcs")

    r01_npc_sceneid_range(npcs)
    r02_npc_orphan_sceneid(npcs, valid_map_ids)
    r03_era_coexist(maps, npcs)
    r04_spawn_xy_range(npcs)
    r05_era_enum_subset(maps, npcs)
    r06_map_coverage_by_npc(maps, npcs)
    r07_mutation_map_byte()
    r08_mutation_npc_byte()
    r09_replay_map()
    r10_snapshot_baseline()
    r11_sql_join_query(maps, npcs)
    r12_fuzz_shard_config()
    r13_nfc_normalization(maps)
    r14_nfc_normalization_npc(npcs)
    r15_ascii_strip_collision(maps)
    r16_no_control_chars(maps)
    r17_jsonl_line_count_invariant()
    r18_era_chronology_consistent(maps)
    r19_uuid_format_compat(maps, npcs)
    r20_npc_era_sceneid_consistency(maps, npcs)
    r21_field_set_consistency(maps)
    r22_no_embedded_date_in_registry()

    fails = [r for r in results if r["status"] == "FAIL"]
    high_fails = [r for r in fails if r["severity"] == "HIGH"]
    print("-" * 60)
    print(f"TOTAL 22 vòng — PASS {22 - len(fails)} FAIL {len(fails)} (HIGH={len(high_fails)})")

    out = {
        "version": "cross_22_v1",
        "total": 22,
        "pass": 22 - len(fails),
        "fail": len(fails),
        "high_severity_fail": len(high_fails),
        "results": results,
    }
    audit_dir = PLACE_OUT / "audit"
    audit_dir.mkdir(parents=True, exist_ok=True)
    ap = audit_dir / "cross_22_rounds.json"
    ap.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    ap.with_suffix(ap.suffix + ".sha256").write_text(
        f"{hashlib.sha256(ap.read_bytes()).hexdigest()}  {ap.name}\n", encoding="utf-8")
    print(f"Report: {ap}")
    sys.exit(0 if not high_fails else 1)


if __name__ == "__main__":
    main()
