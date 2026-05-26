"""Pytest test suite cho mutmut — kill mutation trong 5 function core.

Mục tiêu: mỗi assert ĐỦ chính xác để mutate code = test fail.
KHÔNG test invariant chung chung (mutation né được). Test giá trị cụ thể.
"""
import sys, os, importlib.util
from pathlib import Path

HERE = Path(__file__).resolve()
ROOT = HERE.parents[1]  # cmd-place/scripts/audit
SCRIPT = ROOT.parent / 'cmd_place.py'  # cmd-place/scripts/cmd_place.py
WORK = HERE.parent / 'work_mutmut'
WORK.mkdir(exist_ok=True)
REPO_DIR = HERE.parents[4]  # cmd-place/scripts/audit/mutmut_target -> repo root

_cached_mod = None
def mod():
    global _cached_mod
    if _cached_mod is None:
        spec = importlib.util.spec_from_file_location("cp_test", str(SCRIPT))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        m.REPO_DIR = REPO_DIR
        m.OUTPUT_DIR = WORK
        m.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        m.verify_foundation()
        m.cultural_lock_ok = m.ensure_place_lib()
        _cached_mod = m
    return _cached_mod

# ─── seeded_int ─────────────────────────────────────────────────────────────
# Deterministic, exact value
def test_seeded_int_deterministic():
    m = mod()
    a = m.seeded_int('test_seed', 0, 100)
    b = m.seeded_int('test_seed', 0, 100)
    assert a == b, f"Non-deterministic: {a} != {b}"

def test_seeded_int_range():
    m = mod()
    for seed in ('s1', 's2', 's3', 's4', 's5'):
        v = m.seeded_int(seed, 10, 20)
        assert 10 <= v <= 20, f"out of range: {v}"

def test_seeded_int_exact_value():
    # Specific value — mutate hash logic = different value
    m = mod()
    v = m.seeded_int('cmd_place_v2', 0, 999)
    # Expected based on sha256('cmd_place_v2') % 1000
    import hashlib
    expected = int(hashlib.sha256('cmd_place_v2'.encode()).hexdigest(), 16) % 1000
    assert v == expected, f"got {v} expected {expected}"

def test_seeded_int_boundary_lo():
    m = mod()
    # When lo == hi, result must be lo
    assert m.seeded_int('x', 5, 5) == 5

def test_seeded_int_negative_safe():
    m = mod()
    v = m.seeded_int('xyz', -10, 10)
    assert -10 <= v <= 10

# ─── seeded_pick ────────────────────────────────────────────────────────────
def test_seeded_pick_deterministic():
    m = mod()
    opts = ['a', 'b', 'c', 'd', 'e']
    a = m.seeded_pick('seed', opts)
    b = m.seeded_pick('seed', opts)
    assert a == b

def test_seeded_pick_in_options():
    m = mod()
    opts = list('abcdefgh')
    for s in ('s1', 's2', 's3', 's4', 's5'):
        v = m.seeded_pick(s, opts)
        assert v in opts

# ─── g1_check ──────────────────────────────────────────────────────────────
def test_g1_clean_pass():
    m = mod()
    ok, note = m.g1_check('Văn Lang Đại Việt')
    assert ok is True
    assert note == ''

def test_g1_cam_fail():
    m = mod()
    ok, note = m.g1_check('Casino Royale Hà Nội')
    assert ok is False
    assert 'casino' in note.lower()

def test_g1_ip_fail():
    m = mod()
    ok, note = m.g1_check('Thiên Long Bát Bộ')
    assert ok is False
    assert 'IP' in note

def test_g1_nhay_cam_pass_with_note():
    m = mod()
    ok, note = m.g1_check('Hoàng Sa Quần Đảo')
    assert ok is True
    assert 'Việt Nam' in note

def test_g1_case_insensitive():
    m = mod()
    ok, _ = m.g1_check('CASINO Test')
    assert ok is False
    ok2, _ = m.g1_check('CaSiNo Test')
    assert ok2 is False

# ─── cultural_lock_ok (từ place_lib) ───────────────────────────────────────
def test_cultural_lock_clean():
    m = mod()
    assert m.cultural_lock_ok('Hà Nội Đại Việt') is True

def test_cultural_lock_japanese_kana():
    m = mod()
    assert m.cultural_lock_ok('Test カタカナ') is False
    assert m.cultural_lock_ok('Test ひらがな') is False

def test_cultural_lock_tam_quoc():
    m = mod()
    assert m.cultural_lock_ok('Tào Tháo xâm lược') is False
    assert m.cultural_lock_ok('Lưu Bị nhà Hán') is False

def test_cultural_lock_modern_sensitive():
    m = mod()
    assert m.cultural_lock_ok('Vùng nội chiến') is False
    assert m.cultural_lock_ok('Khu cải cách ruộng đất') is False

