"""CMD_MAP v1.1 — 18 pytest tests (R45/R47/R49/R50/R68/R71/R79)."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REG = ROOT / "registry"
MANIFEST = REG / "map_image_manifest.jsonl"
CONFIG = REG / "gen_config.json"
SCHEMA = REG / "map_image_table.sql"

TARGET_IMAGE_COUNT = 8500
TSO_BASELINE = 7047

CJK = re.compile(r"[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]")
TAM_QUOC = re.compile(
    r"(Tào Tháo|Lưu Bị|Quan Vũ|Trương Phi|Khổng Minh|Cao Cao|Tam Quốc|Tam Quoc)",
    re.IGNORECASE,
)
BIOMES = {"forest", "mountain", "river", "plain", "sea", "capital", "village",
          "town", "dungeon", "capital_inner"}
ERAS = {"ly", "tran", "le", "tay_son", "nguyen", "f1", "f2", "f3", "f4", "f5", "g1"}
REGIONS = {"bac_bo", "trung_bo", "nam_bo"}
ELEMENTS = {"kim", "mộc", "thổ", "thủy", "hỏa", "tâm"}


def _load():
    return [json.loads(l) for l in MANIFEST.read_text(encoding="utf-8").splitlines() if l.strip()]


def test_01_manifest_exists():
    assert MANIFEST.exists(), "manifest jsonl missing"


def test_02_config_exists():
    assert CONFIG.exists() and SCHEMA.exists()


def test_03_count_meets_target():
    entries = _load()
    assert len(entries) >= TARGET_IMAGE_COUNT, f"count={len(entries)}"


def test_04_count_exceeds_tso_baseline():
    entries = _load()
    assert len(entries) > TSO_BASELINE


def test_05_image_id_unique_R45():
    entries = _load()
    ids = [e["mapId_at_0x00"] for e in entries]
    assert len(ids) == len(set(ids)), "duplicate mapId_at_0x00"


def test_06_filename_unique():
    entries = _load()
    names = [e["image_filename"] for e in entries]
    assert len(names) == len(set(names)), "duplicate image_filename"


def test_07_filename_pattern_R50():
    entries = _load()
    pat = re.compile(r"^map_\d{5}\.jpg$")
    bad = [e["image_filename"] for e in entries if not pat.match(e["image_filename"])]
    assert not bad, bad[:3]


def test_08_biome_valid_R49():
    entries = _load()
    bad = [e for e in entries if e["biome"] not in BIOMES]
    assert not bad, [e.get("biome") for e in bad[:3]]


def test_09_era_valid_R49():
    entries = _load()
    bad = [e for e in entries if e["era"] not in ERAS]
    assert not bad, [e.get("era") for e in bad[:3]]


def test_10_region_valid_R49():
    entries = _load()
    bad = [e for e in entries if e["region"] not in REGIONS]
    assert not bad, [e.get("region") for e in bad[:3]]


def test_11_resolution_locked():
    entries = _load()
    bad = [e for e in entries
           if e["image_resolution_w"] != 832 or e["image_resolution_h"] != 640]
    assert not bad


def test_12_quality_range():
    entries = _load()
    bad = [e for e in entries if not (60 <= e["image_quality"] <= 75)]
    assert not bad


def test_13_cultural_lock_no_CJK():
    text = MANIFEST.read_text(encoding="utf-8")
    assert not CJK.search(text), "CJK chars found"


def test_14_cultural_lock_no_tam_quoc():
    text = MANIFEST.read_text(encoding="utf-8")
    assert not TAM_QUOC.search(text), "Tam Quoc reference found"


def test_15_element_R79():
    entries = _load()
    bad = [e for e in entries if e["element_primary"] not in ELEMENTS]
    assert not bad


def test_16_seed_deterministic_R68():
    entries = _load()
    bad = [e for e in entries if e["seed"] != f"map:{e['mapId_at_0x00']}"]
    assert not bad, bad[:3]


def test_17_uuid_unique_R8_4():
    entries = _load()
    uuids = [e["uuid"] for e in entries]
    assert len(uuids) == len(set(uuids))


def test_18_npc_density_consistent():
    entries = _load()
    bad = [e for e in entries if e["npc_density_min"] > e["npc_density_max"]]
    assert not bad


def test_19_npc_ids_field_present_R47():
    entries = _load()
    bad = [e for e in entries if "npc_ids" not in e or not isinstance(e["npc_ids"], list)]
    assert not bad, "npc_ids missing or wrong type"


def test_20_quest_giver_ids_field_present_R47():
    entries = _load()
    bad = [e for e in entries
           if "quest_giver_ids" not in e or not isinstance(e["quest_giver_ids"], list)]
    assert not bad, "quest_giver_ids missing or wrong type"


def test_21_npc_cross_ref_consistent_R47():
    """Mọi NPC index trong map.npc_ids đều unique trong cùng map."""
    entries = _load()
    bad = []
    for e in entries:
        ids = e.get("npc_ids", [])
        if len(ids) != len(set(ids)):
            bad.append(e["mapId_at_0x00"])
    assert not bad, bad[:5]


def test_22_some_maps_have_npc_or_quest_R47():
    """Tối thiểu 1000 map có ít nhất 1 NPC (R47 cross-ref hoạt động)."""
    entries = _load()
    with_npc = sum(1 for e in entries if e.get("npc_ids"))
    assert with_npc >= 1000, f"only {with_npc} maps have NPC cross-ref"


def test_23_era_distribution_ly_heaviest_R83():
    """R83 — Trần Long khởi đầu Hoa Lư 968 (Lý) → Lý phải đông nhất, ≥25%."""
    entries = _load()
    from collections import Counter
    c = Counter(e["era"] for e in entries)
    total = sum(c.values())
    ly_pct = 100 * c["ly"] / total
    assert ly_pct >= 25, f"Lý chỉ {ly_pct:.2f}% < 25%"
    # Lý must be top
    most = c.most_common(1)[0][0]
    assert most == "ly", f"Era đông nhất = {most}, không phải ly"


def test_24_biome_realistic_curve_R75():
    """R75 + realistic — capital_inner ≤ 3%, village+plain ≥ 35%."""
    entries = _load()
    from collections import Counter
    c = Counter(e["biome"] for e in entries)
    total = sum(c.values())
    ci = 100 * c["capital_inner"] / total
    vp = 100 * (c["village"] + c["plain"]) / total
    assert ci <= 3, f"capital_inner {ci:.2f}% > 3%"
    assert vp >= 35, f"village+plain {vp:.2f}% < 35%"


def test_25_element_diacritic_R79():
    """R79 — element phải có dấu, match NPC + skill registry."""
    entries = _load()
    diacritic_elements = {"kim", "mộc", "thổ", "thủy", "hỏa", "tâm"}
    bad = [e for e in entries if e["element_primary"] not in diacritic_elements]
    assert not bad, [e["element_primary"] for e in bad[:3]]


def test_26_item_drop_era_pool_field_R74():
    """R74 — item_drop_era_pool field hiện diện, list type."""
    entries = _load()
    bad = [e for e in entries
           if "item_drop_era_pool" not in e or not isinstance(e["item_drop_era_pool"], list)]
    assert not bad


def test_27_dialog_tree_refs_field():
    """dialog_tree_refs hiện diện, list type."""
    entries = _load()
    bad = [e for e in entries
           if "dialog_tree_refs" not in e or not isinstance(e["dialog_tree_refs"], list)]
    assert not bad


def test_28_town_biome_in_pool():
    """R75 — biome 'town' phải có trong pool."""
    entries = _load()
    biomes = {e["biome"] for e in entries}
    assert "town" in biomes


def test_29_width_height_min_to_fit_npc_R75():
    """R75 — width≥320 height≥240 để fit spawn_x ≤ 312, spawn_y ≤ 232."""
    entries = _load()
    bad = [e for e in entries
           if e["width_tiles"] < 320 or e["height_tiles"] < 240]
    assert not bad


def test_30_state_checksum_present_in_config_R68():
    """R68 — state_checksum_sha256 phải có trong gen_config."""
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    cr = cfg.get("cross_ref", {})
    cs = cr.get("state_checksum_sha256")
    assert cs and len(cs) == 64, f"state_checksum invalid: {cs}"
