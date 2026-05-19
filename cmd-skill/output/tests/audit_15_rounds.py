#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""CMD_SKILL deep audit — 15 rounds. Per-skill bug hunt + fix loop.

Existing 165 (id 1..165) IMMUTABLE — log bugs as advisory only.
New 135 (id 166..300) auto-fix in-place where possible.

Rounds:
  1  schema strict
  2  id uniqueness + dense 1..300
  3  element value lock (diacritic-exact)
  4  tier int↔label consistency + distribution 100/100/70/30
  5  numeric bounds (power/cost/cooldown/range)
  6  target_type + range consistency
  7  era_lore lock
  8  class–element compat (bach_than↔mộc / hac_than↔thổ — memory R4)
  9  name uniqueness
 10  cultural lock deep (CJK / Hiragana / Katakana / Tam Quốc / pinyin)
 11  description coherence
 12  power/tier monotonicity (new skills)
 13  cost/power ratio (anti-snowball R-ANTI)
 14  mutation fuzz 30 per skill
 15  cross-ref engine R47 + final ship report
"""
from __future__ import annotations

import hashlib
import json
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(r"C:\Users\Administrator\AppData\Local\Temp\svtk-status-cmd-skill\svtk-status")
REG = REPO / "cmd-skill" / "output" / "registry" / "skill_full.jsonl"
EXISTING_PATH = REPO / "cmd-skill" / "existing" / "SKILL_165.jsonl"

ELEMENTS = {"kim", "mộc", "thủy", "hỏa", "thổ", "tâm"}
ERAS = {"ly", "tran", "le", "nguyen", "f1"}
CLASSES = {"warrior", "mage", "priest", "bach_than", "hac_than"}
TARGETS = {"single", "aoe", "self"}
TYPES = {"physical", "magic"}

CJK_RE = re.compile(r"[一-鿿぀-ゟ゠-ヿ]")
TAM_QUOC_NAMES = [
    "Tào Tháo", "Lưu Bị", "Quan Vũ", "Trương Phi", "Khổng Minh",
    "Cao Cao", "Liu Bei", "Zhuge Liang", "Guan Yu", "Zhang Fei",
    "Tam Quốc", "Three Kingdoms",
]
TAM_QUOC_RE = re.compile("|".join(re.escape(n) for n in TAM_QUOC_NAMES))
PINYIN_RE = re.compile(r"\b(xi|qi|zh|ch|sh)[aeiou][a-z]*\b", re.IGNORECASE)

REQUIRED_FIELDS = {
    "skill_id": int,
    "name": str,
    "name_vi": str,
    "element": str,
    "tier": int,
    "type": str,
    "power": int,
    "cost_sp": int,
    "cooldown_sec": int,
    "target_type": str,
    "range_tiles": int,
    "description": str,
    "era_lore": str,
    "tso_skill_id": (int, type(None)),
    "valid_classes": list,
}


def tier_label(t: int) -> str:
    if t <= 2: return "basic"
    if t <= 4: return "advanced"
    if t <= 7: return "master"
    return "ultimate"


def _rng_for(skill_id: int) -> random.Random:
    h = hashlib.sha256(f"skill:{skill_id}".encode()).digest()
    return random.Random(int.from_bytes(h[:8], "big"))


# ------------------------------------------------------------------ load


def load_registry() -> list[dict]:
    out = []
    with REG.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def save_registry(entries: list[dict]) -> None:
    entries.sort(key=lambda e: e["skill_id"])
    REG.write_text(
        "\n".join(json.dumps(e, ensure_ascii=False) for e in entries) + "\n",
        encoding="utf-8",
    )
    h = hashlib.sha256(REG.read_bytes()).hexdigest()
    (REG.parent / (REG.name + ".sha256")).write_text(
        f"{h}  {REG.name}\n", encoding="utf-8"
    )


# ------------------------------------------------------------------ rounds


def round_1_schema(entries):
    bugs = []
    for e in entries:
        for k, t in REQUIRED_FIELDS.items():
            if k not in e:
                bugs.append((e["skill_id"], f"missing_{k}"))
                continue
            if not isinstance(e[k], t):
                bugs.append((e["skill_id"], f"type_{k}={type(e[k]).__name__}"))
        extra = set(e.keys()) - set(REQUIRED_FIELDS)
        if extra:
            bugs.append((e["skill_id"], f"extra_keys={sorted(extra)}"))
    return bugs


def round_2_ids(entries):
    bugs = []
    ids = [e["skill_id"] for e in entries]
    if len(ids) != len(set(ids)):
        dupes = [x for x, c in Counter(ids).items() if c > 1]
        bugs.append((None, f"duplicate_ids={dupes}"))
    expected = set(range(1, 301))
    missing = expected - set(ids)
    extra = set(ids) - expected
    if missing:
        bugs.append((None, f"missing_ids={sorted(missing)[:10]}"))
    if extra:
        bugs.append((None, f"extra_ids={sorted(extra)[:10]}"))
    return bugs


def round_3_elements(entries):
    return [(e["skill_id"], f"element={e['element']!r}") for e in entries if e["element"] not in ELEMENTS]


def round_4_tiers(entries):
    bugs = []
    for e in entries:
        if not (0 <= e["tier"] <= 9):
            bugs.append((e["skill_id"], f"tier_oob={e['tier']}"))
    c = Counter(tier_label(e["tier"]) for e in entries)
    if c["basic"] < 100:
        bugs.append((None, f"basic_short={c['basic']}/100"))
    if c["advanced"] < 100:
        bugs.append((None, f"advanced_short={c['advanced']}/100"))
    if c["master"] < 70:
        bugs.append((None, f"master_short={c['master']}/70"))
    if c["ultimate"] < 30:
        bugs.append((None, f"ultimate_short={c['ultimate']}/30"))
    return bugs


def round_5_numeric(entries):
    bugs = []
    for e in entries:
        if e["type"] not in TYPES:
            bugs.append((e["skill_id"], f"type={e['type']!r}"))
        if not (0 <= e["power"] <= 5000):
            bugs.append((e["skill_id"], f"power_oob={e['power']}"))
        if not (0 <= e["cost_sp"] <= 500):
            bugs.append((e["skill_id"], f"cost_oob={e['cost_sp']}"))
        if not (0 <= e["cooldown_sec"] <= 60):
            bugs.append((e["skill_id"], f"cooldown_oob={e['cooldown_sec']}"))
        if not (0 <= e["range_tiles"] <= 15):
            bugs.append((e["skill_id"], f"range_oob={e['range_tiles']}"))
    return bugs


def round_6_target_range(entries):
    bugs = []
    for e in entries:
        if e["target_type"] not in TARGETS:
            bugs.append((e["skill_id"], f"target={e['target_type']!r}"))
        if e["target_type"] == "self" and e["range_tiles"] != 0:
            bugs.append((e["skill_id"], f"self_range={e['range_tiles']}"))
        if e["target_type"] != "self" and e["range_tiles"] == 0:
            bugs.append((e["skill_id"], "nonself_zero_range"))
        if e["type"] == "physical" and e["range_tiles"] > 8:
            bugs.append((e["skill_id"], f"physical_long_range={e['range_tiles']}"))
        if e["type"] == "magic" and e["range_tiles"] > 12:
            bugs.append((e["skill_id"], f"magic_long_range={e['range_tiles']}"))
    return bugs


def round_7_era(entries):
    return [(e["skill_id"], f"era={e['era_lore']!r}") for e in entries if e["era_lore"] not in ERAS]


def round_8_class_element(entries):
    bugs = []
    for e in entries:
        cls = set(e["valid_classes"])
        if cls - CLASSES:
            bugs.append((e["skill_id"], f"unknown_class={sorted(cls - CLASSES)}"))
        if "bach_than" in cls and e["element"] != "mộc":
            bugs.append((e["skill_id"], f"bach_than_on_{e['element']}"))
        if "hac_than" in cls and e["element"] != "thổ":
            bugs.append((e["skill_id"], f"hac_than_on_{e['element']}"))
        if not cls:
            bugs.append((e["skill_id"], "no_valid_classes"))
    return bugs


def round_9_names(entries):
    bugs = []
    by_name = defaultdict(list)
    for e in entries:
        by_name[e["name"]].append(e["skill_id"])
    for name, ids in by_name.items():
        if len(ids) > 1:
            bugs.append((None, f"dupe_name {name!r} ids={ids}"))
    return bugs


def round_10_cultural(entries):
    bugs = []
    for e in entries:
        text = json.dumps(e, ensure_ascii=False)
        if CJK_RE.search(text):
            bugs.append((e["skill_id"], "cjk"))
        if TAM_QUOC_RE.search(text):
            bugs.append((e["skill_id"], "tam_quoc"))
        # Pinyin pattern likely false-positive in Vietnamese — only flag names
        for field in ("name", "description"):
            if PINYIN_RE.search(e[field]):
                bugs.append((e["skill_id"], f"pinyin_in_{field}"))
    return bugs


def round_11_desc_coherence(entries):
    bugs = []
    el_label = {"kim": "Kim", "mộc": "Mộc", "thủy": "Thủy", "hỏa": "Hỏa", "thổ": "Thổ", "tâm": "Tâm"}
    for e in entries:
        d = e["description"]
        if el_label[e["element"]] not in d and e["skill_id"] > 165:
            bugs.append((e["skill_id"], "desc_missing_element"))
        # target_type hint check (new only)
        if e["skill_id"] > 165:
            tt_map = {"single": "đơn mục tiêu", "aoe": "phạm vi", "self": "tự thân"}
            if tt_map[e["target_type"]] not in d:
                bugs.append((e["skill_id"], "desc_missing_target_hint"))
    return bugs


def round_12_monotonic(entries):
    bugs = []
    new = [e for e in entries if e["skill_id"] > 165]
    by_tier = defaultdict(list)
    for e in new:
        if e["target_type"] != "self":  # self skills can be utility
            by_tier[e["tier"]].append(e["power"])
    if not by_tier:
        return bugs
    tiers = sorted(by_tier)
    avgs = {t: sum(by_tier[t]) / len(by_tier[t]) for t in tiers}
    prev = -1
    for t in tiers:
        if avgs[t] < prev * 0.9:  # tolerate 10% wobble within tier 1 vs 2 etc.
            bugs.append((None, f"power_dip tier={t} avg={avgs[t]:.0f} prev={prev:.0f}"))
        prev = avgs[t]
    return bugs


def round_13_cost_ratio(entries):
    bugs = []
    for e in entries:
        if e["skill_id"] <= 165:
            continue
        if e["target_type"] == "self":
            continue
        if e["cost_sp"] == 0:
            bugs.append((e["skill_id"], "zero_cost"))
            continue
        ratio = e["power"] / e["cost_sp"]
        cap = 12 if e["target_type"] == "single" else 9  # aoe = stricter
        if ratio > cap:
            bugs.append((e["skill_id"], f"ratio_exploit={ratio:.2f}>{cap}"))
    return bugs


# Mutation fuzz: per new skill, apply 30 mutation classes, validator should reject
MUTATION_OPS = [
    ("tier_neg", lambda e: {**e, "tier": -1}),
    ("tier_99", lambda e: {**e, "tier": 99}),
    ("element_unknown", lambda e: {**e, "element": "ngu"}),
    ("element_capital", lambda e: {**e, "element": "Kim"}),
    ("element_noacc", lambda e: {**e, "element": "moc"}),
    ("type_invalid", lambda e: {**e, "type": "spell"}),
    ("power_neg", lambda e: {**e, "power": -10}),
    ("power_huge", lambda e: {**e, "power": 99999}),
    ("cost_neg", lambda e: {**e, "cost_sp": -1}),
    ("cost_huge", lambda e: {**e, "cost_sp": 99999}),
    ("cooldown_neg", lambda e: {**e, "cooldown_sec": -1}),
    ("cooldown_huge", lambda e: {**e, "cooldown_sec": 999}),
    ("range_neg", lambda e: {**e, "range_tiles": -1}),
    ("range_huge", lambda e: {**e, "range_tiles": 999}),
    ("target_unknown", lambda e: {**e, "target_type": "all"}),
    ("self_range_nonzero", lambda e: {**e, "target_type": "self", "range_tiles": 5}),
    ("era_unknown", lambda e: {**e, "era_lore": "han"}),
    ("class_unknown", lambda e: {**e, "valid_classes": ["ranger"]}),
    ("class_empty", lambda e: {**e, "valid_classes": []}),
    ("bach_wrong_el", lambda e: {**e, "element": "kim", "valid_classes": ["bach_than"]}),
    ("hac_wrong_el", lambda e: {**e, "element": "thủy", "valid_classes": ["hac_than"]}),
    ("name_empty", lambda e: {**e, "name": "", "name_vi": ""}),
    ("name_cjk", lambda e: {**e, "name": "斬刀", "name_vi": "斬刀"}),
    ("name_tamquoc", lambda e: {**e, "name": "Quan Vũ Trận", "name_vi": "Quan Vũ Trận"}),
    ("desc_empty", lambda e: {**e, "description": ""}),
    ("skill_id_zero", lambda e: {**e, "skill_id": 0}),
    ("skill_id_neg", lambda e: {**e, "skill_id": -1}),
    ("tso_string", lambda e: {**e, "tso_skill_id": "abc"}),
    ("extra_key", lambda e: {**e, "rogue_key": True}),
    ("missing_field", lambda e: {k: v for k, v in e.items() if k != "power"}),
]


def validate_entry(e: dict, existing_ids: set = None) -> list[str]:
    """Single-entry validator. Returns list of error labels (empty = valid)."""
    errs = []
    if not isinstance(e, dict):
        return ["not_dict"]
    for k, t in REQUIRED_FIELDS.items():
        if k not in e:
            errs.append(f"missing_{k}")
        elif not isinstance(e[k], t):
            errs.append(f"type_{k}")
    if set(e.keys()) - set(REQUIRED_FIELDS):
        errs.append("extra_keys")
    if errs:
        return errs
    if not isinstance(e["skill_id"], int) or e["skill_id"] < 1:
        errs.append("skill_id_invalid")
    if e["element"] not in ELEMENTS:
        errs.append("element")
    if not (0 <= e["tier"] <= 9):
        errs.append("tier")
    if e["type"] not in TYPES:
        errs.append("type")
    if not (0 <= e["power"] <= 5000):
        errs.append("power")
    if not (0 <= e["cost_sp"] <= 500):
        errs.append("cost")
    if not (0 <= e["cooldown_sec"] <= 60):
        errs.append("cooldown")
    if not (0 <= e["range_tiles"] <= 15):
        errs.append("range")
    if e["target_type"] not in TARGETS:
        errs.append("target")
    if e["target_type"] == "self" and e["range_tiles"] != 0:
        errs.append("self_range")
    if e["era_lore"] not in ERAS:
        errs.append("era")
    if not e["valid_classes"]:
        errs.append("class_empty")
    for c in e["valid_classes"]:
        if c not in CLASSES:
            errs.append("class_unknown")
    if "bach_than" in e["valid_classes"] and e["element"] != "mộc":
        errs.append("bach_misplace")
    if "hac_than" in e["valid_classes"] and e["element"] != "thổ":
        errs.append("hac_misplace")
    if not e["name"]:
        errs.append("name_empty")
    if not e["description"]:
        errs.append("desc_empty")
    text = json.dumps(e, ensure_ascii=False)
    if CJK_RE.search(text):
        errs.append("cjk")
    if TAM_QUOC_RE.search(text):
        errs.append("tamquoc")
    return errs


def round_14_mutation(entries):
    """For each new skill, apply 30 mutations and assert validator catches all."""
    new = [e for e in entries if e["skill_id"] > 165]
    misses = []
    for e in new:
        for op_name, op in MUTATION_OPS:
            mutated = op(e)
            errs = validate_entry(mutated)
            if not errs:
                misses.append((e["skill_id"], op_name))
    return misses


def round_15_cross_ref(entries):
    """R47 stub: damage = power * atk / (atk + def). Deterministic check shape."""
    bugs = []
    for e in entries:
        if e["skill_id"] <= 165:
            continue
        # synthetic check: damage formula must produce finite int for sample atk/def
        try:
            atk, dfn = 100, 80
            dmg = int(e["power"] * atk / max(1, atk + dfn))
            if dmg < 0 or dmg > 99999:
                bugs.append((e["skill_id"], f"damage_oob={dmg}"))
        except Exception as exc:
            bugs.append((e["skill_id"], f"damage_err={exc}"))
    return bugs


# ------------------------------------------------------------------ fixers


def fix_round_6_self_range(entries):
    n = 0
    for e in entries:
        if e["skill_id"] > 165 and e["target_type"] == "self" and e["range_tiles"] != 0:
            e["range_tiles"] = 0
            n += 1
        if e["skill_id"] > 165 and e["target_type"] != "self" and e["range_tiles"] == 0:
            e["range_tiles"] = 5
            n += 1
        if e["skill_id"] > 165 and e["type"] == "physical" and e["range_tiles"] > 8:
            e["range_tiles"] = 8
            n += 1
        if e["skill_id"] > 165 and e["type"] == "magic" and e["range_tiles"] > 12:
            e["range_tiles"] = 12
            n += 1
    return n


def fix_round_8_class_element(entries):
    """bach_than → only mộc; hac_than → only thổ. Move offending class out."""
    n = 0
    for e in entries:
        if e["skill_id"] <= 165:
            continue
        cls = list(e["valid_classes"])
        changed = False
        if "bach_than" in cls and e["element"] != "mộc":
            cls = [c for c in cls if c != "bach_than"]
            if not cls:
                cls = ["mage"]
            changed = True
        if "hac_than" in cls and e["element"] != "thổ":
            cls = [c for c in cls if c != "hac_than"]
            if not cls:
                cls = ["warrior"]
            changed = True
        if changed:
            e["valid_classes"] = cls
            n += 1
    return n


def fix_round_9_names(entries):
    """Disambiguate duplicate names by appending Vietnamese ordinal suffix."""
    SUFFIX = ["", " (Hậu)", " (Tả)", " (Hữu)", " (Trung)", " (Thượng)", " (Hạ)", " (Tiền)",
             " (Nội)", " (Ngoại)", " (Đông)", " (Tây)", " (Nam)", " (Bắc)"]
    n = 0
    seen = {}
    for e in entries:
        name = e["name"]
        if name not in seen:
            seen[name] = 1
            continue
        # Disambiguate. Existing IMMUTABLE → bump new ones only.
        if e["skill_id"] <= 165:
            seen[name] = seen.get(name, 1) + 1
            continue
        idx = seen[name]
        # Find a unique suffix
        while idx < len(SUFFIX):
            cand = name + SUFFIX[idx]
            if cand not in seen:
                e["name"] = cand
                e["name_vi"] = cand
                seen[cand] = 1
                seen[name] = idx + 1
                n += 1
                break
            idx += 1
        else:
            # Fallback numeric
            e["name"] = f"{name} #{e['skill_id']}"
            e["name_vi"] = e["name"]
            seen[e["name"]] = 1
            n += 1
    return n


def fix_round_11_desc(entries):
    """Rebuild description for new entries missing element/target hint."""
    el_label = {"kim": "Kim", "mộc": "Mộc", "thủy": "Thủy", "hỏa": "Hỏa", "thổ": "Thổ", "tâm": "Tâm"}
    label_map = {"basic": "sơ cấp", "advanced": "trung cấp", "master": "cao cấp", "ultimate": "tối thượng"}
    tt_map = {"single": "đơn mục tiêu", "aoe": "phạm vi", "self": "tự thân"}
    n = 0
    for e in entries:
        if e["skill_id"] <= 165:
            continue
        d = e["description"]
        need = False
        if el_label[e["element"]] not in d:
            need = True
        if tt_map[e["target_type"]] not in d:
            need = True
        if need:
            role = "tấn công" if e["type"] == "physical" else "phép thuật"
            e["description"] = (
                f"Chiêu {role} hệ {el_label[e['element']]} bậc "
                f"{label_map[tier_label(e['tier'])]} — {tt_map[e['target_type']]}."
            )
            n += 1
    return n


def fix_round_13_ratio(entries):
    """Bump cost_sp where ratio > cap. Keep deterministic by seeded RNG."""
    n = 0
    for e in entries:
        if e["skill_id"] <= 165 or e["target_type"] == "self":
            continue
        if e["cost_sp"] == 0:
            e["cost_sp"] = 10
            n += 1
            continue
        cap = 12 if e["target_type"] == "single" else 9
        while e["power"] / e["cost_sp"] > cap:
            e["cost_sp"] += 1
            n += 1
            if e["cost_sp"] >= 500:
                break
    return n


# ------------------------------------------------------------------ orchestrator


def main():
    entries = load_registry()
    print(f"Loaded {len(entries)} skills")

    rounds = [
        ("R01 schema_strict", round_1_schema, None),
        ("R02 id_unique_dense", round_2_ids, None),
        ("R03 element_lock", round_3_elements, None),
        ("R04 tier_consistency", round_4_tiers, None),
        ("R05 numeric_bounds", round_5_numeric, None),
        ("R06 target_range", round_6_target_range, fix_round_6_self_range),
        ("R07 era_lock", round_7_era, None),
        ("R08 class_element_compat", round_8_class_element, fix_round_8_class_element),
        ("R09 name_unique", round_9_names, fix_round_9_names),
        ("R10 cultural_lock_deep", round_10_cultural, None),
        ("R11 desc_coherence", round_11_desc_coherence, fix_round_11_desc),
        ("R12 power_monotonic", round_12_monotonic, None),
        ("R13 cost_ratio_balance", round_13_cost_ratio, fix_round_13_ratio),
        ("R14 mutation_fuzz_30x", round_14_mutation, None),
        ("R15 engine_xref", round_15_cross_ref, None),
    ]

    report = []
    for name, runner, fixer in rounds:
        # Pre-fix scan
        bugs = runner(entries)
        fixed = 0
        if bugs and fixer is not None:
            fixed = fixer(entries)
            # Re-scan after fix
            bugs_after = runner(entries)
        else:
            bugs_after = bugs
        # Filter to new-skill bugs for status
        new_bugs = [(sid, msg) for sid, msg in bugs_after if sid is None or sid > 165]
        existing_advisory = [(sid, msg) for sid, msg in bugs_after if sid is not None and sid <= 165]
        report.append({
            "round": name,
            "bugs_initial": len(bugs),
            "fixed": fixed,
            "bugs_remaining_new": len(new_bugs),
            "advisory_existing": len(existing_advisory),
            "sample_new_bugs": new_bugs[:5],
            "sample_existing_advisory": existing_advisory[:3],
        })
        flag = "PASS" if not new_bugs else "WARN"
        print(f"  {name}: init={len(bugs):>4} fixed={fixed:>3} new_remain={len(new_bugs):>3} existing_adv={len(existing_advisory):>3} [{flag}]")

    save_registry(entries)
    print(f"\nRegistry saved. Final count: {len(entries)}")
    return report


if __name__ == "__main__":
    rep = main()
    out = Path(__file__).parent / "audit_15_report.json"
    out.write_text(json.dumps(rep, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Report: {out}")
