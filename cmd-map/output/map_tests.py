# CMD_MAP v1.0 — test file ngoài (đọc maps/ + art_profiles/)
import json, sys, hashlib
from pathlib import Path
OUT = Path(__file__).parent
W_FREE, W_BLOCK, W_WATER, W_SLOPE = 0, 1, 2, 3
MIN_WALKABLE_RATIO = 0.25

_CACHE_LAYOUTS = None

def _layouts():
    """Đọc 10000 layout 1 LẦN, cache lại. 23 test dùng chung cache —
    không đọc lại 230.000 file (chống chậm/timeout)."""
    global _CACHE_LAYOUTS
    if _CACHE_LAYOUTS is None:
        _CACHE_LAYOUTS = []
        for d in sorted((OUT / "maps").iterdir()):
            fp = d / "map_layout.json"
            if fp.exists():
                _CACHE_LAYOUTS.append(
                    json.loads(fp.read_text(encoding="utf-8")))
    return _CACHE_LAYOUTS

def _profiles():
    return {p.stem for p in (OUT / "art_profiles").iterdir()
            if p.suffix == ".json"}

def _rle_decode(rle):
    out = []
    for v, c in rle:
        out.extend([v] * c)
    return out

def _is_walk(s):
    return s in (W_FREE, W_SLOPE)

def test_01_layout_count():
    assert sum(1 for _ in _layouts()) == 10000

def test_02_map_id_unique():
    ids = [l["map_id"] for l in _layouts()]
    assert len(ids) == len(set(ids))

def test_03_all_7_fields():
    need = {"map_id", "layout_version", "layout_hash", "natural_key",
            "walk_mask", "portal_points", "anchor_points", "spawn_zones",
            "background"}
    for l in _layouts():
        assert need <= set(l.keys()), f"thiếu field: map {l['map_id']}"

def test_04_walk_mask_size():
    for l in _layouts():
        n = l["grid_w"] * l["grid_h"]
        rle = l["walk_mask"]["data"]
        assert sum(c for _, c in rle) == n, f"walk_mask sai cỡ: {l['map_id']}"

def test_05_walk_mask_states():
    for l in _layouts():
        for v, _ in l["walk_mask"]["data"]:
            assert v in (W_FREE, W_BLOCK, W_WATER, W_SLOPE)

def test_06_no_dead_map():
    for l in _layouts():
        assert l["anchor_points"], f"map chết: {l['map_id']}"

def test_07_all_have_portal():
    for l in _layouts():
        assert l["portal_points"], f"thiếu portal: {l['map_id']}"

def test_08_portal_on_edge():
    for l in _layouts():
        gw, gh = l["grid_w"], l["grid_h"]
        for p in l["portal_points"]:
            x, y = p["tile_x"], p["tile_y"]
            assert (x <= 2 or x >= gw - 3 or y <= 2 or y >= gh - 3),                 f"portal không gần mép: {l['map_id']}"

def test_09_portal_no_overlap():
    for l in _layouts():
        pts = [(p["tile_x"], p["tile_y"]) for p in l["portal_points"]]
        assert len(pts) == len(set(pts)), f"portal trùng ô: {l['map_id']}"

def test_10_anchor_on_walkable():
    for l in _layouts():
        m = _rle_decode(l["walk_mask"]["data"])
        gw = l["grid_w"]
        for a in l["anchor_points"]:
            i = a["tile_y"] * gw + a["tile_x"]
            assert _is_walk(m[i]), f"anchor không walkable: {l['map_id']}"

def test_11_anchor_not_on_portal():
    for l in _layouts():
        pt = {(p["tile_x"], p["tile_y"]) for p in l["portal_points"]}
        for a in l["anchor_points"]:
            assert (a["tile_x"], a["tile_y"]) not in pt,                 f"anchor đè portal: {l['map_id']}"

def test_12_walkable_ratio():
    for l in _layouts():
        m = _rle_decode(l["walk_mask"]["data"])
        ratio = sum(1 for s in m if _is_walk(s)) / len(m)
        assert ratio >= MIN_WALKABLE_RATIO,             f"walkable quá thấp: {l['map_id']}"

