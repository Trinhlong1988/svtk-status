#!/usr/bin/env python3
"""Layer 8 mutation testing — verify deep_audit catches injected bugs.

Strategy: load valid item_full.jsonl, apply 1 mutation, save to temp file,
swap with real output, run deep_audit, expect FAIL. Restore. Repeat.

Reports blind spots = mutations validator misses → audit quality gap.
"""
import sys, json, shutil, subprocess, hashlib, time
from pathlib import Path

REPO_DIR = Path(__file__).parent / "svtk-status"
ITEM_FULL = REPO_DIR / "cmd-item" / "output" / "registry" / "item_full.jsonl"
BACKUP = ITEM_FULL.with_suffix(".jsonl.backup")
AUDIT = Path(__file__).parent / "deep_audit.py"
MUT_REPORT = REPO_DIR / "cmd-item" / "output" / "reports" / \
    "mutation_test_report.json"


MUTATIONS = [
    {
        "id": "M1_invalid_element",
        "expect_catch": "R79_element_only_6",
        "apply": lambda items: _set_field(items, "weapon", "element", "INVALID"),
    },
    {
        "id": "M2_duplicate_template_id",
        "expect_catch": "R50_template_id_unique",
        "apply": lambda items: _set_idx_field(items, 7, "template_id",
                                              items[6]["template_id"]),
    },
    {
        "id": "M3_empty_name",
        "expect_catch": "R50_no_empty_string_in_required",
        "apply": lambda items: _set_idx_field(items, 100, "name_vi", ""),
    },
    {
        "id": "M4_invalid_era_code",
        "expect_catch": "data_era_code_canonical_subset",
        "apply": lambda items: _set_idx_field(items, 200, "era_code",
                                              "ming_dynasty"),
    },
    {
        "id": "M5_invalid_rarity",
        "expect_catch": "schema_rarity_valid",
        "apply": lambda items: _set_idx_field(items, 300, "rarity", "ultra"),
    },
    {
        "id": "M6_cjk_inject",
        "expect_catch": "R30_cultural_lock",
        "apply": lambda items: _set_idx_field(items, 400, "name_vi",
                                              "Kiếm 曹操"),
    },
    {
        "id": "M7_tam_quoc_inject",
        "expect_catch": "R30_cultural_lock",
        "apply": lambda items: _set_idx_field(items, 500, "name_vi",
                                              "Kiếm Tào Tháo"),
    },
    {
        "id": "M8_invalid_category",
        "expect_catch": "schema_category_valid",
        "apply": lambda items: _set_idx_field(items, 600, "category", "wpn"),
    },
    {
        "id": "M9_old_bach_element",
        "expect_catch": "R79_element_only_6",
        "apply": lambda items: _set_field(items, "weapon", "element", "BACH"),
    },
    {
        "id": "M10_negative_sell_price",
        "expect_catch": "schema_sell_price_nonneg",
        "apply": lambda items: _set_idx_field(items, 700, "sell_price_gold", -50),
    },
    {
        "id": "M11_invalid_cultural_tag",
        "expect_catch": "R74_cultural_tag_valid",
        "apply": lambda items: _set_idx_field(items, 800, "cultural_tag",
                                              "tam_quoc"),
    },
    {
        "id": "M12_slot_invalid",
        "expect_catch": "schema_slot_valid",
        "apply": lambda items: _set_idx_field(items, 900, "slot", "head_armor"),
    },
    {
        "id": "M13_consecutive_spaces_name",
        "expect_catch": "data_no_consecutive_spaces",
        "apply": lambda items: _set_idx_field(items, 1000, "name_vi",
                                              "Kiếm  Lý  #1"),
    },
    {
        "id": "M14_seed_id_mutate",
        "expect_catch": "R71_existing_unmodified",
        "apply": lambda items: _mutate_seed(items, "name_vi", "Đao Hacked"),
    },
    {
        "id": "M15_tam_weapon_remove_resonance",
        "expect_catch": "R79_tam_resonance_present",
        "apply": lambda items: _remove_tam_resonance(items),
    },
    {
        "id": "M16_drop_id_field",
        "expect_catch": "R50_required_fields",
        "apply": lambda items: _drop_field(items, 1100, "id"),
    },
    {
        "id": "M17_extra_unknown_field",
        "expect_catch": "schema_no_extra_unknown_fields",
        "apply": lambda items: _set_idx_field(items, 1200, "secret_backdoor",
                                              True),
    },
    {
        "id": "M18_atk_def_topfield_leak",
        "expect_catch": "schema_no_atk_def_topfield",
        "apply": lambda items: _set_idx_field(items, 1300, "atk_bp", 999),
    },
    {
        "id": "M19_lore_great_4_wrong_era",
        "expect_catch": "R83_lore_4_great_era_correct",
        "apply": lambda items: _mutate_great4_era(items),
    },
    {
        "id": "M20_lore_great_4_low_rarity",
        "expect_catch": "R83_lore_great_4_legendary_plus_strict",
        "apply": lambda items: _mutate_great4_rarity(items),
    },
]


def _set_field(items, category, field, value):
    """Set field on first non-seed item matching category."""
    for it in items:
        if it.get("category") == category and not it.get("is_immutable_seed"):
            it[field] = value
            return it["id"]
    return None


def _set_idx_field(items, idx, field, value):
    if idx < len(items):
        items[idx][field] = value
        return items[idx]["id"]
    return None


def _mutate_seed(items, field, value):
    for it in items:
        if it.get("is_immutable_seed"):
            it[field] = value
            return it["id"]
    return None


def _drop_field(items, idx, field):
    if idx < len(items) and field in items[idx]:
        items[idx].pop(field)
        return items[idx].get("id", "?")
    return None


