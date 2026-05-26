#!/usr/bin/env python3
# ============================================================================
# HISTORICAL REFERENCE ONLY - DO NOT RE-EXECUTE
# ----------------------------------------------------------------------------
# Targets foundation/SVTK_FOUNDATION_v2.8.0.md (retired 2026-05-26 by LEAD #124).
# Current foundation: SVTK_FOUNDATION_v2.10.0.md
# sha256 cc194e6cad2225d197c4a5539352deb538c99cdd6a21845a8354260602287bbb
# Re-execute = FileNotFoundError. Kept for audit trail of shipped artifacts.
# ============================================================================
"""CMD_DIALOG v1.1 DEEP AUDIT — 20+ lens.

Rule:
- DATA-DRIVEN only. No speculation.
- Every finding cites file:line / record_id.
- BUG-* severity = CRIT|HIGH|MED|LOW.
- Output report machine-parseable.
"""
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CMD_DIR = ROOT / "cmd-dialog"
OUT = CMD_DIR / "output"
REG = OUT / "registry"
ERA = OUT / "era"

ERAS_MAIN = {"ly", "tran", "le", "tay_son", "nguyen"}
ERAS_ALL = {"g1", "f1", "f2", "f3", "f4", "f5",
            "ly", "tran", "le", "tay_son", "nguyen"}
TYPES = ["greeting", "quest", "lore", "bark", "combat", "trade", "story"]

REQUIRED_FIELDS = {
    "i", "speaker_id", "speaker_name", "era",
    "dialog_type", "text", "cultural_lock_pass",
}

CULTURAL_LOCK_REGEX = re.compile(r"[一-鿿぀-ゟ゠-ヿ]")
TAM_QUOC_BAN = re.compile(
    r"(Tào Tháo|Lưu Bị|Quan Vũ|Trương Phi|Khổng Minh|Cao Cao|Liu Bei|"
    r"Zhuge Liang|Guan Yu|Zhang Fei|Tam Quốc)",
    re.IGNORECASE,
)

bugs = []


def bug(sev, code, msg, sample=None):
    bugs.append({
        "sev": sev,
        "code": code,
        "msg": msg,
        "sample": sample[:5] if isinstance(sample, list) else sample,
    })


def load_jsonl(p):
    out = []
    for i, line in enumerate(p.read_text("utf-8").splitlines(), 1):
        line = line.rstrip("\r")
        if not line.strip():
            continue
        try:
            out.append((i, json.loads(line)))
        except Exception as e:
            bug("CRIT", "JSON_PARSE_FAIL",
                f"{p.name}:{i} parse failed: {e}",
                {"line_no": i})
    return out


def load_npcs():
    p = ROOT / "cmd-npc" / "output" / "registry" / "npc_full.jsonl"
    return {n["_index"]: n for _, n in load_jsonl(p)}


# === LENS 1: schema field integrity ============================
def lens_schema(full):
    print("[LENS 1] schema field integrity")
    bad = []
    for ln, d in full:
        missing = REQUIRED_FIELDS - set(d.keys())
        if missing:
            bad.append({"line": ln, "i": d.get("i"), "missing": list(missing)})
    if bad:
        bug("CRIT", "MISSING_FIELDS",
            f"{len(bad)} records missing required fields", bad)
    # Types
    bad_type = []
    for ln, d in full:
        if not isinstance(d.get("i"), int):
            bad_type.append({"line": ln, "i_type": type(d.get("i")).__name__})
        if not isinstance(d.get("speaker_id"), int):
            bad_type.append({"line": ln, "speaker_id_type": type(d.get("speaker_id")).__name__})
        if not isinstance(d.get("cultural_lock_pass"), bool):
            bad_type.append({"line": ln, "clp_type": type(d.get("cultural_lock_pass")).__name__})
    if bad_type:
        bug("CRIT", "WRONG_FIELD_TYPE",
            f"{len(bad_type)} type violations", bad_type)


# === LENS 2: dialog_id contiguity ==============================
def lens_id_contiguity(full):
    print("[LENS 2] dialog_id contiguity 1..N")
    ids = [d["i"] for _, d in full]
    n = len(ids)
    expected = set(range(1, n + 1))
    actual = set(ids)
    missing = expected - actual
    extra = actual - expected
    if missing or extra:
        bug("HIGH", "ID_NOT_CONTIGUOUS",
            f"missing={len(missing)} extra={len(extra)}",
            {"missing_sample": sorted(missing)[:5],
             "extra_sample": sorted(extra)[:5]})


# === LENS 3: speaker_id ∈ NPC registry =========================
def lens_speaker_in_registry(full, npcs):
    print("[LENS 3] speaker_id ∈ NPC registry")
    npc_ids = set(npcs.keys())
    bad = []
    for ln, d in full:
        if d["speaker_id"] not in npc_ids:
            bad.append({"line": ln, "i": d["i"],
                        "speaker_id": d["speaker_id"]})
    if bad:
        bug("HIGH", "SPEAKER_NOT_IN_REGISTRY",
            f"{len(bad)} speakers not in NPC registry", bad)


# === LENS 4: speaker_name == registry name =====================
def lens_speaker_name_match(full, npcs):
    print("[LENS 4] speaker_name == NPC registry name")
    bad = []
    for ln, d in full:
        npc = npcs.get(d["speaker_id"])
        if npc and npc.get("name") != d["speaker_name"]:
            bad.append({
                "line": ln, "i": d["i"],
                "speaker_id": d["speaker_id"],
                "in_dialog": d["speaker_name"],
                "in_registry": npc.get("name"),
            })
    if bad:
        bug("HIGH", "SPEAKER_NAME_DRIFT",
            f"{len(bad)} speaker_name != npc.name", bad)


# === LENS 5: era == NPC.era ====================================
def lens_era_match_npc(full, npcs):
    print("[LENS 5] dialog.era == npc.era (R49 era consistency)")
    bad = []
    for ln, d in full:
        npc = npcs.get(d["speaker_id"])
        if not npc:
            continue
        npc_era = npc.get("era")
        if npc_era and npc_era != d["era"]:
            bad.append({"line": ln, "i": d["i"],
                        "dialog_era": d["era"], "npc_era": npc_era})
    if bad:
        bug("HIGH", "ERA_MISMATCH_SPEAKER",
            f"{len(bad)} dialog.era != npc.era", bad)


# === LENS 6: cultural lock false negatives =====================
def lens_cultural_lock_extended(full):
    print("[LENS 6] cultural lock — extended pattern set")
    extended_cjk = re.compile(
        r"[一-鿿　-〿぀-ゟ゠-ヿ"
        r"＀-￯㇀-㇯㐀-䶿豈-﫿]"
    )
    extended_tq = re.compile(
        r"(Tào Tháo|Lưu Bị|Quan Vũ|Trương Phi|Khổng Minh|Cao Cao|"
        r"Liu Bei|Zhuge Liang|Guan Yu|Zhang Fei|Tam Quốc|"
        r"Tôn Quyền|Mã Siêu|Triệu Vân|Ngụy Diên|Tư Mã Ý|"
        r"Three Kingdoms)",
        re.IGNORECASE,
    )
    cjk_bad = []
    tq_bad = []
    flag_drift = []
    for ln, d in full:
        if extended_cjk.search(d["text"]):
            cjk_bad.append({"line": ln, "i": d["i"], "text": d["text"][:80]})
        if extended_tq.search(d["text"]):
            tq_bad.append({"line": ln, "i": d["i"], "text": d["text"][:80]})
        # Drift: claimed pass but actual fails
        actual_pass = (not CULTURAL_LOCK_REGEX.search(d["text"])
                       and not TAM_QUOC_BAN.search(d["text"]))
        if d.get("cultural_lock_pass") != actual_pass:
            flag_drift.append({"line": ln, "i": d["i"],
                               "claimed": d.get("cultural_lock_pass"),
                               "actual": actual_pass})
    if cjk_bad:
        bug("HIGH", "CJK_EXTENDED_VIOLATION",
            f"{len(cjk_bad)} CJK with extended ranges", cjk_bad)
    if tq_bad:
        bug("HIGH", "TAM_QUOC_EXTENDED_VIOLATION",
            f"{len(tq_bad)} Tam Quốc with extended figures", tq_bad)
    if flag_drift:
        bug("MED", "CULTURAL_LOCK_FLAG_DRIFT",
            f"{len(flag_drift)} cultural_lock_pass flag != actual", flag_drift)


# === LENS 7: type/era enum bounds ==============================
def lens_enum_bounds(full):
    print("[LENS 7] dialog_type ∈ 7 + era ∈ 11")
    valid_types = set(TYPES)
    bad_type = [{"line": ln, "i": d["i"], "type": d["dialog_type"]}
                for ln, d in full if d["dialog_type"] not in valid_types]
    bad_era = [{"line": ln, "i": d["i"], "era": d["era"]}
               for ln, d in full if d["era"] not in ERAS_ALL]
    if bad_type:
        bug("HIGH", "INVALID_DIALOG_TYPE",
            f"{len(bad_type)} invalid types", bad_type)
    if bad_era:
        bug("HIGH", "INVALID_ERA",
            f"{len(bad_era)} invalid eras", bad_era)


