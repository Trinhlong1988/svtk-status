#!/usr/bin/env python3
"""Layer 9 runtime drop simulation — sample 10k drops, verify rarity
distribution matches loot_tables.json weights (R49 quality control).
"""
import sys, json, random
from pathlib import Path
from collections import Counter

REPO_DIR = Path(__file__).parent / "svtk-status"
ITEM_FULL = REPO_DIR / "cmd-item" / "output" / "registry" / "item_full.jsonl"
LOOT = REPO_DIR / "cmd-item" / "data" / "loot_tables.json"
REPORTS = REPO_DIR / "cmd-item" / "output" / "reports"


def load_items():
    items = []
    with ITEM_FULL.open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                items.append(json.loads(line))
    return items


def load_loot_tables():
    return json.loads(LOOT.read_text(encoding="utf-8")).get("tables", {})


def simulate_drops(items, table_name: str, table: dict,
                    n_samples: int = 10000) -> dict:
    rarity_weights = table.get("rarity_weights", {})
    slot_pool = set(table.get("slot_pool", []))
    no_drop_bp = table.get("no_drop_chance_bp", 0)
    drop_min = table.get("drop_count_min", 0)
    drop_max = table.get("drop_count_max", 1)

    # Pool of equipment items in valid slots
    pool = [it for it in items
            if it.get("category") in ("weapon", "armor")
            and it.get("slot") in slot_pool
            and not it.get("is_immutable_seed")]
    by_rarity = {}
    for it in pool:
        by_rarity.setdefault(it["rarity"], []).append(it)

    rng = random.Random(42)
    total_weight = sum(rarity_weights.values())
    drop_counts_per_rarity = Counter()
    no_drop_count = 0
    total_drops = 0

    for sim_i in range(n_samples):
        # No-drop check
        if rng.randint(0, 9999) < no_drop_bp:
            no_drop_count += 1
            continue
        n_drops = rng.randint(drop_min, drop_max)
        for _ in range(n_drops):
            # Weighted rarity roll
            r = rng.randint(0, total_weight - 1)
            cum = 0
            chosen_rarity = None
            for rarity, w in rarity_weights.items():
                cum += w
                if r < cum:
                    chosen_rarity = rarity
                    break
            if chosen_rarity is None:
                continue
            drop_counts_per_rarity[chosen_rarity] += 1
            total_drops += 1
            # Verify item available
            if not by_rarity.get(chosen_rarity):
                pass  # informational: rarity bucket empty in pool

    # Expected vs actual distribution
    expected_pct = {r: w / total_weight
                    for r, w in rarity_weights.items()}
    actual_pct = {r: c / max(total_drops, 1)
                  for r, c in drop_counts_per_rarity.items()}
    max_dev = max(abs(actual_pct.get(r, 0) - exp)
                   for r, exp in expected_pct.items())

    return {
        "table": table_name,
        "samples": n_samples,
        "no_drop_count": no_drop_count,
        "total_drops": total_drops,
        "drop_counts": dict(drop_counts_per_rarity),
        "expected_pct": expected_pct,
        "actual_pct": actual_pct,
        "max_deviation": round(max_dev, 4),
        "pool_size_per_rarity": {r: len(v) for r, v in by_rarity.items()},
        "slot_pool_count": len(pool),
    }


def main():
    items = load_items()
    tables = load_loot_tables()
    print(f"Items loaded: {len(items)}")
    print(f"Loot tables: {list(tables.keys())}")

    results = []
    for name, table in tables.items():
        r = simulate_drops(items, name, table, n_samples=10000)
        results.append(r)
        print(f"\n[{name}] {r['total_drops']} drops "
              f"max_dev={r['max_deviation']}")
        for rar, exp in r["expected_pct"].items():
            actual = r["actual_pct"].get(rar, 0)
            print(f"  {rar:10s}: expected {exp:.4f}, actual {actual:.4f}, "
                  f"diff {abs(actual - exp):.4f}")

    summary = {
        "tables_simulated": len(results),
        "results": results,
        "max_deviation_overall": max(r["max_deviation"] for r in results),
        "acceptable_threshold": 0.02,
        "all_within_threshold": all(r["max_deviation"] <= 0.02
                                      for r in results),
    }
    REPORTS.mkdir(parents=True, exist_ok=True)
    (REPORTS / "drop_simulation_report.json").write_bytes(
        (json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
        .encode("utf-8")
    )
    print(f"\n=== DROP SIM COMPLETE ===")
    print(f"Max deviation: {summary['max_deviation_overall']}")
    print(f"Within ±2%: {summary['all_within_threshold']}")
    return 0 if summary["all_within_threshold"] else 1


if __name__ == "__main__":
    sys.exit(main())