# ─── _portal_graph_valid ───────────────────────────────────────────────────
def test_portal_valid_normal():
    m = mod()
    maps = [
        {'map_id': 1, 'portal_graph': [{'from_map':1,'to_map':2,'bidirectional':True}]},
        {'map_id': 2, 'portal_graph': [{'from_map':2,'to_map':1,'bidirectional':True}]},
    ]
    assert m._portal_graph_valid(maps) is True

def test_portal_invalid_dangling():
    m = mod()
    maps = [{'map_id': 1, 'portal_graph': [{'from_map':1,'to_map':99,'bidirectional':True}]}]
    assert m._portal_graph_valid(maps) is False

def test_portal_invalid_self_loop():
    m = mod()
    maps = [{'map_id': 1, 'portal_graph': [{'from_map':1,'to_map':1,'bidirectional':True}]}]
    assert m._portal_graph_valid(maps) is False

def test_portal_invalid_wrong_from():
    m = mod()
    maps = [
        {'map_id': 1, 'portal_graph': [{'from_map':99,'to_map':2,'bidirectional':True}]},
        {'map_id': 2, 'portal_graph': []},
    ]
    assert m._portal_graph_valid(maps) is False

def test_portal_invalid_bidirectional_broken():
    m = mod()
    maps = [
        {'map_id': 1, 'portal_graph': [{'from_map':1,'to_map':2,'bidirectional':True}]},
        {'map_id': 2, 'portal_graph': []},  # no back link
    ]
    assert m._portal_graph_valid(maps) is False

# ─── _world_connected ──────────────────────────────────────────────────────
def test_world_connected_2map():
    m = mod()
    maps = [
        {'map_id': 1, 'portal_graph': [{'from_map':1,'to_map':2,'bidirectional':True}]},
        {'map_id': 2, 'portal_graph': [{'from_map':2,'to_map':1,'bidirectional':True}]},
    ]
    assert m._world_connected(maps) is True

def test_world_connected_disconnected():
    m = mod()
    maps = [
        {'map_id': 1, 'portal_graph': []},
        {'map_id': 2, 'portal_graph': []},
    ]
    assert m._world_connected(maps) is False

def test_world_connected_one_way():
    m = mod()
    maps = [
        {'map_id': 1, 'portal_graph': [{'from_map':1,'to_map':2,'bidirectional':True}]},
        {'map_id': 2, 'portal_graph': []},  # 1→2 only, no 2→1 in rev
    ]
    # forward BFS từ 1: tới 2 (1+2). rev BFS từ 1: rev[1]=[], rev[2]=[1] → start=1 chỉ tới 1.
    assert m._world_connected(maps) is False

def test_world_connected_empty():
    m = mod()
    assert m._world_connected([]) is False

# ─── build_regions topology consistency ────────────────────────────────────
def test_build_regions_count():
    m = mod()
    rs = m.build_regions(force_regen=True)
    assert len(rs) == 64

def test_build_regions_zone_split():
    m = mod()
    rs = m.build_regions(force_regen=True)
    bac = sum(1 for r in rs if r['zone'] == 'bac_bo')
    trung = sum(1 for r in rs if r['zone'] == 'trung_bo')
    nam = sum(1 for r in rs if r['zone'] == 'nam_bo')
    assert bac == 24
    assert trung == 22
    assert nam == 18

def test_build_regions_tier_dist():
    m = mod()
    rs = m.build_regions(force_regen=True)
    from collections import Counter as _C
    c = _C(r['tier'] for r in rs)
    assert c[1] == 8
    assert c[2] == 14
    assert c[3] == 20
    assert c[4] == 14
    assert c[5] == 8

def test_build_regions_quota_sum():
    m = mod()
    rs = m.build_regions(force_regen=True)
    total = sum(r['expected_map_count'] for r in rs)
    assert total == m.TARGET_MAP_COUNT

# ─── build_anchors invariant ───────────────────────────────────────────────
def test_build_anchors_no_exceed_cap():
    m = mod()
    for tier in (1, 3, 5):
        for biome in ('forest', 'cave', 'capital', 'battlefield'):
            a = m.build_anchors('test_seed', biome, tier, 1)
            for atype, items in a.items():
                assert len(items) <= m.ANCHOR_CAP[atype]

def test_build_anchors_deterministic():
    m = mod()
    a = m.build_anchors('seed_x', 'forest', 3, 100)
    b = m.build_anchors('seed_x', 'forest', 3, 100)
    assert a == b

def test_build_anchors_combat_high_tier_has_boss():
    m = mod()
    # battlefield purpose includes 'combat', tier=5 → should have boss_anchor
    a = m.build_anchors('s', 'battlefield', 5, 1)
    assert 'boss_anchor' in a

def test_build_anchors_capital_no_boss():
    m = mod()
    # capital purpose = social/trade/lore/exploration, không có combat → no boss
    a = m.build_anchors('s', 'capital', 5, 1)
    assert 'boss_anchor' not in a