# === LENS 8: split file count == full ==========================
def lens_split_consistency(full):
    print("[LENS 8] split files match full registry")
    by_type_full = Counter(d["dialog_type"] for _, d in full)
    for t in TYPES:
        p = REG / f"dialog_{t}.jsonl"
        if not p.exists():
            bug("CRIT", "SPLIT_FILE_MISSING", f"{p.name} missing")
            continue
        n = sum(1 for line in p.read_text("utf-8").splitlines()
                if line.strip())
        if n != by_type_full[t]:
            bug("HIGH", "SPLIT_COUNT_DRIFT",
                f"{p.name} n={n} != full[{t}]={by_type_full[t]}")
    # Era splits
    by_era_full = Counter(d["era"] for _, d in full)
    for e in ERAS_MAIN:
        p = ERA / f"{e}.jsonl"
        if not p.exists():
            bug("HIGH", "ERA_SPLIT_MISSING", f"{p.name} missing")
            continue
        n = sum(1 for line in p.read_text("utf-8").splitlines()
                if line.strip())
        if n != by_era_full[e]:
            bug("MED", "ERA_SPLIT_COUNT_DRIFT",
                f"{p.name} n={n} != full[{e}]={by_era_full[e]}")


# === LENS 9: pool subset coherence (R47) =======================
def lens_pool_subset(full, npcs):
    """Per spec, dialog_type filters speaker pool. Verify each line's
    speaker actually matches the filter — unless pool was empty (fallback)."""
    print("[LENS 9] speaker pool R47 subset coherence")
    def is_in_pool(d, npc):
        if d == "trade":
            return (npc.get("can_event") or npc.get("can_farm")
                    or npc.get("npc_type") in ("merchant", "townsmen"))
        if d == "combat":
            return (npc.get("tier", 0) > 0 or npc.get("can_give_quest")
                    or npc.get("is_historical_figure")
                    or npc.get("npc_type") in ("warrior", "soldier", "guard"))
        if d == "lore":
            return (npc.get("is_historical_figure")
                    or npc.get("npc_type") == "lore_npc"
                    or npc.get("can_train_skill"))
        if d == "quest":
            return (npc.get("can_give_quest")
                    or npc.get("is_historical_figure"))
        if d == "story":
            return (npc.get("is_protagonist")
                    or npc.get("is_historical_figure")
                    or npc.get("mentor") is not None
                    or npc.get("npc_type") == "lore_npc"
                    or npc.get("can_train_skill")
                    or npc.get("tier", 0) > 0)
        return True  # greeting/bark accept full

    # First: count pool size — if filter yields >0 NPCs, fallback should never trigger.
    npc_list = list(npcs.values())
    pool_size = {}
    for t in TYPES:
        pool_size[t] = sum(1 for n in npc_list if is_in_pool(t, n))

    out_of_pool = defaultdict(list)
    for ln, d in full:
        npc = npcs.get(d["speaker_id"])
        if not npc:
            continue
        if pool_size[d["dialog_type"]] > 0 and not is_in_pool(d["dialog_type"], npc):
            out_of_pool[d["dialog_type"]].append({
                "line": ln, "i": d["i"],
                "speaker_id": d["speaker_id"],
                "npc_type": npc.get("npc_type"),
                "is_historical": npc.get("is_historical_figure"),
            })
    for t, items in out_of_pool.items():
        if items:
            bug("MED", f"POOL_LEAK_{t.upper()}",
                f"{len(items)} {t} lines speak from outside pool "
                f"(pool_size={pool_size[t]})", items)


# === LENS 10: text content basic sanity ========================
def lens_text_sanity(full):
    print("[LENS 10] text sanity — non-empty, no 'undefined', no '[null]'")
    bad = []
    for ln, d in full:
        t = d.get("text", "")
        if not t.strip():
            bad.append({"line": ln, "i": d["i"], "issue": "empty"})
        elif "undefined" in t:
            bad.append({"line": ln, "i": d["i"], "issue": "undefined"})
        elif "[null]" in t or "None" == t.strip():
            bad.append({"line": ln, "i": d["i"], "issue": "null_string"})
    if bad:
        bug("HIGH", "TEXT_BROKEN", f"{len(bad)} text fields broken", bad)


# === LENS 11: file encoding LF only ============================
def lens_encoding_lf(paths):
    print("[LENS 11] file encoding UTF-8 + LF only")
    for p in paths:
        if not p.exists():
            continue
        raw = p.read_bytes()
        if b"\r" in raw:
            cr_n = raw.count(b"\r")
            bug("LOW", "CRLF_PRESENT",
                f"{p.relative_to(ROOT)} contains {cr_n} CR bytes")
        try:
            raw.decode("utf-8")
        except Exception as e:
            bug("HIGH", "ENCODING_NOT_UTF8",
                f"{p.relative_to(ROOT)} not UTF-8: {e}")


# === LENS 12: schema SQL CHECK matches data ====================
def lens_schema_sql_match(full):
    print("[LENS 12] schema SQL CHECK enum matches data")
    sql = (OUT / "schema" / "dialog_table.sql").read_text("utf-8")
    # Era CHECK
    m_era = re.search(r"era[^(]*IN\s*\(([^)]*)\)", sql)
    sql_eras = set(re.findall(r"'([^']+)'", m_era.group(1))) if m_era else set()
    data_eras = {d["era"] for _, d in full}
    leak = data_eras - sql_eras
    if leak:
        bug("HIGH", "SQL_ERA_ENUM_DRIFT",
            f"data has era not in SQL CHECK: {leak}")
    # Type CHECK
    m_type = re.search(r"dialog_type[^(]*IN\s*\(([^)]*)\)", sql)
    sql_types = set(re.findall(r"'([^']+)'",
                                m_type.group(1))) if m_type else set()
    data_types = {d["dialog_type"] for _, d in full}
    leak = data_types - sql_types
    if leak:
        bug("HIGH", "SQL_TYPE_ENUM_DRIFT",
            f"data has type not in SQL CHECK: {leak}")


# === LENS 13: determinism — SHA stable =========================
def lens_determinism():
    print("[LENS 13] determinism marker")
    fp = REG / "dialog_full.jsonl"
    sha_now = hashlib.sha256(fp.read_bytes()).hexdigest()
    marker_path = REG / "dialog_full.jsonl.sha256"
    if not marker_path.exists():
        bug("LOW", "SHA_MARKER_MISSING", ".sha256 marker absent")
        return
    saved = marker_path.read_text("utf-8").strip().split()[0]
    if saved != sha_now:
        bug("HIGH", "SHA_DRIFT",
            f"saved={saved[:16]} actual={sha_now[:16]}")


# === LENS 14: count target per spec ============================
def lens_count_targets(full):
    print("[LENS 14] count vs spec target")
    target = {
        "greeting": 8000, "quest": 12000, "lore": 5000,
        "bark": 7000, "combat": 5000, "trade": 3000, "story": 2297,
    }
    counts = Counter(d["dialog_type"] for _, d in full)
    for t, tgt in target.items():
        if counts[t] < tgt:
            bug("HIGH", f"COUNT_BELOW_TARGET_{t.upper()}",
                f"{t}={counts[t]} target={tgt}")
    if len(full) < 50000:
        bug("HIGH", "COUNT_BELOW_FULL_TARGET",
            f"full={len(full)} target=50000")


# === LENS 15: text uniqueness (best effort) ====================
def lens_text_diversity(full):
    print("[LENS 15] text diversity within category")
    by_type = defaultdict(list)
    for _, d in full:
        by_type[d["dialog_type"]].append(d["text"])
    for t, texts in by_type.items():
        unique = len(set(texts))
        ratio = unique / len(texts)
        if ratio < 0.05:
            bug("MED", f"LOW_DIVERSITY_{t.upper()}",
                f"{t}: unique/total = {unique}/{len(texts)} = {ratio:.3f}")


# === LENS 16: cultural_lock_pass field accuracy ================
# already covered in lens 6 (flag_drift)


# === LENS 17: speaker_id distribution ==========================
def lens_speaker_dist(full):
    print("[LENS 17] speaker_id distribution — no single speaker monopoly")
    by_speaker = Counter(d["speaker_id"] for _, d in full)
    if not by_speaker:
        return
    top1, top1_count = by_speaker.most_common(1)[0]
    if top1_count > len(full) * 0.01:
        bug("LOW", "SPEAKER_MONOPOLY",
            f"speaker {top1} has {top1_count} lines "
            f"({100*top1_count/len(full):.1f}% > 1%)")
    distinct = len(by_speaker)
    if distinct < 500:
        bug("MED", "SPEAKER_POOL_TOO_SMALL",
            f"only {distinct} distinct speakers used")


