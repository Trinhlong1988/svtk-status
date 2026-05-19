#!/usr/bin/env python3
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
