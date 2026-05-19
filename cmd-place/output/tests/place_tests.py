"""CMD_PLACE v1.0 — registry tests (>=15)."""
import json, re, os
from pathlib import Path
from collections import Counter

ROOT = Path(__file__).resolve().parent.parent
REG = ROOT / "registry"

ERAS = ["ly", "tran", "le", "tay_son", "nguyen"]
BIOMES = ["forest", "mountain", "river", "plain", "sea", "capital", "village"]
TARGET_MAPS = 7047
TARGET_SHARDS = 64

CULTURAL_LOCK_REGEX = re.compile(r"[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]")
TAM_QUOC_BAN_REGEX = re.compile(
    r"(Tào Tháo|Lưu Bị|Quan Vũ|Trương Phi|Khổng Minh|Cao Cao|Liu Bei|Zhuge Liang|Guan Yu|Zhang Fei|Tam Quốc)"
)


def _load_maps():
    with open(REG / "map_registry.jsonl", encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def _load_regions():
    with open(REG / "region.jsonl", encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def _load_shard_config():
    return json.loads((REG / "shard_config.json").read_text(encoding="utf-8"))


def test_01_map_count():
    assert len(_load_maps()) == TARGET_MAPS


def test_02_map_id_range_unique():
    ids = [m["map_id"] for m in _load_maps()]
    assert min(ids) == 1
    assert max(ids) == TARGET_MAPS
    assert len(set(ids)) == TARGET_MAPS


def test_03_natural_key_unique():
    keys = [m["natural_key"] for m in _load_maps()]
    assert len(set(keys)) == TARGET_MAPS


def test_04_uuid_unique():
    uuids = [m["uuid"] for m in _load_maps()]
    assert len(set(uuids)) == TARGET_MAPS


def test_05_region_shard_count():
    assert len(_load_regions()) == TARGET_SHARDS


def test_06_era_coverage_5():
    eras = {m["era"] for m in _load_maps()}
    assert eras == set(ERAS)


def test_07_biome_coverage_7():
    biomes = {m["biome"] for m in _load_maps()}
    assert biomes == set(BIOMES)


def test_08_shard_id_in_range():
    for m in _load_maps():
        assert 0 <= m["shard_id"] < TARGET_SHARDS


def test_09_shard_balance_delta_le_2():
    counts = Counter(m["shard_id"] for m in _load_maps())
    delta = max(counts.values()) - min(counts.values())
    assert delta <= 2, f"shard balance delta={delta}"


def test_10_cultural_lock_no_cjk():
    for m in _load_maps():
        assert not CULTURAL_LOCK_REGEX.search(m["name"]), m["name"]


def test_11_no_tam_quoc():
    for m in _load_maps():
        assert not TAM_QUOC_BAN_REGEX.search(m["name"]), m["name"]


def test_12_f_prefix_valid():
    valid = {"f1", "f2", "f3", "f4", "f5", "g1"}
    for m in _load_maps():
        assert m["f_prefix"] in valid


def test_13_era_distribution_within_tolerance():
    counts = Counter(m["era"] for m in _load_maps())
    target_per_era = TARGET_MAPS / len(ERAS)
    for era, c in counts.items():
        assert abs(c - target_per_era) <= 1, f"era {era}={c}"


def test_14_tsonline_cross_ref_present():
    for m in _load_maps():
        assert m["tsonline_cross_ref"].startswith("tsonline_map_pool/")


def test_15_shard_config_self_consistent():
    cfg = _load_shard_config()
    assert cfg["total_maps"] == TARGET_MAPS
    assert cfg["total_shards"] == TARGET_SHARDS
    assert sum(cfg["shard_size_actual"]) == TARGET_MAPS
    assert cfg["balance_max_delta"] <= 2


def test_16_schema_sql_present():
    sql = (ROOT / "schema" / "place_table.sql").read_text(encoding="utf-8")
    assert "UNIQUE(natural_key)" in sql
    assert "UNIQUE(uuid)" in sql
    assert "UNIQUE(map_id)" in sql


def test_17_coord_in_range():
    for m in _load_maps():
        assert 0 <= m["coord_x"] <= 99999
        assert 0 <= m["coord_y"] <= 99999


if __name__ == "__main__":
    import sys, traceback
    fns = [v for k, v in list(globals().items()) if k.startswith("test_") and callable(v)]
    fails = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception as e:
            fails += 1
            print(f"FAIL {fn.__name__}: {e}")
            traceback.print_exc()
    print(f"TOTAL {len(fns)} PASS {len(fns)-fails} FAIL {fails}")
    sys.exit(0 if fails == 0 else 1)