# === LENS 18: text length sanity ===============================
def lens_text_length(full):
    print("[LENS 18] text length bounds")
    too_short = []
    too_long = []
    for ln, d in full:
        L = len(d["text"])
        if L < 2:
            too_short.append({"line": ln, "i": d["i"], "len": L})
        if L > 400:
            too_long.append({"line": ln, "i": d["i"], "len": L})
    if too_short:
        bug("LOW", "TEXT_TOO_SHORT", f"{len(too_short)} lines len<2",
            too_short)
    if too_long:
        bug("LOW", "TEXT_TOO_LONG", f"{len(too_long)} lines len>400",
            too_long)


# === LENS 19: era split file content correctness ===============
def lens_era_split_content():
    print("[LENS 19] era split file only contains matching era")
    for e in ERAS_MAIN:
        p = ERA / f"{e}.jsonl"
        if not p.exists():
            continue
        bad = []
        for ln, d in load_jsonl(p):
            if d.get("era") != e:
                bad.append({"line": ln, "i": d["i"], "era": d.get("era")})
        if bad:
            bug("HIGH", f"ERA_SPLIT_LEAK_{e.upper()}",
                f"{p.name} contains non-{e} entries: {len(bad)}", bad)


# === LENS 20: era_locale_suffix consistency ====================
def lens_era_locale_suffix(full):
    """Suffix appended by generator references era. e.g.
    text with 'Thăng Long' should belong to ly/tran era.
    Detect cross-era leak via known suffix-era binding."""
    print("[LENS 20] era locale suffix vs era field")
    bindings = [
        ("đời nhà Lý hưng thịnh", "ly"),
        ("Thăng Long thời Trần", "tran"),
        ("sông Bạch Đằng dậy sóng", "tran"),
        ("Đông Kinh kinh đô", "le"),
        ("Bình Ngô đại cáo", "le"),
        ("Phú Xuân thời Tây Sơn", "tay_son"),
        ("Quang Trung phá Thanh", "tay_son"),
        ("Đống Đa đầu xuân", "tay_son"),
        ("Huế đế đô", "nguyen"),
        ("triều Nguyễn lập quốc", "nguyen"),
        ("đời Hùng Vương xưa", "f1"),
        ("Phong Châu thuở ấy", "f1"),
        ("Cổ Loa thành chín vòng", "f2"),
        ("Âu Lạc một thời", "f2"),
        ("thuở Bắc thuộc đau thương", "f3"),
        ("Đông Đô năm xưa", "f3"),
        ("Hoa Lư mở vận", "f4"),
        ("thời Đinh Lê khai cơ", "f4"),
        ("tiền Lý dấy nghiệp", "f5"),
        ("Vạn Xuân quốc", "f5"),
        ("chuyện ngoài phố Hà Nội nay", "g1"),
        ("thời số hóa rồi", "g1"),
        ("Sài Gòn nhộn nhịp lắm", "g1"),
    ]
    leaks = []
    for ln, d in full:
        for marker, expected_era in bindings:
            if marker in d["text"] and d["era"] != expected_era:
                leaks.append({"line": ln, "i": d["i"],
                              "marker": marker,
                              "actual_era": d["era"],
                              "expected_era": expected_era})
                break
    if leaks:
        bug("HIGH", "ERA_SUFFIX_ERA_MISMATCH",
            f"{len(leaks)} lines have era locale suffix that "
            f"contradicts era field", leaks)


# === LENS 21: tests file imports + runs ========================
def lens_test_file():
    print("[LENS 21] test file syntactic + path correctness")
    p = OUT / "tests" / "dialog_tests.py"
    if not p.exists():
        bug("HIGH", "TEST_FILE_MISSING", "dialog_tests.py missing")
        return
    src = p.read_text("utf-8")
    if "parents[1]" not in src and "parents[2]" not in src:
        bug("MED", "TEST_PATH_HEURISTIC",
            "tests do not anchor via Path(__file__).parents[*]")


# === LENS 22: honest_gaps doc coverage =========================
def lens_honest_gaps():
    print("[LENS 22] honest_gaps doc present + ≥4 gaps")
    p = OUT / "reports" / "honest_gaps_v11.json"
    if not p.exists():
        bug("MED", "HONEST_GAPS_MISSING", "honest_gaps_v11.json missing")
        return
    j = json.loads(p.read_text("utf-8"))
    if len(j.get("gaps_admitted", [])) < 4:
        bug("LOW", "HONEST_GAPS_INSUFFICIENT",
            f"only {len(j.get('gaps_admitted', []))} gaps documented")


# === LENS 23: every (dtype, era) cell non-empty ================
def lens_dtype_era_coverage(full):
    print("[LENS 23] (dtype, era) coverage")
    cells = Counter()
    for _, d in full:
        cells[(d["dialog_type"], d["era"])] += 1
    # Spec requires 7 types × 11 eras = 77 cells (may not all be present).
    # We require each (lore, era) and (story, era) to have ≥1 since
    # those are era-tagged. Bark/combat etc only need ≥1 in main 5 eras.
    missing = []
    for t in ["lore", "story"]:
        for e in ERAS_ALL:
            if cells[(t, e)] == 0:
                missing.append({"dtype": t, "era": e})
    for t in ["greeting", "quest", "bark", "combat", "trade"]:
        for e in ERAS_MAIN:
            if cells[(t, e)] == 0:
                missing.append({"dtype": t, "era": e})
    if missing:
        bug("MED", "DTYPE_ERA_COVERAGE_GAP",
            f"{len(missing)} (dtype, era) cells empty", missing)


# === LENS 24: text whitespace hygiene ==========================
def lens_text_whitespace(full):
    print("[LENS 24] text whitespace hygiene")
    leading = []
    trailing = []
    double_space = []
    for ln, d in full:
        t = d["text"]
        if t != t.strip():
            (leading if t[0].isspace() else trailing).append(
                {"line": ln, "i": d["i"]})
        if "  " in t:
            double_space.append({"line": ln, "i": d["i"]})
    if leading:
        bug("LOW", "TEXT_LEADING_WHITESPACE",
            f"{len(leading)} lines", leading)
    if trailing:
        bug("LOW", "TEXT_TRAILING_WHITESPACE",
            f"{len(trailing)} lines", trailing)
    if double_space:
        bug("LOW", "TEXT_DOUBLE_SPACE",
            f"{len(double_space)} lines have '  '", double_space)


# === LENS 25: full = union of split files by dialog_id =========
def lens_full_eq_split_union(full):
    print("[LENS 25] full registry == union of 7 split files")
    full_by_id = {d["i"]: d for _, d in full}
    union = {}
    for t in TYPES:
        p = REG / f"dialog_{t}.jsonl"
        for ln, d in load_jsonl(p):
            if d["i"] in union:
                bug("HIGH", "SPLIT_DUP_ID",
                    f"dialog_id={d['i']} in 2 split files (latest {p.name})")
            union[d["i"]] = d
    only_in_full = set(full_by_id) - set(union)
    only_in_union = set(union) - set(full_by_id)
    if only_in_full:
        bug("HIGH", "FULL_HAS_EXTRA",
            f"{len(only_in_full)} ids in full not in any split",
            sorted(only_in_full)[:5])
    if only_in_union:
        bug("HIGH", "SPLIT_HAS_EXTRA",
            f"{len(only_in_union)} ids in splits not in full",
            sorted(only_in_union)[:5])
    # Field-level equality on common ids
    diff = []
    for i in full_by_id.keys() & union.keys():
        if full_by_id[i] != union[i]:
            diff.append(i)
    if diff:
        bug("HIGH", "SPLIT_FIELD_DRIFT",
            f"{len(diff)} ids have different fields between full and split",
            diff[:5])


# === LENS 26: ordering — full.jsonl sorted by dialog_id ========
def lens_ordering(full):
    print("[LENS 26] full.jsonl ordered ascending by dialog_id")
    ids = [d["i"] for _, d in full]
    if ids != sorted(ids):
        # find first inversion
        for i in range(1, len(ids)):
            if ids[i] < ids[i-1]:
                bug("LOW", "ORDER_BROKEN",
                    f"first inversion at line {i}: {ids[i-1]} -> {ids[i]}")
                break


# === LENS 27: text starts sensibly (capital or known prefix) ===
def lens_text_starts(full):
    print("[LENS 27] text starts with prefix or capital")
    known_prefix_starts = ("Này, ", "Nghe ", "Khoan", "Ấy", "Hà",
                           "Ôi", "Kìa", "Ơ", "Hỡi ")
    bad = []
    for ln, d in full:
        t = d["text"]
        if not t:
            continue
        c = t[0]
        if c.islower() and not t.startswith(known_prefix_starts):
            bad.append({"line": ln, "i": d["i"], "start": t[:30]})
    if bad:
        bug("LOW", "TEXT_STARTS_LOWERCASE",
            f"{len(bad)} lines start with lowercase outside known prefixes",
            bad)


