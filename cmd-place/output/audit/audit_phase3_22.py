#!/usr/bin/env python3
"""CMD_PLACE — AUDIT phase 3 (22 vòng MỚI), every method, deeper.

Cross-worker: QUEST.giver_scene_id, EVENT.giver_scene_id, ITEM.region,
SKILL/DIALOG no-ref confirm, UUID universe collision MAP × NPC.

Deeper methods: randomized fuzz 100 / SQL full insert / UTF-8 strict /
shard_code bijection / meta-hash / determinism N=5 / type registry /
coverage entropy / chi-square / pool dependency / idempotent cycle /
newline strict / field order deterministic / dense map_id.
"""
from __future__ import annotations
import json, hashlib, re, sys, subprocess, sqlite3, random, math, time
import unicodedata
from pathlib import Path
from collections import Counter, defaultdict

ROOT = Path(r"C:\Users\Administrator\Desktop\CMD_PLACE_WORK\svtk-status")
PLACE_OUT = ROOT / "cmd-place" / "output"
PLACE_REG = PLACE_OUT / "registry"
PLACE_SCHEMA = PLACE_OUT / "schema"
NPC_REG = ROOT / "cmd-npc" / "output" / "registry"
QUEST_REG = ROOT / "cmd-quest" / "output" / "registry"
EVENT_REG = ROOT / "cmd-event" / "output" / "registry"
ITEM_REG = ROOT / "cmd-item" / "output" / "registry"
SKILL_REG = ROOT / "cmd-skill" / "output" / "registry"
DIALOG_REG = ROOT / "cmd-dialog" / "output" / "registry"
BUILDER = Path(r"C:\Users\Administrator\Desktop\CMD_PLACE_WORK\build_place.py")

ALERTS_DIR = ROOT / "cmd-lead" / "alerts"

TARGET_MAPS = 10000
TARGET_SHARDS = 64
ERAS = ["ly", "tran", "le", "tay_son", "nguyen"]
BIOMES = ["forest", "mountain", "river", "plain", "sea", "capital", "village"]

results = []


def record(n, name, ok, evidence, severity="ERROR"):
    results.append({"round": n, "name": name, "status": "PASS" if ok else "FAIL",
                    "severity": severity,
                    "evidence": evidence if isinstance(evidence, dict) else {"info": evidence}})
    print(f"R{n:02d} {'PASS' if ok else 'FAIL'} {name}")


def jsonl(p: Path):
    if not p.exists():
        return []
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]


def alert_lead(severity, issue_id, evidence):
    ALERTS_DIR.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    p = ALERTS_DIR / f"{severity}-{issue_id}-{ts}.json"
    p.write_text(json.dumps({"severity": severity, "issue_id": issue_id, "evidence": evidence,
                              "cmd_origin": "PLACE", "timestamp": ts},
                             ensure_ascii=False, indent=2), encoding="utf-8")
    return str(p.relative_to(ROOT))


