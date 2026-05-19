"""20+ tests cho CMD_BOSS v1.4 output."""
import json
import re
import sys
from pathlib import Path
from collections import Counter

ROOT = Path(__file__).resolve().parent.parent
REG = ROOT / "registry"

VALID_ELEMENTS = {"KIM", "MOC", "THUY", "HOA", "THO", "TAM"}
VALID_PATHS = {"none", "BACH", "HAC"}
VALID_TIERS = {"normal", "elite", "raid", "world"}
VALID_ERAS = {"ly","tran","le","tay_son","nguyen","f1","f2","f3","f4","f5","g1"}
VALID_ARCHETYPES = {"ho_tinh","cao_tinh","rong_viet","rua_than","phuong_hoang",
                    "yeu_quai","ma_vuong","tuong_quan","thay_phap","kiem_si",
                    "than_linh","quy_than","co_gioi"}
VALID_FACTIONS = {"viet_anhhung","ngoai_xam","yeumotruyen","truyenthuyet",
                  "thap_nhi_su_quan","thoan_ngoi","generic"}

CJK_RE = re.compile(r"[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]")
BANNED_RE = re.compile(r"(Tào Tháo|Lưu Bị|Quan Vũ|Tam Quốc|Lữ Bố)", re.IGNORECASE)


def load_full():
    return [json.loads(l) for l in (REG / "boss_full.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]


def test_01_total_1200():
    assert len(load_full()) == 1200, f"count={len(load_full())}"


def test_02_named_100():
    assert sum(1 for b in load_full() if b.get("is_named")) == 100


def test_03_generic_1100():
    assert sum(1 for b in load_full() if not b.get("is_named")) == 1100


def test_04_unique_boss_ids():
    bs = load_full()
    assert len({b["boss_id"] for b in bs}) == 1200


def test_05_unique_uuids():
    bs = load_full()
    uuids = [b["uuid"] for b in bs if b.get("uuid")]
    assert len(uuids) == len(set(uuids)) == 1200


def test_06_id_range_1_to_1200():
    bs = load_full()
    ids = [b["boss_id"] for b in bs]
    assert min(ids) == 1 and max(ids) == 1200


def test_07_tier_split():
    bs = load_full()
    by_tier = Counter(b["tier"] for b in bs)
    assert by_tier["normal"] == 600
    assert by_tier["elite"] == 300
    assert by_tier["raid"] == 200
    assert by_tier["world"] == 100


def test_08_element_only_ngu_hanh():
    """R86: element ∈ 6 ngũ hành ONLY, KHÔNG có BACH/HAC trong element."""
    for b in load_full():
        assert b["element"] in VALID_ELEMENTS, f"boss {b['boss_id']} element={b['element']}"


def test_09_path_valid():
    """R86: path ∈ {none, BACH, HAC}."""
    for b in load_full():
        assert b["path"] in VALID_PATHS, f"boss {b['boss_id']} path={b['path']}"


def test_10_generic_path_is_none():
    """R86: generic boss path = none (RB3 unlock chỉ cho named)."""
    for b in load_full():
        if not b.get("is_named"):
            assert b["path"] == "none", f"generic {b['boss_id']} path={b['path']}"


def test_11_archetype_valid():
    for b in load_full():
        assert b["archetype"] in VALID_ARCHETYPES


def test_12_faction_valid():
    for b in load_full():
        assert b["faction"] in VALID_FACTIONS


def test_13_era_valid():
    for b in load_full():
        assert b["era"] in VALID_ERAS


def test_14_tier_valid():
    for b in load_full():
        assert b["tier"] in VALID_TIERS


def test_15_behavior_tree_present():
    for b in load_full():
        assert "behavior_tree" in b
        assert "phases" in b["behavior_tree"]
        assert "threat_table" in b["behavior_tree"]
        assert "class_counter" in b["behavior_tree"]
        assert "enrage_sec" in b["behavior_tree"]


def test_16_generic_world_4_phases():
    """Generic world boss = brief default 4 phases. Named may vary per roster."""
    for b in load_full():
        if b["tier"] == "world" and not b.get("is_named"):
            assert len(b["behavior_tree"]["phases"]) == 4


def test_17_generic_raid_3_phases():
    for b in load_full():
        if b["tier"] == "raid" and not b.get("is_named"):
            assert len(b["behavior_tree"]["phases"]) == 3


def test_18_generic_normal_1_phase():
    for b in load_full():
        if b["tier"] == "normal" and not b.get("is_named"):
            assert len(b["behavior_tree"]["phases"]) == 1


def test_18b_named_phases_at_least_1():
    """R85 source of truth: named phases come from roster v2 (variable)."""
    for b in load_full():
        if b.get("is_named"):
            assert len(b["behavior_tree"]["phases"]) >= 1


def test_19_named_has_historical():
    for b in load_full():
        if b.get("is_named"):
            assert b.get("historical"), f"named {b['name']} no historical"
            assert b.get("lore_quote"), f"named {b['name']} no quote"


def test_20_stats_positive():
    for b in load_full():
        assert b["hp"] > 0 and b["atk"] > 0 and b["def"] > 0


def test_21_cultural_lock():
    """R85.1: no CJK, no Tam Quốc refs."""
    for b in load_full():
        blob = json.dumps(b, ensure_ascii=False)
        assert not CJK_RE.search(blob), f"CJK in boss {b['boss_id']}"
        assert not BANNED_RE.search(blob), f"banned in boss {b['boss_id']}"


def test_22_raid_world_have_class_counter():
    for b in load_full():
        if b["tier"] in ("raid", "world"):
            assert b["behavior_tree"]["class_counter"], f"boss {b['boss_id']} no counter"


def test_23_raid_world_have_add_waves():
    for b in load_full():
        if b["tier"] in ("raid", "world"):
            assert b["behavior_tree"].get("add_waves") is not None


def test_24_enrage_ordering():
    """Normal < Elite < Raid < World enrage_sec (generic default)."""
    bs = load_full()
    e_by_tier = {}
    for b in bs:
        if not b.get("is_named"):  # generic only — named có thể override
            e_by_tier.setdefault(b["tier"], set()).add(b["behavior_tree"]["enrage_sec"])
    seq = [list(e_by_tier[t])[0] for t in ("normal","elite","raid","world")]
    assert seq == sorted(seq), f"enrage not monotonic: {seq}"


def test_25_named_path_distribution():
    """R86 + roster v2: 4 BACH + 24 HAC + 72 none = 100 named."""
    bs = [b for b in load_full() if b.get("is_named")]
    paths = Counter(b["path"] for b in bs)
    assert paths["none"] == 72, f"none={paths['none']}"
    assert paths["BACH"] == 4, f"BACH={paths['BACH']}"
    assert paths["HAC"] == 24, f"HAC={paths['HAC']}"


ALL_TESTS = sorted([v for k, v in globals().items() if k.startswith("test_")], key=lambda f: f.__name__)


if __name__ == "__main__":
    failed = []
    for fn in ALL_TESTS:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as e:
            failed.append((fn.__name__, str(e)))
            print(f"FAIL {fn.__name__}: {e}")
    print(f"\n{len(ALL_TESTS) - len(failed)}/{len(ALL_TESTS)} PASS")
    sys.exit(0 if not failed else 1)