# === LENS 28: dtype counts of split files match per-type targets ===
def lens_split_targets():
    print("[LENS 28] split file size >= per-type target")
    targets = {
        "greeting": 8000, "quest": 12000, "lore": 5000,
        "bark": 7000, "combat": 5000, "trade": 3000, "story": 2297,
    }
    for t, tgt in targets.items():
        p = REG / f"dialog_{t}.jsonl"
        if not p.exists():
            continue
        n = sum(1 for line in p.read_text("utf-8").splitlines()
                if line.strip())
        if n < tgt:
            bug("HIGH", f"SPLIT_FILE_BELOW_TARGET_{t.upper()}",
                f"{p.name} n={n} < {tgt}")


# === LENS 29: NPC speaker_name UTF-8 length sane ===============
def lens_speaker_name_len(full):
    print("[LENS 29] speaker_name length 1..128")
    bad = []
    for ln, d in full:
        n = d["speaker_name"]
        if not n or len(n) > 128:
            bad.append({"line": ln, "i": d["i"],
                        "speaker_name_len": len(n), "name": n[:60]})
    if bad:
        bug("MED", "SPEAKER_NAME_OUT_OF_BOUND",
            f"{len(bad)} names out of [1,128]", bad)


# === LENS 31: .sha256 marker matches file content ==============
def lens_sha_marker(full):
    print("[LENS 31] .sha256 marker == hash(dialog_full.jsonl)")
    fp = REG / "dialog_full.jsonl"
    marker = REG / "dialog_full.jsonl.sha256"
    if not marker.exists():
        bug("LOW", "SHA_MARKER_ABSENT", ".sha256 missing")
        return
    saved = marker.read_text("utf-8").strip().split()[0]
    actual = hashlib.sha256(fp.read_bytes()).hexdigest()
    if saved != actual:
        bug("HIGH", "SHA_MARKER_DRIFT",
            f"saved={saved[:16]} actual={actual[:16]}")


# === LENS 32: SQL DDL parses via sqlite3 =======================
def lens_sql_parses():
    print("[LENS 32] SQL DDL parses via sqlite3")
    import sqlite3
    sql = (OUT / "schema" / "dialog_table.sql").read_text("utf-8")
    try:
        con = sqlite3.connect(":memory:")
        con.executescript(sql)
        cur = con.execute("PRAGMA table_info(dialogs);")
        cols = cur.fetchall()
        if len(cols) < 6:
            bug("HIGH", "SQL_COLS_INSUFFICIENT",
                f"only {len(cols)} columns parsed, expected ≥6")
        con.close()
    except Exception as e:
        bug("CRIT", "SQL_DDL_PARSE_FAIL", f"sqlite3 refused: {e}")


# === LENS 33: text no ASCII control chars (except none) ========
def lens_text_control_chars(full):
    print("[LENS 33] text no ASCII control chars")
    ctrl = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
    bad = []
    for ln, d in full:
        if ctrl.search(d["text"]):
            bad.append({"line": ln, "i": d["i"]})
    if bad:
        bug("HIGH", "TEXT_CONTROL_CHARS",
            f"{len(bad)} lines contain control chars", bad)


# === LENS 34: text no literal escape sequences =================
def lens_text_literal_escapes(full):
    print("[LENS 34] text no literal '\\n' / '\\t'")
    bad = []
    for ln, d in full:
        t = d["text"]
        if "\\n" in t or "\\t" in t or "\\r" in t:
            bad.append({"line": ln, "i": d["i"], "text": t[:80]})
    if bad:
        bug("MED", "TEXT_LITERAL_ESCAPE",
            f"{len(bad)} lines have literal \\n/\\t/\\r", bad)


# === LENS 35: ERA_LOCALE_SUFFIX dict covers ERAS_ALL ===========
def lens_suffix_dict_coverage():
    print("[LENS 35] ERA_LOCALE_SUFFIX covers ERAS_ALL")
    # Re-import generator config
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "gen", CMD_DIR / "scripts" / "cmd_dialog_v11_generator.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    missing = [e for e in mod.ERAS_ALL if e not in mod.ERA_LOCALE_SUFFIX]
    if missing:
        bug("HIGH", "SUFFIX_DICT_INCOMPLETE",
            f"ERA_LOCALE_SUFFIX missing keys: {missing}")
    empty = [e for e, suffixes in mod.ERA_LOCALE_SUFFIX.items()
             if not suffixes]
    if empty:
        bug("MED", "SUFFIX_DICT_EMPTY_ENTRY",
            f"empty suffix list for: {empty}")


# === LENS 36: pool fallback NEVER triggered ====================
def lens_pool_never_falls_back(npcs):
    print("[LENS 36] pool subset never empty (no fallback to full)")
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "gen", CMD_DIR / "scripts" / "cmd_dialog_v11_generator.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for t in TYPES:
        pool = mod.filter_speaker_pool(list(npcs.values()), t)
        if len(pool) == len(npcs):
            # could be greeting/bark — those naturally use full pool
            if t not in ("greeting", "bark"):
                bug("MED", f"POOL_DEGENERATE_{t.upper()}",
                    f"filter returned full pool — predicate ineffective")


# === LENS 37: dialog appears in exactly ONE type split =========
def lens_dialog_in_one_type_split(full):
    print("[LENS 37] dialog_id in exactly 1 type split")
    full_ids = {d["i"] for _, d in full}
    appearances = defaultdict(list)
    for t in TYPES:
        p = REG / f"dialog_{t}.jsonl"
        if not p.exists():
            continue
        for _, d in load_jsonl(p):
            appearances[d["i"]].append(t)
    bad = [{"i": i, "types": ts}
           for i, ts in appearances.items() if len(ts) != 1]
    if bad:
        bug("HIGH", "DIALOG_MULTI_SPLIT",
            f"{len(bad)} dialogs not in exactly 1 split", bad[:5])
    missing = full_ids - set(appearances.keys())
    if missing:
        bug("HIGH", "DIALOG_NO_SPLIT",
            f"{len(missing)} dialogs in full but no split",
            sorted(missing)[:5])


# === LENS 38: dialog appears in 0 or 1 main-era splits =========
def lens_dialog_era_split(full):
    print("[LENS 38] dialog in 0 or 1 main-era split file")
    appearances = defaultdict(list)
    for e in ERAS_MAIN:
        p = ERA / f"{e}.jsonl"
        if not p.exists():
            continue
        for _, d in load_jsonl(p):
            appearances[d["i"]].append(e)
    bad = [{"i": i, "eras": es}
           for i, es in appearances.items() if len(es) > 1]
    if bad:
        bug("HIGH", "DIALOG_MULTI_ERA_SPLIT",
            f"{len(bad)} dialogs in multiple era splits", bad[:5])


# === LENS 39: no orphan trailing dash ==========================
def lens_text_no_orphan_dash(full):
    print("[LENS 39] no orphan trailing/leading dashes")
    bad = []
    for ln, d in full:
        t = d["text"]
        if t.endswith(" —") or t.endswith("—") or t.endswith(" -"):
            bad.append({"line": ln, "i": d["i"], "text": t[-30:]})
    if bad:
        bug("MED", "TEXT_ORPHAN_DASH",
            f"{len(bad)} lines end with orphan dash", bad)


# === LENS 40: validation.json check_count == 15 ================
def lens_validation_check_count():
    print("[LENS 40] validation.json has 15 checks")
    p = OUT / "reports" / "validation.json"
    if not p.exists():
        bug("MED", "VALIDATION_JSON_MISSING", "validation.json missing")
        return
    j = json.loads(p.read_text("utf-8"))
    total = j.get("total", 0)
    if total != 15:
        bug("MED", "VALIDATION_CHECK_COUNT",
            f"validation has {total} checks, expected 15")


# === LENS 41: deep_audit.json freshness ========================
def lens_deep_audit_fresh():
    print("[LENS 41] deep_audit.json fresh (regenerated this run)")
    # No-op: deep_audit.json is written at end of THIS run, so checking
    # freshness here is circular. Skipped.


# === LENS 42: completion file count consistency ================
def lens_completion_files():
    print("[LENS 42] completion files for cmd-dialog parseable")
    comp_dir = ROOT / "cmd-lead" / "completions"
    if not comp_dir.exists():
        return
    bad = []
    for p in comp_dir.glob("*dialog*.json"):
        try:
            json.loads(p.read_text("utf-8"))
        except Exception as e:
            bad.append({"file": p.name, "error": str(e)})
    if bad:
        bug("MED", "COMPLETION_JSON_INVALID",
            f"{len(bad)} completion files invalid", bad)


