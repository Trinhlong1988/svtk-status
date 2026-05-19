"""15 tests cho CMD_BOSS output — pure stdlib, runnable bằng python boss_tests.py."""
import json
import re
import sys
from pathlib import Path
from collections import Counter

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "registry"
SCHEMA = ROOT / "schema"

TARGET_TOTAL = 1200
TARGET_BY_CLASS = {"normal": 600, "elite": 300, "raid": 200, "world": 100}
VALID_ERAS = {"ly", "tran", "le", "tay_son", "nguyen"}
VALID_ELEMENTS = {"kim", "mộc", "thủy", "hỏa", "thổ", "tâm"}
VALID_CLASSES = {"normal", "elite", "raid", "world"}
VALID_NPC_CLASSES = {"boss", "thanh", "than"}

CJK_RE = re.compile(r"[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]")
TAM_QUOC_RE = re.compile(
    r"(Tào Tháo|Lưu Bị|Quan Vũ|Trương Phi|Khổng Minh|Gia Cát|Tôn Quyền|Tam Quốc)",
    re.IGNORECASE,
)


def load_entries():
    path = REGISTRY / "boss_full.jsonl"
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def derive_class(entry):
    if entry.get("boss_tier_class"):
        return entry["boss_tier_class"]
    tier = entry.get("tier")
    npc_class = entry.get("npc_class")
    if tier == 7 and npc_class == "thanh":
        return "raid"
    return {6: "normal", 7: "elite", 8: "raid", 9: "world"}.get(tier)


def test_01_count_target():
    entries = load_entries()
    assert len(entries) >= TARGET_TOTAL, f"count {len(entries)} < {TARGET_TOTAL}"


def test_02_distribution_by_class():
    entries = load_entries()
    by_cls = Counter(derive_class(e) for e in entries)
    for cls, target in TARGET_BY_CLASS.items():
        assert by_cls[cls] >= target, f"{cls} actual={by_cls[cls]} target={target}"


def test_03_boss_id_unique():
    entries = load_entries()
    ids = [e["boss_id"] for e in entries]
    assert len(ids) == len(set(ids)), "duplicate boss_id"


def test_04_uuid_unique_for_generated():
    entries = load_entries()
    uuids = [e["uuid"] for e in entries if e.get("uuid")]
    assert len(uuids) == len(set(uuids)), "duplicate uuid in generated entries"


def test_05_era_valid():
    entries = load_entries()
    for e in entries:
        assert e["era"] in VALID_ERAS, f"invalid era: {e['era']} boss_id={e['boss_id']}"


def test_06_element_valid():
    entries = load_entries()
    for e in entries:
        assert e["element"] in VALID_ELEMENTS, f"invalid element: {e['element']}"


def test_07_npc_class_valid():
    entries = load_entries()
    for e in entries:
        assert e["npc_class"] in VALID_NPC_CLASSES, f"invalid npc_class: {e['npc_class']}"


def test_08_cultural_lock_no_cjk():
    entries = load_entries()
    for e in entries:
        blob = json.dumps(e, ensure_ascii=False)
        assert not CJK_RE.search(blob), f"CJK found in boss_id={e['boss_id']}"


def test_09_cultural_lock_no_tam_quoc():
    entries = load_entries()
    for e in entries:
        blob = json.dumps(e, ensure_ascii=False)
        assert not TAM_QUOC_RE.search(blob), f"Tam Quoc ref in boss_id={e['boss_id']}"


def test_10_stat_monotonic_by_class():
    """Normal level <= elite <= raid <= world."""
    entries = load_entries()
    level_by_cls = {}
    for e in entries:
        cls = derive_class(e)
        level_by_cls.setdefault(cls, []).append(e["level"])
    seq = [max(level_by_cls.get(c, [0])) for c in ("normal", "elite", "raid", "world")]
    assert seq == sorted(seq), f"level not monotonic: {seq}"


def test_11_spawn_config_present_for_generated():
    entries = load_entries()
    for e in entries:
        if e.get("_generated_origin"):
            assert "spawn_config" in e and "map_zone" in e["spawn_config"]


def test_12_drop_table_present_for_generated():
    entries = load_entries()
    for e in entries:
        if e.get("_generated_origin"):
            assert "drop_table" in e and len(e["drop_table"]) >= 1


def test_13_drop_rate_valid_range():
    entries = load_entries()
    for e in entries:
        for d in e.get("drop_table", []):
            assert 0.0 < d["drop_rate"] <= 1.0, f"drop_rate out of range: {d['drop_rate']}"


def test_14_schema_sql_has_unique_constraint():
    sql = (SCHEMA / "boss_table.sql").read_text(encoding="utf-8")
    assert "UNIQUE(natural_key)" in sql
    assert "UNIQUE(uuid)" in sql


def test_15_existing_seed_preserved():
    """Existing IMMUTABLE — 13 seed bosses (boss_id 1..13) phải xuất hiện y nguyên."""
    entries = load_entries()
    seed_ids = {e["boss_id"] for e in entries if e.get("_seed_origin") == "cmd_map_seed_20260519"}
    assert seed_ids == set(range(1, 14)), f"seed ids mismatch: {seed_ids}"


ALL_TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]


if __name__ == "__main__":
    failed = []
    for fn in ALL_TESTS:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as ex:
            failed.append((fn.__name__, str(ex)))
            print(f"FAIL {fn.__name__}: {ex}")
    if failed:
        print(f"\n{len(failed)}/{len(ALL_TESTS)} FAILED")
        sys.exit(1)
    print(f"\nALL {len(ALL_TESTS)} TESTS PASS")
    sys.exit(0)
