#!/usr/bin/env python3
"""Layer 34 Hypothesis property-based test.

Strategies generate random valid item-like dicts and verify invariants
that should hold for ALL items in registry. If Hypothesis finds a
counterexample in the actual registry data, it shrinks to minimal.
"""
import json
import sys
import time
from pathlib import Path

from hypothesis import given, settings, strategies as st, HealthCheck

WORKSPACE = Path(__file__).parent
REPO_DIR = WORKSPACE / "svtk-status"
ITEM_FULL = REPO_DIR / "cmd-item" / "output" / "registry" / "item_full.jsonl"
REPORTS = REPO_DIR / "cmd-item" / "output" / "reports"


def load_items():
    out = []
    with ITEM_FULL.open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                out.append(json.loads(line))
    return out


ITEMS = load_items()
ITEM_INDICES = st.integers(min_value=0, max_value=len(ITEMS) - 1)


# ============================================================
# Properties — invariants that MUST hold for every item
# ============================================================
violations = []


def record(prop, item, evidence):
    violations.append({"property": prop, "id": item.get("id"),
                       "evidence": evidence})


@given(idx=ITEM_INDICES)
@settings(max_examples=400, deadline=None,
          suppress_health_check=[HealthCheck.too_slow])
def prop_required_fields(idx):
    it = ITEMS[idx]
    for k in ("id", "name_vi", "category", "slot", "rarity",
             "tier", "era", "era_code"):
        if k not in it:
            record("required_fields", it, f"missing {k}")
            raise AssertionError(f"{it['id']} missing {k}")


@given(idx=ITEM_INDICES)
@settings(max_examples=400, deadline=None,
          suppress_health_check=[HealthCheck.too_slow])
def prop_id_pattern(idx):
    it = ITEMS[idx]
    import re
    assert re.match(r"^item_[a-z0-9_]+$", it["id"]), \
        f"bad id {it['id']}"


@given(idx=ITEM_INDICES)
@settings(max_examples=400, deadline=None,
          suppress_health_check=[HealthCheck.too_slow])
def prop_rarity_in_enum(idx):
    it = ITEMS[idx]
    assert it["rarity"] in ("common", "uncommon", "rare",
                             "epic", "legendary", "mythic"), \
        f"bad rarity {it['rarity']}"


@given(idx=ITEM_INDICES)
@settings(max_examples=400, deadline=None,
          suppress_health_check=[HealthCheck.too_slow])
def prop_category_in_enum(idx):
    it = ITEMS[idx]
    assert it["category"] in ("weapon", "armor", "consumable",
                               "material", "quest_item", "lore_item"), \
        f"bad cat {it['category']}"


@given(idx=ITEM_INDICES)
@settings(max_examples=400, deadline=None,
          suppress_health_check=[HealthCheck.too_slow])
def prop_stats_dict_or_missing(idx):
    it = ITEMS[idx]
    s = it.get("stats")
    if s is not None:
        assert isinstance(s, dict), f"stats must be dict, got {type(s)}"


@given(idx=ITEM_INDICES)
@settings(max_examples=400, deadline=None,
          suppress_health_check=[HealthCheck.too_slow])
def prop_quest_item_has_quest_ref(idx):
    it = ITEMS[idx]
    if it["category"] == "quest_item":
        assert (it.get("quest_ref") or "").startswith("svtk_quest_"), \
            f"{it['id']} missing valid quest_ref"


@given(idx=ITEM_INDICES)
@settings(max_examples=400, deadline=None,
          suppress_health_check=[HealthCheck.too_slow])
def prop_lore_item_has_author(idx):
    it = ITEMS[idx]
    if it["category"] == "lore_item":
        assert (it.get("author") or "").strip(), \
            f"{it['id']} missing author"


@given(idx=ITEM_INDICES)
@settings(max_examples=400, deadline=None,
          suppress_health_check=[HealthCheck.too_slow])
def prop_max_stack_positive(idx):
    it = ITEMS[idx]
    ms = it.get("max_stack")
    if ms is not None:
        assert ms >= 1, f"{it['id']} max_stack {ms} < 1"


PROPERTIES = [
    ("required_fields", prop_required_fields),
    ("id_pattern", prop_id_pattern),
    ("rarity_in_enum", prop_rarity_in_enum),
    ("category_in_enum", prop_category_in_enum),
    ("stats_dict_or_missing", prop_stats_dict_or_missing),
    ("quest_item_has_quest_ref", prop_quest_item_has_quest_ref),
    ("lore_item_has_author", prop_lore_item_has_author),
    ("max_stack_positive", prop_max_stack_positive),
]


def main():
    REPORTS.mkdir(parents=True, exist_ok=True)
    results = []
    print(f"Hypothesis property test — {len(PROPERTIES)} properties × 400 examples")
    for name, prop in PROPERTIES:
        ok = True
        err = None
        try:
            prop()
        except Exception as e:
            ok = False
            err = str(e)[:200]
        results.append({"property": name, "passed": ok, "error": err})
        status = "OK" if ok else "FAIL"
        print(f"  [{status}] {name}")

    report = {
        "tool": "hypothesis",
        "total_properties": len(PROPERTIES),
        "passed": sum(1 for r in results if r["passed"]),
        "failed": sum(1 for r in results if not r["passed"]),
        "results": results,
        "items_audited": len(ITEMS),
        "examples_per_property": 400,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    out = REPORTS / "hypothesis_property_report.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False),
                   encoding="utf-8")
    print(f"\n{report['passed']}/{report['total_properties']} properties pass")
    print(f"Wrote {out}")
    return 0 if report["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