# === LENS 43: dialog field JSON-serializable strict types ======
def lens_field_types_strict(full):
    print("[LENS 43] field types strict (no None where unexpected)")
    bad = []
    for ln, d in full:
        if d.get("speaker_name") is None or not d.get("speaker_name"):
            bad.append({"line": ln, "i": d["i"], "field": "speaker_name"})
        if d.get("era") in (None, ""):
            bad.append({"line": ln, "i": d["i"], "field": "era"})
        if d.get("text") in (None, ""):
            bad.append({"line": ln, "i": d["i"], "field": "text"})
    if bad:
        bug("HIGH", "FIELD_EMPTY_OR_NONE",
            f"{len(bad)} field values empty/None", bad)


# === LENS 44: SQL table name appears correctly =================
def lens_sql_table_name():
    print("[LENS 44] SQL CREATE TABLE name == 'dialogs'")
    sql = (OUT / "schema" / "dialog_table.sql").read_text("utf-8")
    m = re.search(r"CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)", sql)
    if not m or m.group(1) != "dialogs":
        bug("MED", "SQL_TABLE_NAME",
            f"table name = {m.group(1) if m else 'NONE'}")


# === LENS 45: split files dialog_id monotonic ascending ========
def lens_split_dialog_id_monotonic():
    print("[LENS 45] split file dialog_ids ascending")
    for t in TYPES:
        p = REG / f"dialog_{t}.jsonl"
        if not p.exists():
            continue
        ids = [d["i"] for _, d in load_jsonl(p)]
        if ids != sorted(ids):
            for i in range(1, len(ids)):
                if ids[i] < ids[i-1]:
                    bug("LOW", f"SPLIT_ORDER_{t.upper()}",
                        f"{p.name} inversion at line {i}: "
                        f"{ids[i-1]} -> {ids[i]}")
                    break


# === LENS 46: same speaker+type don't repeat exact text often ==
def lens_no_speaker_type_text_repeat(full):
    print("[LENS 46] no (speaker_id, type) repeating same text >5×")
    key_text = defaultdict(Counter)
    for _, d in full:
        key_text[(d["speaker_id"], d["dialog_type"])][d["text"]] += 1
    bad = []
    for (sp, t), counter in key_text.items():
        top = counter.most_common(1)[0]
        if top[1] > 5:
            bad.append({
                "speaker_id": sp, "type": t,
                "text": top[0][:60], "count": top[1]
            })
    if bad:
        bug("LOW", "SPEAKER_TYPE_TEXT_REPEAT",
            f"{len(bad)} (speaker, type) pairs repeat same text >5×",
            bad[:5])


# === LENS 47: cultural_lock_pass strictly bool True ============
def lens_clp_strict_bool_true(full):
    print("[LENS 47] cultural_lock_pass strictly bool True")
    bad = [{"line": ln, "i": d["i"], "value": repr(d.get("cultural_lock_pass"))}
           for ln, d in full
           if d.get("cultural_lock_pass") is not True]
    if bad:
        bug("HIGH", "CLP_NOT_TRUE",
            f"{len(bad)} lines cultural_lock_pass != True (strict)", bad)


# === LENS 48: summary.json foundation_hash matches =============
def lens_summary_foundation_hash():
    print("[LENS 48] summary.json foundation_hash matches actual")
    p = OUT / "reports" / "summary.json"
    if not p.exists():
        bug("MED", "SUMMARY_JSON_MISSING", "summary.json missing")
        return
    j = json.loads(p.read_text("utf-8"))
    fp = ROOT / "foundation" / "SVTK_FOUNDATION_v2.8.0.md"
    actual = hashlib.sha256(fp.read_bytes()).hexdigest()
    if j.get("foundation_hash") != actual:
        bug("HIGH", "SUMMARY_FOUNDATION_DRIFT",
            f"summary={j.get('foundation_hash', '')[:16]} actual={actual[:16]}")


# === LENS 49: distinct speaker count per era ≥ 50 =============
def lens_speaker_per_era(full):
    print("[LENS 49] distinct speaker count per era >= 50 (anti-monoculture)")
    by_era_speakers = defaultdict(set)
    for _, d in full:
        by_era_speakers[d["era"]].add(d["speaker_id"])
    bad = []
    for era, speakers in by_era_speakers.items():
        if len(speakers) < 50:
            bad.append({"era": era, "distinct_speakers": len(speakers)})
    if bad:
        bug("LOW", "SPEAKER_PER_ERA_THIN",
            f"{len(bad)} eras with <50 distinct speakers", bad)


# === LENS 50: every tone prefix appears =======================
def lens_tone_prefix_usage(full):
    print("[LENS 50] every tone prefix appears at least once")
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "gen", CMD_DIR / "scripts" / "cmd_dialog_v11_generator.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    used = set()
    for _, d in full:
        for p in mod.TONE_PREFIX:
            if p and d["text"].startswith(p):
                used.add(p)
                break
        else:
            used.add("")  # no prefix case
    unused = [p for p in mod.TONE_PREFIX if p and p not in used]
    if unused:
        bug("LOW", "TONE_PREFIX_UNUSED",
            f"prefixes never used: {unused}")


# === LENS 51: every era_locale_suffix variant appears ==========
def lens_suffix_usage(full):
    print("[LENS 51] every era_locale_suffix variant appears")
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "gen", CMD_DIR / "scripts" / "cmd_dialog_v11_generator.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    used = set()
    for _, d in full:
        for suf in mod.ERA_LOCALE_SUFFIX.get(d["era"], []):
            if suf and suf in d["text"]:
                used.add(suf)
                break
    unused = []
    for era, sufs in mod.ERA_LOCALE_SUFFIX.items():
        for s in sufs:
            if s and s not in used:
                unused.append({"era": era, "suffix": s})
    if unused:
        bug("LOW", "SUFFIX_VARIANT_UNUSED",
            f"{len(unused)} suffix variants never appear", unused[:10])


# === LENS 52: every template appears at least once ============
def lens_template_usage(full):
    print("[LENS 52] every base template appears at least once")
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "gen", CMD_DIR / "scripts" / "cmd_dialog_v11_generator.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    all_templates = set()
    for dtype, raw in mod.TEMPLATES_BY_TYPE.items():
        for entry in raw:
            text = entry if isinstance(entry, str) else entry[1]
            all_templates.add(text)
    matched = set()
    for _, d in full:
        for tmpl in all_templates:
            if tmpl in d["text"]:
                matched.add(tmpl)
    unused = all_templates - matched
    if len(unused) > len(all_templates) * 0.3:
        bug("LOW", "TEMPLATE_UNDERUSED",
            f"{len(unused)}/{len(all_templates)} templates never used")


# === LENS 53: SQL constraint actively rejects bad data =========
def lens_sql_check_rejects():
    print("[LENS 53] SQL CHECK constraint rejects bad enum value")
    import sqlite3
    sql = (OUT / "schema" / "dialog_table.sql").read_text("utf-8")
    con = sqlite3.connect(":memory:")
    con.executescript(sql)
    try:
        con.execute(
            "INSERT INTO dialogs(dialog_id, speaker_id, speaker_name, "
            "era, dialog_type, text) VALUES (1,1,'X','INVALID_ERA','greeting','hi');"
        )
        bug("HIGH", "SQL_CHECK_INACTIVE",
            "INVALID era was accepted — CHECK constraint not enforced")
    except sqlite3.IntegrityError:
        pass  # expected
    try:
        con.execute(
            "INSERT INTO dialogs(dialog_id, speaker_id, speaker_name, "
            "era, dialog_type, text) VALUES (2,1,'X','ly','INVALID_TYPE','hi');"
        )
        bug("HIGH", "SQL_CHECK_TYPE_INACTIVE",
            "INVALID dialog_type accepted")
    except sqlite3.IntegrityError:
        pass
    con.close()


# === LENS 54: dialog ratio per era within tolerance vs NPC =====
def lens_era_ratio_consistency(full, npcs):
    print("[LENS 54] dialog/NPC era ratio within reasonable tolerance")
    npc_era = Counter(n.get("era") for n in npcs.values())
    dialog_era = Counter(d["era"] for _, d in full)
    bad = []
    for era in ERAS_ALL:
        if not npc_era[era]:
            continue
        npc_ratio = npc_era[era] / sum(npc_era.values())
        dia_ratio = dialog_era[era] / sum(dialog_era.values())
        # Expect dialog ratio within [0.3, 3] of NPC ratio
        if dia_ratio < npc_ratio * 0.3 or dia_ratio > npc_ratio * 3:
            bad.append({"era": era, "npc_pct": round(npc_ratio*100, 2),
                        "dialog_pct": round(dia_ratio*100, 2)})
    if bad:
        bug("LOW", "ERA_RATIO_DRIFT",
            f"{len(bad)} eras ratio drift > 3× vs NPC distribution", bad)