def test_13_art_group_has_profile():
    profs = _profiles()
    for l in _layouts():
        ag = l["background"]["art_group"]
        assert ag in profs, f"art_group thiếu profile: {ag}"

def test_14_no_gameplay_logic():
    gp = ("damage", "skill", "drop_rate", "hp", "atk", "monster_id",
          "level", "exp")
    for l in _layouts():
        for k in gp:
            assert k not in l, f"gameplay lẫn layout: {l['map_id']}"

def test_15_spawn_zone_no_gameplay():
    gp = ("monster_id", "level", "level_min", "level_max", "drop",
          "exp", "respawn", "ai", "monster_group")
    for l in _layouts():
        for z in l["spawn_zones"]:
            for k in gp:
                assert k not in z, f"gameplay lẫn spawn_zone: {l['map_id']}"

def test_16_layout_hash_valid():
    for l in _layouts():
        h = l.get("layout_hash")
        tmp = {k: v for k, v in l.items() if k != "layout_hash"}
        calc = hashlib.sha256(json.dumps(tmp, sort_keys=True,
                              ensure_ascii=False).encode()).hexdigest()
        assert h == calc, f"layout_hash sai: {l['map_id']}"

def test_17_spawn_zone_in_bounds():
    for l in _layouts():
        gw, gh = l["grid_w"], l["grid_h"]
        for z in l["spawn_zones"]:
            b = z["bounds"]
            assert b["x"] >= 0 and b["y"] >= 0
            assert b["x"] + b["w"] <= gw and b["y"] + b["h"] <= gh,                 f"spawn_zone vuot grid: {l['map_id']}"

def test_18_has_uuid():
    for l in _layouts():
        assert l.get("uuid"), f"thieu uuid: map {l['map_id']}"

def test_19_safe_zone_no_spawn():
    for l in _layouts():
        if l.get("safe_zone"):
            assert not l["spawn_zones"], f"safe_zone co spawn: {l['map_id']}"

def test_20_spawn_zone_no_overlap():
    for l in _layouts():
        blk = {(p["tile_x"], p["tile_y"]) for p in l["portal_points"]}
        blk |= {(a["tile_x"], a["tile_y"]) for a in l["anchor_points"]}
        for z in l["spawn_zones"]:
            b = z["bounds"]
            for x in range(b["x"], b["x"] + b["w"]):
                for y in range(b["y"], b["y"] + b["h"]):
                    assert (x, y) not in blk, f"spawn de: {l['map_id']}"

def test_21_spawn_zone_walkable():
    for l in _layouts():
        for z in l["spawn_zones"]:
            assert z["walkable_ratio"] >= 0.70, f"walk<0.70: {l['map_id']}"

def test_22_portal_side():
    for l in _layouts():
        for p in l["portal_points"]:
            assert p.get("edge_side") in (0, 1, 2, 3), f"side: {l['map_id']}"

def test_23_grid_4_3():
    for l in _layouts():
        assert l["grid_w"] > l["grid_h"], f"grid ko 4:3: {l['map_id']}"
        assert abs(l["grid_w"] / l["grid_h"] - 4/3) < 0.01, f"ratio: {l['map_id']}"

def test_24_spawn_zone_status():
    for l in _layouts():
        st = l.get("spawn_zone_status")
        assert isinstance(st, dict), f"thieu status: {l['map_id']}"
        assert set(st.keys()) == {"requested", "generated", "reason"}
        assert st["generated"] == len(l["spawn_zones"]),             f"status lech zone: {l['map_id']}"
        assert st["generated"] <= st["requested"], f"gen>req: {l['map_id']}"

if __name__ == "__main__":
    _tests = sorted(n for n in dir() if n.startswith("test_"))
    _p = _f = 0
    for _n in _tests:
        try:
            globals()[_n](); _p += 1; print("  PASS " + _n)
        except Exception as _e:
            _f += 1; print("  FAIL " + _n + ": " + str(_e))
    print(str(_p) + "/" + str(_p + _f) + " tests pass")
    sys.exit(0 if _f == 0 else 1)
