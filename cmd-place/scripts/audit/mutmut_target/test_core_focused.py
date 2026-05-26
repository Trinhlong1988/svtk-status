"""Tests cho cmd_place_core.py — exhaustive cover 5 function core."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import cmd_place_core as c


# ─── seeded_int ──────────────────────────────────────────────────────────
def test_seeded_int_determ():
    assert c.seeded_int('s', 0, 10) == c.seeded_int('s', 0, 10)

def test_seeded_int_range_5_10():
    for s in ('a','b','c','d','e','f','g','h','i','j'):
        v = c.seeded_int(s, 5, 10)
        assert 5 <= v <= 10, f"out of range: {v}"

def test_seeded_int_exact_known():
    # sha256('cmd_place_v2') hex int % 1000
    import hashlib
    h = int(hashlib.sha256(b'cmd_place_v2').hexdigest(), 16) % 1000
    assert c.seeded_int('cmd_place_v2', 0, 999) == h

def test_seeded_int_lo_eq_hi():
    assert c.seeded_int('any', 5, 5) == 5

def test_seeded_int_different_seeds_differ():
    # Most pairs different (probabilistic but ~certain)
    vals = {c.seeded_int(f's{i}', 0, 999) for i in range(20)}
    assert len(vals) > 15  # ~all distinct

def test_seeded_int_range_inclusive():
    # Hits both lo and hi over many seeds
    vals = {c.seeded_int(f's{i}', 0, 3) for i in range(200)}
    assert 0 in vals and 3 in vals

# ─── seeded_pick ──────────────────────────────────────────────────────────
def test_seeded_pick_returns_in_opts():
    opts = ['x','y','z','w']
    for s in ('a','b','c'):
        assert c.seeded_pick(s, opts) in opts

def test_seeded_pick_determ():
    opts = list('abcdef')
    assert c.seeded_pick('s', opts) == c.seeded_pick('s', opts)

def test_seeded_pick_uses_full_range():
    opts = list('abcdefgh')
    seen = {c.seeded_pick(f's{i}', opts) for i in range(200)}
    # Should hit most options
    assert len(seen) >= 6

# ─── g1_check ──────────────────────────────────────────────────────────
def test_g1_clean():
    ok, n = c.g1_check('Văn Lang Đại Việt')
    assert ok and n == ''

def test_g1_cam_casino():
    ok, n = c.g1_check('Khu casino Royal')
    assert not ok and 'casino' in n.lower()

def test_g1_cam_drug():
    ok, n = c.g1_check('Vùng ma túy')
    assert not ok

def test_g1_cam_uppercase():
    ok, _ = c.g1_check('CASINO TEST')
    assert not ok

def test_g1_ip():
    ok, n = c.g1_check('Thiên Long Bát Bộ')
    assert not ok and 'IP' in n

def test_g1_ip_pokemon():
    ok, _ = c.g1_check('Vùng Pokemon')
    assert not ok

def test_g1_nhay_cam_hoangsa():
    ok, n = c.g1_check('Quần đảo Hoàng Sa')
    assert ok and 'Việt Nam' in n

def test_g1_nhay_cam_truongsa():
    ok, n = c.g1_check('Đảo Trường Sa')
    assert ok and 'Việt Nam' in n

def test_g1_nhay_cam_namquan():
    ok, n = c.g1_check('Ải Nam Quan xưa')
    assert ok and 'phong kiến' in n

def test_g1_empty():
    ok, n = c.g1_check('')
    assert ok and n == ''

# ─── cultural_lock_ok ──────────────────────────────────────────────────────
def test_cult_clean():
    assert c.cultural_lock_ok('Hà Nội phồn hoa')

def test_cult_kana():
    assert not c.cultural_lock_ok('Test カタカナ')
    assert not c.cultural_lock_ok('Test ひらがな')

def test_cult_tam_quoc_viet():
    assert not c.cultural_lock_ok('Tào Tháo lừng danh')
    assert not c.cultural_lock_ok('Lưu Bị huyền đức')
    assert not c.cultural_lock_ok('Quan Vũ trung dũng')

def test_cult_tam_quoc_chinese():
    assert not c.cultural_lock_ok('Truyện 曹操')

def test_cult_modern_sensitive():
    assert not c.cultural_lock_ok('Vùng nội chiến')
    assert not c.cultural_lock_ok('Khu cải cách ruộng đất')
    assert not c.cultural_lock_ok('Vùng chiến tranh biên giới')

def test_cult_chinese_han_viet_ok():
    # Han characters that are NOT Tam Quoc should pass
    assert c.cultural_lock_ok('Văn Miếu')

# ─── _portal_graph_valid ──────────────────────────────────────────────────
def test_portal_valid_2map():
    maps = [
        {'map_id': 1, 'portal_graph': [{'from_map':1,'to_map':2,'bidirectional':True}]},
        {'map_id': 2, 'portal_graph': [{'from_map':2,'to_map':1,'bidirectional':True}]},
    ]
    assert c._portal_graph_valid(maps)

def test_portal_dangling():
    maps = [{'map_id': 1, 'portal_graph': [{'from_map':1,'to_map':99,'bidirectional':True}]}]
    assert not c._portal_graph_valid(maps)

def test_portal_self_loop():
    maps = [{'map_id': 1, 'portal_graph': [{'from_map':1,'to_map':1,'bidirectional':True}]}]
    assert not c._portal_graph_valid(maps)

def test_portal_wrong_from():
    maps = [
        {'map_id': 1, 'portal_graph': [{'from_map':99,'to_map':2,'bidirectional':True}]},
        {'map_id': 2, 'portal_graph': []},
    ]
    assert not c._portal_graph_valid(maps)

def test_portal_bidir_no_back():
    maps = [
        {'map_id': 1, 'portal_graph': [{'from_map':1,'to_map':2,'bidirectional':True}]},
        {'map_id': 2, 'portal_graph': []},
    ]
    assert not c._portal_graph_valid(maps)

def test_portal_duplicate_edge():
    maps = [
        {'map_id': 1, 'portal_graph': [
            {'from_map':1,'to_map':2,'bidirectional':True},
            {'from_map':1,'to_map':2,'bidirectional':True},
        ]},
        {'map_id': 2, 'portal_graph': [{'from_map':2,'to_map':1,'bidirectional':True}]},
    ]
    assert not c._portal_graph_valid(maps)

def test_portal_empty_ok():
    maps = [{'map_id': 1, 'portal_graph': []}]
    assert c._portal_graph_valid(maps)

# ─── _world_connected ──────────────────────────────────────────────────────
def test_world_2map_connected():
    maps = [
        {'map_id': 1, 'portal_graph': [{'from_map':1,'to_map':2,'bidirectional':True}]},
        {'map_id': 2, 'portal_graph': [{'from_map':2,'to_map':1,'bidirectional':True}]},
    ]
    assert c._world_connected(maps)

def test_world_disconnected():
    maps = [
        {'map_id': 1, 'portal_graph': []},
        {'map_id': 2, 'portal_graph': []},
    ]
    assert not c._world_connected(maps)

def test_world_empty():
    assert not c._world_connected([])

def test_world_one_way():
    maps = [
        {'map_id': 1, 'portal_graph': [{'from_map':1,'to_map':2,'bidirectional':True}]},
        {'map_id': 2, 'portal_graph': []},
    ]
    assert not c._world_connected(maps)

def test_world_3map_chain():
    # 1↔2↔3 strongly connected
    maps = [
        {'map_id': 1, 'portal_graph': [{'from_map':1,'to_map':2,'bidirectional':True}]},
        {'map_id': 2, 'portal_graph': [
            {'from_map':2,'to_map':1,'bidirectional':True},
            {'from_map':2,'to_map':3,'bidirectional':True},
        ]},
        {'map_id': 3, 'portal_graph': [{'from_map':3,'to_map':2,'bidirectional':True}]},
    ]
    assert c._world_connected(maps)

def test_world_single_map_isolated():
    maps = [{'map_id': 1, 'portal_graph': []}]
    # forward reach 1, rev reach 1 → len 1 == len(maps) 1 → True
    assert c._world_connected(maps)

def test_world_dangling_returns_false():
    maps = [{'map_id': 1, 'portal_graph': [{'from_map':1,'to_map':99,'bidirectional':True}]}]
    assert not c._world_connected(maps)