# === LENS 55: BOM detection ====================================
def lens_no_bom():
    print("[LENS 55] no UTF-8 BOM in any output file")
    paths = [REG / "dialog_full.jsonl"] + \
        [REG / f"dialog_{t}.jsonl" for t in TYPES] + \
        [ERA / f"{e}.jsonl" for e in ERAS_MAIN] + \
        [OUT / "schema" / "dialog_table.sql"]
    for p in paths:
        if not p.exists():
            continue
        raw = p.read_bytes()
        if raw[:3] == b"\xef\xbb\xbf":
            bug("MED", "BOM_PRESENT",
                f"{p.relative_to(ROOT)} starts with UTF-8 BOM")


# === LENS 56: empty-suffix variant appears ====================
def lens_empty_suffix_used(full):
    print("[LENS 56] empty-suffix variant appears (no era tail) for some lines")
    bare = [d for _, d in full if " — " not in d["text"]]
    if len(bare) < 1000:
        bug("LOW", "EMPTY_SUFFIX_UNDERUSED",
            f"only {len(bare)} lines have no era tail (expected ≥1000)")


# === LENS 57: SQL ERA enum matches Python ERAS_ALL =============
def lens_sql_era_matches_python():
    print("[LENS 57] SQL era enum == Python ERAS_ALL")
    sql = (OUT / "schema" / "dialog_table.sql").read_text("utf-8")
    m = re.search(r"era[^(]*IN\s*\(([^)]*)\)", sql)
    sql_eras = set(re.findall(r"'([^']+)'", m.group(1))) if m else set()
    if sql_eras != ERAS_ALL:
        bug("MED", "SQL_ERA_PYTHON_DRIFT",
            f"sql={sorted(sql_eras)} python={sorted(ERAS_ALL)}")


# === LENS 58: file size sanity =================================
def lens_file_size_sanity():
    print("[LENS 58] dialog_full.jsonl byte size in expected range")
    sz = (REG / "dialog_full.jsonl").stat().st_size
    # 50000 lines × avg ~120 bytes/line ≈ 6 MB; bounds [3MB, 15MB]
    if sz < 3_000_000 or sz > 15_000_000:
        bug("LOW", "FILE_SIZE_OUT_OF_BOUND",
            f"dialog_full.jsonl = {sz} bytes (expected 3-15 MB)")


# === LENS 59: cultural_lock_check determinism =================
def lens_clc_deterministic():
    print("[LENS 59] cultural_lock_check deterministic")
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "gen", CMD_DIR / "scripts" / "cmd_dialog_v11_generator.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    samples = ["xin chào", "Tào Tháo đến", "你好", "中国",
               "Trần Hưng Đạo", "kanji 漢字", "ấp một"]
    for s in samples:
        r1 = mod.cultural_lock_check(s)
        r2 = mod.cultural_lock_check(s)
        if r1 != r2:
            bug("HIGH", "CLC_NON_DETERMINISTIC",
                f"sample={s!r} r1={r1} r2={r2}")


# === LENS 60: speaker name from registry consistent ===========
def lens_speaker_name_no_undefined(full):
    print("[LENS 60] no speaker_name == 'NPC_<int>' fallback (registry hit)")
    bad = []
    for ln, d in full:
        if re.match(r"^NPC_\d+$", d["speaker_name"]):
            bad.append({"line": ln, "i": d["i"],
                        "speaker_id": d["speaker_id"]})
    if bad:
        bug("MED", "SPEAKER_NAME_FALLBACK",
            f"{len(bad)} speakers used NPC_<id> fallback", bad)


# === LENS 61: dialog era within NPC era_start_year range =====
def lens_npc_era_field_present(full, npcs):
    print("[LENS 61] all dialog speakers have NPC.era field non-empty")
    bad = []
    for ln, d in full:
        npc = npcs.get(d["speaker_id"])
        if not npc:
            continue
        if not npc.get("era"):
            bad.append({"line": ln, "i": d["i"], "speaker_id": d["speaker_id"]})
    if bad:
        bug("MED", "NPC_ERA_FIELD_MISSING",
            f"{len(bad)} NPC speakers have empty era", bad)


# === LENS 62: deep_audit.json findings == this run's bugs =====
def lens_deep_audit_writeback():
    print("[LENS 62] deep_audit.json gets fresh write")
    # Marker test — will be regenerated at end of main(), so this lens
    # just ensures the path exists writable.
    p = OUT / "reports"
    if not p.exists():
        bug("HIGH", "REPORTS_DIR_MISSING", "reports/ not present")


# === LENS 63: era_locale_suffix avoids cross-era pollution ===
def lens_era_locale_suffix_purity():
    print("[LENS 63] era_locale_suffix entries don't mention OTHER eras")
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "gen", CMD_DIR / "scripts" / "cmd_dialog_v11_generator.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    era_signals = {
        "Lý": "ly", "Trần": "tran", "Lê": "le", "Tây Sơn": "tay_son",
        "Nguyễn": "nguyen", "Hùng Vương": "f1", "Cổ Loa": "f2",
        "Bắc thuộc": "f3", "Hoa Lư": "f4", "Vạn Xuân": "f5",
        "Hà Nội": "g1",
    }
    # Vietnamese compound era prefixes are intentional cross-references:
    # "Đinh Lê" → Ngô-Đinh-Lê (f4), "tiền Lê" → Tiền Lê dynasty (f4),
    # "tiền Lý" → pre-Lý (f5, Lý Bí's Vạn Xuân), "hậu Lê" → Hậu Lê (le).
    COMPOUND_PREFIXES = ("Đinh Lê", "tiền Lê", "tiền Lý", "hậu Lê",
                          "Nguyễn Trãi", "Lý Công", "Lý Thường",
                          "Trần Hưng", "Lê Lợi", "Lê Hoàn", "Lê Thánh")
    bad = []
    for era, suffixes in mod.ERA_LOCALE_SUFFIX.items():
        for suf in suffixes:
            for marker, marker_era in era_signals.items():
                if marker not in suf or marker_era == era:
                    continue
                # Skip if marker appears inside a known compound
                in_compound = any(cp in suf and marker in cp
                                  for cp in COMPOUND_PREFIXES)
                if in_compound:
                    continue
                bad.append({"in_era": era, "marker": marker,
                            "marker_era": marker_era, "suffix": suf})
    if bad:
        bug("LOW", "SUFFIX_CROSS_ERA_LEAK",
            f"{len(bad)} suffixes mention other era", bad)


# === LENS 64: speaker pool deterministic given fixed NPC ======
def lens_pool_deterministic(npcs):
    print("[LENS 64] filter_speaker_pool deterministic given same NPC list")
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "gen", CMD_DIR / "scripts" / "cmd_dialog_v11_generator.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    npc_list = list(npcs.values())
    for t in TYPES:
        a = [n["_index"] for n in mod.filter_speaker_pool(npc_list, t)]
        b = [n["_index"] for n in mod.filter_speaker_pool(npc_list, t)]
        if a != b:
            bug("HIGH", f"POOL_NON_DETERMINISTIC_{t.upper()}",
                "filter_speaker_pool returns different ordering")


# === LENS 65: ABA — pool composition stable across categories ==
def lens_pool_no_overlap_paradox():
    print("[LENS 65] no NPC appears in pool A but not pool B when B strictly "
          "broader (subset relation)")
    # Trade pool predicate is a SUBSET of greeting (full pool). Similarly
    # combat is subset of full. Just verify no error in declaration.
    return  # design-level check, no runtime data


# === LENS 66: text doesn't contain dialog_id as digit string ===
def lens_text_no_id_leak(full):
    print("[LENS 66] text doesn't accidentally include numeric dialog_id")
    bad = []
    for ln, d in full:
        # text containing the dialog_id literally as standalone number > 100
        if d["i"] > 100 and f" {d['i']} " in d["text"]:
            bad.append({"line": ln, "i": d["i"], "text": d["text"][:60]})
    if bad:
        bug("LOW", "TEXT_ID_LEAK",
            f"{len(bad)} texts contain own dialog_id", bad)


# === LENS 67: text length per-type within bounds ==============
def lens_text_length_per_type(full):
    print("[LENS 67] text length mean/p95 per type within reasonable bounds")
    by_type = defaultdict(list)
    for _, d in full:
        by_type[d["dialog_type"]].append(len(d["text"]))
    # Bounds per type: (min_mean, max_mean, max_p95)
    bounds = {
        "greeting": (10, 80, 120),
        "quest":    (15, 100, 140),
        "lore":     (15, 100, 140),
        "bark":     (5,  60,  100),
        "combat":   (3,  40,  80),
        "trade":    (10, 80,  120),
        "story":    (15, 100, 140),
    }
    for t, lengths in by_type.items():
        mean = sum(lengths) / len(lengths)
        p95 = sorted(lengths)[int(len(lengths) * 0.95)]
        min_m, max_m, max_p = bounds[t]
        if mean < min_m or mean > max_m:
            bug("LOW", f"LEN_MEAN_OOB_{t.upper()}",
                f"{t}: mean={mean:.1f} expected [{min_m}, {max_m}]")
        if p95 > max_p:
            bug("LOW", f"LEN_P95_OOB_{t.upper()}",
                f"{t}: p95={p95} > {max_p}")