def _remove_tam_resonance(items):
    for it in items:
        if (it.get("element") == "TAM"
                and not it.get("is_immutable_seed")
                and "tam_resonance_bp" in (it.get("stats") or {})):
            del it["stats"]["tam_resonance_bp"]
            return it["id"]
    return None


def _mutate_great4_era(items):
    for it in items:
        if it.get("name_vi") == "Bản Chiếu Dời Đô":
            it["era_code"] = "nguyen"  # should be 'ly'
            return it["id"]
    return None


def _mutate_great4_rarity(items):
    for it in items:
        if it.get("name_vi") == "Hịch Tướng Sĩ":
            it["rarity"] = "common"  # should be legendary
            return it["id"]
    return None


def load_items():
    items = []
    with ITEM_FULL.open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                items.append(json.loads(line))
    return items


def write_items(items):
    """B35 atomic: write to .tmp + os.replace so audit readers never see
    half-written jsonl. Was non-atomic before — caused 'Unterminated string'
    JSONDecodeError in audit when run in parallel."""
    import os
    tmp = ITEM_FULL.with_suffix(".jsonl.tmp")
    payload = ("\n".join(json.dumps(it, ensure_ascii=False) for it in items)
               + "\n").encode("utf-8")
    with open(tmp, "wb") as f:
        f.write(payload)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, ITEM_FULL)


def run_audit_get_failures() -> list:
    """Run deep_audit with NO_WARMUP=1, force UTF-8 decode (Windows cp1252 fix)."""
    import os
    env = dict(os.environ)
    env["NO_WARMUP"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    r = subprocess.run([sys.executable, str(AUDIT)],
                        capture_output=True, text=True, timeout=120, env=env,
                        encoding="utf-8", errors="replace")
    out = r.stdout or ""
    failures = []
    for line in out.split("\n"):
        line = line.strip()
        if line.startswith("FAIL"):
            parts = line.split("]", 1)
            if len(parts) > 1:
                check_part = parts[1].strip().split(" ", 1)
                if check_part:
                    failures.append(check_part[0])
    return failures


def main():
    if not ITEM_FULL.exists():
        print("ERROR: gen output missing — run generate_items.py first")
        return 1

    # Snapshot original
    shutil.copy(ITEM_FULL, BACKUP)

    results = []
    blind_spots = []
    caught = []

    print(f"Starting {len(MUTATIONS)} mutations...", flush=True)
    for i, mut in enumerate(MUTATIONS, 1):
        mid = mut["id"]
        expect = mut["expect_catch"]
        print(f"[{i}/{len(MUTATIONS)}] {mid}...", flush=True)
        items = load_items()
        target_id = mut["apply"](items)
        if target_id is None:
            results.append({"mutation": mid, "status": "SKIP_no_target"})
            continue
        write_items(items)

        failures = run_audit_get_failures()
        # Mutation caught if validator returns ANY failure (lenient — catch
        # may surface under different rule than expected). Filter out the
        # mutation_test self-meta check (R49_mutation_no_blind_spots) and
        # concurrency artifact (R49_artifact_concurrency_test_report) which
        # are not items-bound.
        IGNORE = {"R49_mutation_no_blind_spots",
                  "artifact_concurrency_test_report",
                  "R68_concurrency_all_returncode_zero",
                  "R68_concurrency_line_count_match"}
        item_failures = [f for f in failures if f not in IGNORE]
        was_caught = expect in item_failures or len(item_failures) > 0
        catch_kind = "exact" if expect in item_failures else (
            "lenient" if item_failures else "missed")
        if was_caught:
            caught.append({"mutation": mid,
                            "expected_catch": expect,
                            "actual_catches": item_failures[:3],
                            "kind": catch_kind,
                            "target": target_id})
        else:
            blind_spots.append({"mutation": mid, "expected_catch": expect,
                                  "target": target_id,
                                  "actual_failures": item_failures[:5]})

        results.append({
            "mutation": mid,
            "expect": expect,
            "caught": was_caught,
            "catch_kind": catch_kind,
            "actual_failures": item_failures[:3],
            "target_id": target_id,
        })
        # Restore for next round
        shutil.copy(BACKUP, ITEM_FULL)

    # Restore final via atomic replace, then remove backup.
    # B36 v1.30 fix: previous shutil.copy left .backup file around if
    # mutation_test crashed mid-run — caught by L23 artifact_no_phantom_files.
    try:
        import os
        os.replace(BACKUP, ITEM_FULL)
    except FileNotFoundError:
        pass
    # Ensure no .backup or .tmp left behind even on exception path.
    for stray in (BACKUP, ITEM_FULL.with_suffix(".jsonl.tmp")):
        try:
            stray.unlink()
        except FileNotFoundError:
            pass

    summary = {
        "total_mutations": len(MUTATIONS),
        "caught_count": len(caught),
        "blind_spot_count": len(blind_spots),
        "catch_rate": round(len(caught) / len(MUTATIONS), 3),
        "results": results,
        "blind_spots": blind_spots,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    MUT_REPORT.parent.mkdir(parents=True, exist_ok=True)
    MUT_REPORT.write_bytes(
        (json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
        .encode("utf-8")
    )

    print(f"\n=== MUTATION TEST COMPLETE ===")
    print(f"Total: {summary['total_mutations']}")
    print(f"Caught: {summary['caught_count']} ({summary['catch_rate'] * 100:.1f}%)")
    print(f"Blind spots: {summary['blind_spot_count']}")
    for bs in blind_spots[:5]:
        print(f"  BLIND: {bs['mutation']} expected={bs['expected_catch']}")
    return 0 if not blind_spots else 1


if __name__ == "__main__":
    sys.exit(main())