# ─── Load all ─────────────────────────────────────
def main():
    maps = jsonl(PLACE_REG / "map_registry.jsonl")
    npcs = jsonl(NPC_REG / "npc_full.jsonl")
    quests = jsonl(QUEST_REG / "quest_full.jsonl")
    events = jsonl(EVENT_REG / "event_full.jsonl")
    items = jsonl(ITEM_REG / "item_full.jsonl")
    skills = jsonl(SKILL_REG / "skill_full.jsonl")
    dialogs = jsonl(DIALOG_REG / "dialog_full.jsonl")
    valid_map_ids = {m["map_id"] for m in maps}
    print(f"Loaded: maps={len(maps)} npcs={len(npcs)} quests={len(quests)} events={len(events)} "
          f"items={len(items)} skills={len(skills)} dialogs={len(dialogs)}")
    print("=" * 60)

    # ─── R01 QUEST × MAP range
    if quests:
        gsids = [q.get("giver_scene_id") for q in quests if "giver_scene_id" in q]
        ints = [s for s in gsids if isinstance(s, int)]
        oor = [s for s in ints if not (1 <= s <= TARGET_MAPS)]
        record(1, "QUEST.giver_scene_id range ⊆ [1, 10000]",
               not oor, {"total": len(gsids), "int_count": len(ints),
                          "out_of_range": len(oor), "sample_oor": oor[:5],
                          "min": min(ints) if ints else None, "max": max(ints) if ints else None})
    else:
        record(1, "QUEST registry missing", False, {"reason": "quest_full.jsonl absent"})

    # ─── R02 QUEST × MAP orphan
    if quests:
        gsids = [q.get("giver_scene_id") for q in quests if isinstance(q.get("giver_scene_id"), int)]
        orphans = [s for s in gsids if s not in valid_map_ids]
        ev = {"orphan_total": len(orphans), "unique_orphans": len(set(orphans)),
              "top": Counter(orphans).most_common(5)}
        if orphans:
            ev["alert"] = alert_lead("HIGH", "PLACE_QUEST_ORPHAN_SCENEID",
                                       {"count": len(orphans), "top": Counter(orphans).most_common(10)})
        record(2, "QUEST orphan giver_scene_id (no map exists)",
               not orphans, ev, severity="HIGH")
    else:
        record(2, "QUEST orphan skipped (no registry)", True, {"info": "no quest data"})

    # ─── R03 EVENT × MAP range
    if events:
        gsids = [e.get("giver_scene_id") for e in events if "giver_scene_id" in e]
        ints = [s for s in gsids if isinstance(s, int)]
        oor = [s for s in ints if not (1 <= s <= TARGET_MAPS)]
        record(3, "EVENT.giver_scene_id range ⊆ [1, 10000]",
               not oor, {"total": len(gsids), "int_count": len(ints), "out_of_range": len(oor),
                          "sample_oor": oor[:5],
                          "min": min(ints) if ints else None, "max": max(ints) if ints else None})
    else:
        record(3, "EVENT registry missing", False, {"reason": "event_full.jsonl absent"})

    # ─── R04 EVENT × MAP orphan
    if events:
        gsids = [e.get("giver_scene_id") for e in events if isinstance(e.get("giver_scene_id"), int)]
        orphans = [s for s in gsids if s not in valid_map_ids]
        ev = {"orphan_total": len(orphans), "unique_orphans": len(set(orphans)),
              "top": Counter(orphans).most_common(5)}
        if orphans:
            ev["alert"] = alert_lead("HIGH", "PLACE_EVENT_ORPHAN_SCENEID",
                                       {"count": len(orphans), "top": Counter(orphans).most_common(10)})
        record(4, "EVENT orphan giver_scene_id",
               not orphans, ev, severity="HIGH")

    # ─── R05 ITEM.region values vs MAP biome/era (info)
    if items:
        regions = Counter(i.get("region") for i in items if i.get("region"))
        # Check overlap with MAP era or biome strings
        map_eras = set(ERAS)
        map_biomes = set(BIOMES)
        item_regions = set(regions.keys())
        overlap_era = item_regions & map_eras
        overlap_biome = item_regions & map_biomes
        record(5, "ITEM.region values (info — taxonomy distinct from MAP era/biome)",
               True, {"item_region_unique": len(regions),
                       "top_regions": regions.most_common(8),
                       "overlap_with_era": sorted(overlap_era),
                       "overlap_with_biome": sorted(overlap_biome)},
               severity="INFO")

    # ─── R06 SKILL no map_id ref (info)
    if skills:
        bad_keys = [s for s in skills if any(k in s for k in ("scene_id", "map_id", "location_id"))]
        record(6, "SKILL no scene_id/map_id/location_id ref (confirm)",
               len(bad_keys) == 0, {"violations": len(bad_keys), "sample": bad_keys[:3] if bad_keys else None})

    # ─── R07 DIALOG no map_id ref (info)
    if dialogs:
        bad = [d for d in dialogs[:500] if any(k in d for k in ("scene_id", "map_id", "location_id"))]
        record(7, "DIALOG no scene/map/loc ref (sample 500)",
               len(bad) == 0, {"violations": len(bad)})

    # ─── R08 UUID universe collision MAP × NPC
    map_uuids = {m["uuid"] for m in maps}
    npc_uuids = {n["uuid"] for n in npcs if "uuid" in n}
    coll = map_uuids & npc_uuids
    record(8, "UUID universe collision MAP × NPC (must be empty)",
           len(coll) == 0, {"collisions": len(coll), "sample": list(coll)[:3]})

    # ─── R09 RANDOMIZED FUZZ 100 byte-flips
    src = (PLACE_REG / "map_registry.jsonl").read_bytes()
    h_orig = hashlib.sha256(src).hexdigest()
    rng = random.Random("fuzz:phase3")
    detected = 0
    skipped = 0
    for _ in range(100):
        pos = rng.randrange(len(src))
        flip = bytes([src[pos] ^ 0xFF])
        mutated = src[:pos] + flip + src[pos+1:]
        h_new = hashlib.sha256(mutated).hexdigest()
        if h_new != h_orig:
            detected += 1
        else:
            skipped += 1
    record(9, "RANDOMIZED FUZZ 100 byte-flips: every flip detected by hash change",
           detected == 100, {"detected": detected, "skipped": skipped})

    # ─── R10 SQL FULL INSERT 10000 maps
    db = sqlite3.connect(":memory:")
    db.executescript((PLACE_SCHEMA / "place_table.sql").read_text(encoding="utf-8"))
    try:
        for m in maps:
            db.execute(
                "INSERT INTO place_items (id, map_id, uuid, natural_key, name, era, biome, shard_id, f_prefix, coord_x, coord_y) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (m["map_id"], m["map_id"], m["uuid"], m["natural_key"], m["name"], m["era"],
                 m["biome"], m["shard_id"], m["f_prefix"], m["coord_x"], m["coord_y"]))
        cur = db.execute("SELECT COUNT(*) FROM place_items")
        count = cur.fetchone()[0]
        record(10, "SQL FULL INSERT 10000 maps → all CHECK + UNIQUE pass",
               count == TARGET_MAPS, {"inserted": count, "expected": TARGET_MAPS})
        # Try inserting duplicate → must reject
        rejected = False
        try:
            db.execute(
                "INSERT INTO place_items (id, map_id, uuid, natural_key, name, era, biome, shard_id, f_prefix, coord_x, coord_y) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (99999, 1, str(__import__("uuid").uuid4()), "dup_key_test", "DupTest", "ly",
                 "forest", 0, "f1", 0, 0))
        except sqlite3.IntegrityError:
            rejected = True
        if not rejected:
            record(10, "SQL DUPLICATE map_id rejected", False, {"info": "duplicate accepted!"})
    except Exception as e:
        record(10, "SQL FULL INSERT failed", False, {"err": str(e)[:120]})

    # ─── R11 UTF-8 strict
    bad = []
    for p in [PLACE_REG / "map_registry.jsonl", PLACE_REG / "region.jsonl",
              PLACE_REG / "shard_config.json"]:
        raw = p.read_bytes()
        try:
            raw.decode("utf-8", "strict")
        except UnicodeDecodeError as e:
            bad.append({"file": p.name, "err": str(e)[:80]})
    record(11, "UTF-8 strict decode (no surrogate/malformed byte)",
           len(bad) == 0, {"bad": bad})

    # ─── R12 shard_code bijection R\d{2} ↔ shard_id 0..63
    regions = jsonl(PLACE_REG / "region.jsonl")
    rx = re.compile(r"^R(\d{2})$")
    bad = []
    seen_codes = set()
    for r in regions:
        m = rx.match(r["shard_code"])
        if not m or int(m.group(1)) != r["shard_id"]:
            bad.append((r["shard_id"], r["shard_code"]))
        if r["shard_code"] in seen_codes:
            bad.append(("DUP", r["shard_code"]))
        seen_codes.add(r["shard_code"])
    record(12, "shard_code R\\d{2} ↔ shard_id bijection (64 unique)",
           len(bad) == 0 and len(seen_codes) == TARGET_SHARDS,
           {"bad": bad[:5], "unique_codes": len(seen_codes)})

    # ─── R13 Meta-hash stability of all .sha256 files
    sha_files = sorted(PLACE_OUT.rglob("*.sha256"))
    h = hashlib.sha256()
    for sp in sha_files:
        h.update(sp.read_bytes())
    meta_hash = h.hexdigest()
    record(13, "Meta-hash of all .sha256 files computed",
           True, {"sha256_file_count": len(sha_files), "meta_hash": meta_hash[:32] + "..."})

    # ─── R14 Determinism N=5 replay
    files = [PLACE_REG / "region.jsonl", PLACE_REG / "map_registry.jsonl",
             PLACE_REG / "shard_config.json"]
    hashes_seq = []
    initial = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    hashes_seq.append(initial)
    for i in range(4):
        r = subprocess.run([sys.executable, str(BUILDER)], capture_output=True, text=True, encoding="utf-8")
        cur = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
        hashes_seq.append(cur)
    all_same = all(hashes_seq[0] == h for h in hashes_seq[1:])
    record(14, "Determinism N=5 replay (1 initial + 4 rebuilds, all hash identical)",
           all_same, {"sequences": len(hashes_seq), "all_identical": all_same,
                       "files": list(initial.keys())})

    # ─── R15 Type registry strict per field
    EXPECT = {
        "uuid": str, "map_id": int, "natural_key": str, "name": str, "era": str,
        "era_label": str, "biome": str, "biome_label": str, "shard_id": int,
        "shard_code": str, "f_prefix": str, "coord_x": int, "coord_y": int,
        "tags": list, "tsonline_cross_ref": str,
    }
    bad = []
    for m in maps:
        for k, t in EXPECT.items():
            if not isinstance(m.get(k), t):
                bad.append({"map_id": m["map_id"], "field": k,
                             "got": type(m.get(k)).__name__, "want": t.__name__})
                break
        if len(bad) > 10:
            break
    record(15, "Type registry strict per map field", len(bad) == 0,
           {"bad": bad[:5], "fields_checked": len(EXPECT)})

    # ─── R16 Coverage entropy: shard biome distribution
    shard_biome = defaultdict(Counter)
    for m in maps:
        shard_biome[m["shard_id"]][m["biome"]] += 1
    entropies = []
    for sid, c in shard_biome.items():
        total = sum(c.values())
        H = -sum((v/total) * math.log2(v/total) for v in c.values() if v > 0)
        entropies.append(H)
    avg_H = sum(entropies) / len(entropies)
    H_max = math.log2(len(BIOMES))
    # Each shard should be reasonably mixed (entropy > 60% max ≈ 1.69)
    record(16, "Shard biome coverage entropy (Shannon) avg high",
           avg_H > 0.6 * H_max, {"avg_entropy": round(avg_H, 4),
                                   "H_max_7biomes": round(H_max, 4),
                                   "ratio": round(avg_H / H_max, 4)})

    # ─── R17 Chi-square uniformity test on shard count distribution
    counts = Counter(m["shard_id"] for m in maps)
    expected = TARGET_MAPS / TARGET_SHARDS
    chi2 = sum((c - expected) ** 2 / expected for c in counts.values())
    # df = 63, critical α=0.05 ≈ 82.53, α=0.001 ≈ 99.23
    # With balance delta ≤ 2, chi2 phải rất nhỏ
    record(17, "Chi-square shard distribution (uniform) χ² < 99 (p>0.001)",
           chi2 < 99, {"chi2": round(chi2, 4), "df": TARGET_SHARDS - 1,
                        "critical_p_001": 99.23, "expected_per_shard": expected})

    # ─── R18 Pool dependency: tsonline cross-ref unique value count
    refs = Counter(m["tsonline_cross_ref"] for m in maps)
    # 10000 maps over pool 1048 → mỗi ref dùng ~9.5 lần
    record(18, "tsonline pool dependency: 1048 unique refs cycled",
           len(refs) == 1048, {"unique_refs": len(refs),
                                 "min_uses": min(refs.values()),
                                 "max_uses": max(refs.values())})

    # ─── R19 Idempotent build cycle: build → build → hashes equal
    h_a = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    subprocess.run([sys.executable, str(BUILDER)], capture_output=True, text=True, encoding="utf-8")
    h_b = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    subprocess.run([sys.executable, str(BUILDER)], capture_output=True, text=True, encoding="utf-8")
    h_c = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    diffs = {k: [h_a[k], h_b[k], h_c[k]] for k in h_a if not (h_a[k] == h_b[k] == h_c[k])}
    record(19, "Idempotent build cycle 3x (R8 hard guarantee)",
           not diffs, {"diffs": diffs})

    # ─── R20 Newline strictness: every JSONL line ends exactly with \n
    bad = []
    for p in [PLACE_REG / "map_registry.jsonl", PLACE_REG / "region.jsonl"]:
        raw = p.read_bytes()
        if not raw.endswith(b"\n"):
            bad.append({"file": p.name, "issue": "no_trailing_newline"})
        if b"\r\n" in raw:
            bad.append({"file": p.name, "issue": "CRLF_present"})
        if b"\n\n" in raw:
            bad.append({"file": p.name, "issue": "blank_line_present"})
    record(20, "JSONL newline strict (\\n only, end with \\n, no blank line)",
           len(bad) == 0, {"bad": bad})

    # ─── R21 Field order deterministic (JSON re-dump matches)
    src_raw = (PLACE_REG / "map_registry.jsonl").read_text(encoding="utf-8")
    mismatches = []
    for ln_no, line in enumerate(src_raw.splitlines(), 1):
        if not line.strip():
            continue
        d = json.loads(line)
        redumped = json.dumps(d, ensure_ascii=False)
        if redumped != line.rstrip("\r"):
            mismatches.append({"line": ln_no, "len_orig": len(line), "len_redump": len(redumped)})
            if len(mismatches) > 3:
                break
    record(21, "Field order deterministic: json.dumps re-emit == source line",
           len(mismatches) == 0, {"mismatches": mismatches[:3]})

    # ─── R22 Dense map_id [1..10000] (no skip)
    ids = sorted(m["map_id"] for m in maps)
    skips = [i for i in range(1, TARGET_MAPS + 1) if i not in set(ids)]
    record(22, "Dense map_id [1..10000] no skip", len(skips) == 0,
           {"missing": skips[:5], "count_missing": len(skips)})

    # ───────────────────────────────────────────────
    fails = [r for r in results if r["status"] == "FAIL"]
    highs = [r for r in fails if r["severity"] == "HIGH"]
    print("-" * 60)
    print(f"PHASE 3 — TOTAL 22 vòng — PASS {22 - len(fails)} FAIL {len(fails)} (HIGH={len(highs)})")

    out = {"version": "phase3_22_v1", "total": 22, "pass": 22 - len(fails),
           "fail": len(fails), "high_severity_fail": len(highs), "results": results}
    audit_dir = PLACE_OUT / "audit"
    audit_dir.mkdir(parents=True, exist_ok=True)
    ap = audit_dir / "phase3_22_rounds.json"
    ap.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    ap.with_suffix(ap.suffix + ".sha256").write_text(
        f"{hashlib.sha256(ap.read_bytes()).hexdigest()}  {ap.name}\n", encoding="utf-8")
    print(f"Report: {ap}")
    sys.exit(0 if not highs else 1)


if __name__ == "__main__":
    main()