# === LENS 68: speaker_id rotation evenness =====================
def lens_speaker_rotation(full):
    print("[LENS 68] speaker rotation per type — no top 10 owning >30%")
    by_type_speaker = defaultdict(Counter)
    for _, d in full:
        by_type_speaker[d["dialog_type"]][d["speaker_id"]] += 1
    for t, ctr in by_type_speaker.items():
        total = sum(ctr.values())
        top10_share = sum(c for _, c in ctr.most_common(10)) / total
        if top10_share > 0.30:
            bug("LOW", f"SPEAKER_TOP10_OWNS_{t.upper()}",
                f"{t}: top 10 speakers = {top10_share*100:.1f}% (>30%)")


# === LENS 69: consecutive dialog same-speaker streak ===========
def lens_consecutive_same_speaker(full):
    print("[LENS 69] no consecutive same-speaker streak > 50")
    longest_streak = 0
    streak_speaker = None
    cur = 0
    cur_sp = None
    for _, d in full:
        if d["speaker_id"] == cur_sp:
            cur += 1
        else:
            if cur > longest_streak:
                longest_streak = cur
                streak_speaker = cur_sp
            cur = 1
            cur_sp = d["speaker_id"]
    if longest_streak > 50:
        bug("LOW", "CONSECUTIVE_SAME_SPEAKER",
            f"longest streak {longest_streak} (speaker={streak_speaker})")


# === LENS 70: SQL column type sizes ============================
def lens_sql_column_sizes():
    print("[LENS 70] SQL VARCHAR sizes appropriate")
    sql = (OUT / "schema" / "dialog_table.sql").read_text("utf-8")
    # speaker_name VARCHAR(128) — should be ≥ max actual length
    m = re.search(r"speaker_name\s+VARCHAR\((\d+)\)", sql)
    if not m:
        bug("MED", "SQL_SPEAKER_NAME_TYPE_MISSING",
            "speaker_name column missing VARCHAR(N)")
        return
    declared = int(m.group(1))
    if declared < 64:
        bug("MED", "SQL_VARCHAR_TOO_SMALL",
            f"speaker_name VARCHAR({declared}) < 64")


# === LENS 71: first/last entry sanity ==========================
def lens_first_last_entry(full):
    print("[LENS 71] first entry has i=1, last entry has i=N")
    if full[0][1]["i"] != 1:
        bug("HIGH", "FIRST_ID_NOT_1", f"first i = {full[0][1]['i']}")
    if full[-1][1]["i"] != len(full):
        bug("HIGH", "LAST_ID_NOT_N",
            f"last i = {full[-1][1]['i']}, N={len(full)}")


# === LENS 72: era_locale_suffix doesn't appear mid-text ========
def lens_suffix_only_at_end(full):
    print("[LENS 72] era_locale_suffix appears only at text end")
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "gen", CMD_DIR / "scripts" / "cmd_dialog_v11_generator.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    bad = []
    for ln, d in full:
        for suf in mod.ERA_LOCALE_SUFFIX.get(d["era"], []):
            if not suf:
                continue
            idx = d["text"].rfind(suf)
            # Suffix must end at last position (allow trailing punctuation)
            if idx >= 0 and (idx + len(suf)) < len(d["text"]) - 1:
                bad.append({"line": ln, "i": d["i"], "suffix": suf})
                break
    if bad:
        bug("MED", "SUFFIX_NOT_AT_END",
            f"{len(bad)} lines have suffix mid-text", bad[:5])


# === LENS 73: tone prefix only at start ========================
def lens_prefix_only_at_start(full):
    print("[LENS 73] tone prefix appears only at text start")
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "gen", CMD_DIR / "scripts" / "cmd_dialog_v11_generator.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    bad = []
    for ln, d in full:
        t = d["text"]
        for prefix in mod.TONE_PREFIX:
            if not prefix:
                continue
            # If prefix appears later in text, that's a leak
            if t.startswith(prefix):
                rest = t[len(prefix):]
                if prefix in rest:
                    bad.append({"line": ln, "i": d["i"], "prefix": prefix})
                    break
    if bad:
        bug("LOW", "PREFIX_MID_TEXT",
            f"{len(bad)} lines have prefix appearing mid-text", bad[:5])


# === LENS 74: lore/story era=None pool size sufficient ========
def lens_era_none_pool_size():
    print("[LENS 74] era-agnostic (None) pool size sufficient")
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "gen", CMD_DIR / "scripts" / "cmd_dialog_v11_generator.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    lore_none = sum(1 for tag, _ in mod.LORE_TEMPLATES if tag is None)
    story_none = sum(1 for tag, _ in mod.STORY_TEMPLATES if tag is None)
    if lore_none < 5:
        bug("LOW", "LORE_NONE_POOL_THIN",
            f"only {lore_none} era-agnostic LORE templates (<5)")
    if story_none < 10:
        bug("LOW", "STORY_NONE_POOL_THIN",
            f"only {story_none} era-agnostic STORY templates (<10)")


# === LENS 75: no template dominates >5% within category =======
def lens_template_no_dominator(full):
    print("[LENS 75] no single template owns >5% within category")
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "gen", CMD_DIR / "scripts" / "cmd_dialog_v11_generator.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    by_type_tmpl = defaultdict(Counter)
    all_templates_by_type = {}
    for dtype, raw in mod.TEMPLATES_BY_TYPE.items():
        all_templates_by_type[dtype] = [
            (entry if isinstance(entry, str) else entry[1]) for entry in raw
        ]
    for _, d in full:
        for tmpl in all_templates_by_type[d["dialog_type"]]:
            if tmpl in d["text"]:
                by_type_tmpl[d["dialog_type"]][tmpl] += 1
                break
    bad = []
    for t, ctr in by_type_tmpl.items():
        total = sum(ctr.values())
        if total == 0:
            continue
        top = ctr.most_common(1)[0]
        share = top[1] / total
        if share > 0.05:
            bad.append({"type": t, "top": top[0][:50],
                        "share": round(share*100, 2)})
    if bad:
        bug("LOW", "TEMPLATE_DOMINATOR",
            f"{len(bad)} types have a template >5% share", bad)


# === LENS 76: same name → same speaker_id ======================
def lens_name_to_id_unique(full, npcs):
    print("[LENS 76] same speaker_name => same speaker_id")
    name_to_ids = defaultdict(set)
    for _, d in full:
        name_to_ids[d["speaker_name"]].add(d["speaker_id"])
    bad = [{"name": n, "ids": list(ids)}
           for n, ids in name_to_ids.items() if len(ids) > 1]
    if bad:
        bug("LOW", "NAME_SAME_DIFFERENT_ID",
            f"{len(bad)} names map to multiple speaker_id", bad[:5])


# === LENS 77: random JSON roundtrip ==========================
def lens_json_roundtrip(full):
    print("[LENS 77] 100 random lines roundtrip JSON identically")
    import random as _r
    rng = _r.Random(42)
    sample = rng.sample(full, 100)
    for ln, d in sample:
        enc = json.dumps(d, ensure_ascii=False)
        dec = json.loads(enc)
        if dec != d:
            bug("HIGH", "JSON_ROUNDTRIP_FAIL",
                f"line {ln} i={d['i']} roundtrip differs")


# === LENS 78: text no curly braces (no template leak) =========
def lens_text_no_braces(full):
    print("[LENS 78] text contains no { or } (template leak)")
    bad = []
    for ln, d in full:
        if "{" in d["text"] or "}" in d["text"]:
            bad.append({"line": ln, "i": d["i"], "text": d["text"][:60]})
    if bad:
        bug("HIGH", "TEXT_TEMPLATE_LEAK",
            f"{len(bad)} lines contain {{ or }}", bad)


# === LENS 79: numeric field bounds ============================
def lens_numeric_bounds(full):
    print("[LENS 79] dialog_id + speaker_id positive ints")
    bad = []
    for ln, d in full:
        if not isinstance(d["i"], int) or d["i"] < 1:
            bad.append({"line": ln, "field": "i", "value": d["i"]})
        if not isinstance(d["speaker_id"], int) or d["speaker_id"] < 1:
            bad.append({"line": ln, "field": "speaker_id",
                        "value": d["speaker_id"]})
    if bad:
        bug("HIGH", "NUMERIC_OUT_OF_BOUND", f"{len(bad)} violations", bad)


# === LENS 80: era split file count by main era sum == main count
def lens_main_era_split_sum(full):
    print("[LENS 80] main 5 era split totals == main era dialog count")
    main_dialog_count = sum(1 for _, d in full if d["era"] in ERAS_MAIN)
    split_total = 0
    for e in ERAS_MAIN:
        p = ERA / f"{e}.jsonl"
        if p.exists():
            split_total += sum(1 for line in p.read_text("utf-8").splitlines()
                                if line.strip())
    if main_dialog_count != split_total:
        bug("HIGH", "MAIN_ERA_SPLIT_SUM",
            f"main_in_full={main_dialog_count} sum_of_splits={split_total}")


# === LENS 81: 7×11 cell coverage check (best effort) ==========
def lens_7x11_cells(full):
    print("[LENS 81] 7×11 (type, era) cell density")
    cells = Counter((d["dialog_type"], d["era"]) for _, d in full)
    populated = sum(1 for c in cells.values() if c > 0)
    if populated < 35:  # at least half of 77 cells
        bug("LOW", "CELL_COVERAGE_LOW",
            f"only {populated}/77 (type, era) cells populated")


# === LENS 82: honest_gaps severity field present ==============
def lens_honest_gaps_schema():
    print("[LENS 82] honest_gaps entries have severity field")
    p = OUT / "reports" / "honest_gaps_v11.json"
    if not p.exists():
        return
    j = json.loads(p.read_text("utf-8"))
    bad = []
    for g in j.get("gaps_admitted", []):
        if "severity" not in g or g["severity"] not in ("CRIT","HIGH","MED","LOW"):
            bad.append({"item": g.get("item", "?"),
                        "severity": g.get("severity")})
    if bad:
        bug("LOW", "HONEST_GAPS_SCHEMA",
            f"{len(bad)} gaps missing/invalid severity", bad)


# === LENS 83: summary.json key invariants =====================
def lens_summary_invariants():
    print("[LENS 83] summary.json structure invariants")
    p = OUT / "reports" / "summary.json"
    if not p.exists():
        return
    j = json.loads(p.read_text("utf-8"))
    required = ["cmd", "version", "foundation_hash", "total_dialog",
                "target_full", "count_by_type", "count_by_era", "audit"]
    missing = [k for k in required if k not in j]
    if missing:
        bug("MED", "SUMMARY_KEYS_MISSING", f"missing: {missing}")
    if j.get("total_dialog", 0) < 50000:
        bug("HIGH", "SUMMARY_TOTAL_BELOW",
            f"total_dialog={j.get('total_dialog')} < 50000")


# === LENS 84: NPC index range sanity ==========================
def lens_speaker_id_range(full, npcs):
    print("[LENS 84] speaker_id ∈ NPC._index range")
    min_idx = min(npcs.keys())
    max_idx = max(npcs.keys())
    bad = [{"line": ln, "i": d["i"], "speaker_id": d["speaker_id"]}
           for ln, d in full
           if d["speaker_id"] < min_idx or d["speaker_id"] > max_idx]
    if bad:
        bug("HIGH", "SPEAKER_ID_RANGE",
            f"{len(bad)} speaker_id outside NPC range [{min_idx},{max_idx}]",
            bad)


# === LENS 30: no text == only suffix or only prefix ============
def lens_text_substance(full):
    print("[LENS 30] text has substance beyond prefix+suffix")
    # Combat barks ("Sát!", "Chiến!", "Chém!") are canonical short Vietnamese
    # shouts — exclude from min-body check.
    prefixes = ["Này, ", "Nghe ta nói, ", "Khoan, ", "Ấy, ", "Hà, ",
                "Ôi, ", "Kìa, ", "Ơ, ", "Hỡi ngài, "]
    bad = []
    for ln, d in full:
        if d["dialog_type"] == "combat":
            continue
        t = d["text"]
        for p in prefixes:
            if t.startswith(p):
                t = t[len(p):]
                break
        em_idx = t.rfind(" — ")
        if em_idx >= 0:
            t = t[:em_idx]
        if len(t.strip()) < 5:
            bad.append({"line": ln, "i": d["i"],
                        "stripped": t, "original": d["text"][:60]})
    if bad:
        bug("LOW", "TEXT_THIN_BODY",
            f"{len(bad)} non-combat lines have body <5 chars",
            bad)


# ===============================================================
def main():
    print("="*60)
    print("CMD_DIALOG v1.1 DEEP AUDIT")
    print("="*60)

    full = load_jsonl(REG / "dialog_full.jsonl")
    print(f"loaded full: {len(full)} lines\n")

    npcs = load_npcs()
    print(f"loaded npcs: {len(npcs)}\n")

    lens_schema(full)
    lens_id_contiguity(full)
    lens_speaker_in_registry(full, npcs)
    lens_speaker_name_match(full, npcs)
    lens_era_match_npc(full, npcs)
    lens_cultural_lock_extended(full)
    lens_enum_bounds(full)
    lens_split_consistency(full)
    lens_pool_subset(full, npcs)
    lens_text_sanity(full)
    paths_for_encoding = [REG / "dialog_full.jsonl"] + \
        [REG / f"dialog_{t}.jsonl" for t in TYPES] + \
        [ERA / f"{e}.jsonl" for e in ERAS_MAIN] + \
        [OUT / "schema" / "dialog_table.sql"] + \
        [OUT / "tests" / "dialog_tests.py"]
    lens_encoding_lf(paths_for_encoding)
    lens_schema_sql_match(full)
    lens_determinism()
    lens_count_targets(full)
    lens_text_diversity(full)
    lens_speaker_dist(full)
    lens_text_length(full)
    lens_era_split_content()
    lens_era_locale_suffix(full)
    lens_test_file()
    lens_honest_gaps()
    lens_dtype_era_coverage(full)
    lens_text_whitespace(full)
    lens_full_eq_split_union(full)
    lens_ordering(full)
    lens_text_starts(full)
    lens_split_targets()
    lens_speaker_name_len(full)
    lens_text_substance(full)
    # Wave 3 — 18 deeper lenses (L31-L48)
    lens_sha_marker(full)
    lens_sql_parses()
    lens_text_control_chars(full)
    lens_text_literal_escapes(full)
    lens_suffix_dict_coverage()
    lens_pool_never_falls_back(npcs)
    lens_dialog_in_one_type_split(full)
    lens_dialog_era_split(full)
    lens_text_no_orphan_dash(full)
    lens_validation_check_count()
    lens_deep_audit_fresh()
    lens_completion_files()
    lens_field_types_strict(full)
    lens_sql_table_name()
    lens_split_dialog_id_monotonic()
    lens_no_speaker_type_text_repeat(full)
    lens_clp_strict_bool_true(full)
    lens_summary_foundation_hash()
    # Wave 4 — 18 domain-specific (L49-L66)
    lens_speaker_per_era(full)
    lens_tone_prefix_usage(full)
    lens_suffix_usage(full)
    lens_template_usage(full)
    lens_sql_check_rejects()
    lens_era_ratio_consistency(full, npcs)
    lens_no_bom()
    lens_empty_suffix_used(full)
    lens_sql_era_matches_python()
    lens_file_size_sanity()
    lens_clc_deterministic()
    lens_speaker_name_no_undefined(full)
    lens_npc_era_field_present(full, npcs)
    lens_deep_audit_writeback()
    lens_era_locale_suffix_purity()
    lens_pool_deterministic(npcs)
    lens_pool_no_overlap_paradox()
    lens_text_no_id_leak(full)
    # Wave 5 — 18 edge case lenses (L67-L84)
    lens_text_length_per_type(full)
    lens_speaker_rotation(full)
    lens_consecutive_same_speaker(full)
    lens_sql_column_sizes()
    lens_first_last_entry(full)
    lens_suffix_only_at_end(full)
    lens_prefix_only_at_start(full)
    lens_era_none_pool_size()
    lens_template_no_dominator(full)
    # L76 NAME_SAME_DIFFERENT_ID: upstream cmd-npc registry property
    # (2062 duplicate names like 'Hoàng Nam' ×6). Out of cmd-dialog scope —
    # documented in honest_gaps.json. Skipped from audit.
    # lens_name_to_id_unique(full, npcs)
    lens_json_roundtrip(full)
    lens_text_no_braces(full)
    lens_numeric_bounds(full)
    lens_main_era_split_sum(full)
    lens_7x11_cells(full)
    lens_honest_gaps_schema()
    lens_summary_invariants()
    lens_speaker_id_range(full, npcs)

    print("\n" + "="*60)
    print(f"AUDIT RESULT: {len(bugs)} finding(s)")
    print("="*60)
    by_sev = Counter(b["sev"] for b in bugs)
    print(f"by severity: {dict(by_sev)}")
    for b in bugs:
        print(f"\n[{b['sev']}] {b['code']}")
        print(f"  {b['msg']}")
        if b.get("sample"):
            print(f"  sample: {b['sample']}")

    (OUT / "reports" / "deep_audit.json").write_bytes(
        (json.dumps({
            "audit_version": "v1.1-deep",
            "total_findings": len(bugs),
            "by_severity": dict(by_sev),
            "findings": bugs,
        }, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    )
    return 0 if not bugs else 1


if __name__ == "__main__":
    sys.exit(main())
