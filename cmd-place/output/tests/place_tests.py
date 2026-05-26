# CMD_PLACE v2.4.0 — 28 tests (determinism kiểm trong self_validate)
import json
from pathlib import Path
REG = Path(__file__).parent.parent / 'registry'

def _maps():
    return [json.loads(l) for l in (REG/'map_registry.jsonl').read_text(encoding='utf-8').splitlines() if l.strip()]

# map THƯỜNG (loại realm than_thoai + start hien_dai/dinh)
_SPECIAL_ERAS = {'than_thoai', 'hien_dai', 'dinh'}
def _world_maps():
    return [m for m in _maps() if m.get('era') not in _SPECIAL_ERAS]
def _realm_maps():
    return [m for m in _maps() if m.get('era') == 'than_thoai']
def _start_maps():
    return [m for m in _maps() if m.get('era') in ('hien_dai', 'dinh')]

def test_01_map_count():
    # tổng = 10000 thường + 100 cõi + 2 start = 10102
    assert len(_maps()) == 10102
    assert len(_world_maps()) == 10000
    assert len(_realm_maps()) == 100
    assert len(_start_maps()) == 2
def test_02_map_id_unique():
    ids=[m['map_id'] for m in _maps()]; assert len(ids)==len(set(ids))
def test_03_map_id_range():
    ids=[m['map_id'] for m in _maps()]; assert min(ids)==1 and max(ids)==10102
def test_04_uuid_unique():
    u=[m['uuid'] for m in _maps()]; assert len(u)==len(set(u))
def test_05_era_valid():
    import sys; sys.path.insert(0, str(Path(__file__).parent))
    from place_lib import ERAS
    valid = set(ERAS) | _SPECIAL_ERAS
    assert all(m['era'] in valid for m in _maps())
def test_06_biome_valid():
    import sys; sys.path.insert(0, str(Path(__file__).parent))
    from place_lib import BIOMES
    realm_b = {'thien_mon','coi_troi','dong_tien','tan_vien_linh_son',
               'long_cung','thien_dai','quy_mon_quan','hoang_tuyen',
               'u_minh_lo','dia_phu_dien','me_cung_u_minh','vong_hon_dai'}
    start_b = {'bao_tang','co_do_hoa_lu'}
    valid = set(BIOMES) | realm_b | start_b
    assert all(m['biome'] in valid for m in _maps())
def test_07_natural_key_unique():
    k=[m['natural_key'] for m in _maps()]; assert len(k)==len(set(k))
def test_08_cultural_lock():
    # Import cultural_lock_ok từ place_lib.py (build script ghi ra cạnh test)
    # — KHÔNG copy logic, KHÔNG drift test vs runtime.
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from place_lib import cultural_lock_ok
    for m in _maps():
        assert cultural_lock_ok(m['name']), f"Vi phạm cultural lock: {m['name']}"

def test_09_shard_range():
    assert all(0<=m['shard_id']<64 for m in _maps())
def test_10_region_count():
    r=[l for l in (REG/'region.jsonl').read_text(encoding='utf-8').splitlines() if l.strip()]
    assert len(r)==64
def test_11_coord_range():
    # max tính từ topology config (1 nguồn) — đúng dù đổi grid width
    import sys; sys.path.insert(0, str(Path(__file__).parent))
    from place_lib import (TARGET_REGION_SHARDS, SHARD_GRID_WIDTH,
                           SHARD_CELL_SIZE, MAP_GRID_WIDTH, MAP_CELL_SIZE)
    maps = _maps()
    max_x = (SHARD_GRID_WIDTH - 1) * SHARD_CELL_SIZE + (MAP_GRID_WIDTH - 1) * MAP_CELL_SIZE
    rows = (TARGET_REGION_SHARDS + SHARD_GRID_WIDTH - 1) // SHARD_GRID_WIDTH
    max_y = (rows - 1) * SHARD_CELL_SIZE + (MAP_GRID_WIDTH - 1) * MAP_CELL_SIZE
    assert all(0 <= m['coord_x'] <= max_x for m in maps)
    assert all(0 <= m['coord_y'] <= max_y for m in maps)
def test_12_f_prefix():
    for m in _maps():
        if m['era'] in ('f1','f2','f3','f4','f5'): assert m['f_prefix']==m['era']
def test_13_tags_present():
    assert all(m.get('tags') for m in _maps())
def test_14_tsref_range():
    assert all(1<=m['tsonline_cross_ref']<=7047 for m in _maps())
def test_15_era_label():
    assert all(m.get('era_label') for m in _maps())
def test_16_purpose_present():
    import sys; sys.path.insert(0, str(Path(__file__).parent))
    maps = _maps()
    assert all(m.get('purpose') for m in maps), "map thiếu purpose"
    valid = {'combat','gathering','fishing','farming','crafting','trade',
             'exploration','social','lore','archeology'}
    for m in maps:
        assert all(p in valid for p in m['purpose']), f"purpose lạ: {m['map_id']}"
def test_17_anchors_present():
    maps = _maps()
    assert all(m.get('anchors') for m in maps), "map thiếu anchors"
    cap = {'npc_anchor':12,'resource_anchor':8,'activity_anchor':5,
           'quest_anchor':4,'portal_anchor':4,'boss_anchor':2}
    for m in maps:
        for at, items in m['anchors'].items():
            assert len(items) <= cap.get(at, 0), f"anchor vượt cap: {m['map_id']} {at}"
def test_18_topology_version():
    assert all(m.get('topology_version') == 1 for m in _maps())
def test_19_g1_flag():
    assert all('g1_pass' in m and 'g1_note' in m for m in _maps())
def test_20_style_present():
    assert all(m.get('style') for m in _maps())
def test_21_spatial_present():
    assert all('chunk_x' in m and 'safe_zone' in m and 'nav_region' in m
               for m in _maps())
def test_22_terrain_present():
    assert all(m.get('terrain') for m in _maps())
def test_23_portal_graph_valid():
    maps = _maps()
    ids = set(m['map_id'] for m in maps)
    by_id = {m['map_id']: m for m in maps}
    for m in maps:
        seen = set()
        for lk in m.get('portal_graph', []):
            to_map = lk.get('to_map')
            assert to_map in ids, f"to_map không có thật: {m['map_id']}"
            assert lk.get('from_map') == m['map_id'], f"from_map sai: {m['map_id']}"
            assert to_map != m['map_id'], f"self-loop: {m['map_id']}"
            assert to_map not in seen, f"duplicate edge: {m['map_id']}"
            seen.add(to_map)
            if lk.get('bidirectional'):
                back = by_id[to_map].get('portal_graph', [])
                assert any(b.get('to_map') == m['map_id'] for b in back),                     f"bidirectional giả: {m['map_id']}->{to_map}"
def test_24_world_connected():
    # strongly-connected: CHỈ map thường (realm + start tách rời, vào
    # bằng chuyển sinh/cốt truyện — không có cổng địa lý liên thông).
    maps = _world_maps()
    world_ids = set(m['map_id'] for m in maps)
    fwd = {m['map_id']: [] for m in maps}
    rev = {m['map_id']: [] for m in maps}
    for m in maps:
        for lk in m.get('portal_graph', []):
            to = lk['to_map']
            if to not in world_ids:      # bỏ cạnh trỏ ra realm/start
                continue
            fwd[m['map_id']].append(to)
            rev[to].append(m['map_id'])
    def _reach(adj, start):
        seen = {start}; stack = [start]
        while stack:
            cur = stack.pop()
            for nxt in adj.get(cur, []):
                if nxt not in seen:
                    seen.add(nxt); stack.append(nxt)
        return seen
    start = maps[0]['map_id']
    assert len(_reach(fwd, start)) == len(maps), "forward BFS không phủ đủ"
    assert len(_reach(rev, start)) == len(maps), "reverse BFS không phủ đủ"
def test_25_spawn_policy_fields():
    # spawn_policy đủ 4 field, không thiếu không thừa
    need = {'allow_monster_spawn', 'spawn_profile',
            'density_hint', 'zone_count_hint'}
    for m in _maps():
        sp = m.get('spawn_policy')
        assert isinstance(sp, dict), f"spawn_policy thiếu: map {m['map_id']}"
        assert set(sp.keys()) == need, f"spawn_policy sai field: {m['map_id']}"
def test_26_spawn_policy_no_gameplay():
    # spawn_policy KHÔNG được chứa gameplay thật (việc CMD_NPC)
    gp = ('monster_id', 'level', 'drop', 'exp',
          'respawn_time', 'ai_behavior', 'skill')
    for m in _maps():
        sp = m['spawn_policy']
        for k in gp:
            assert k not in sp, f"spawn_policy lẫn gameplay '{k}': {m['map_id']}"
def test_27_spawn_policy_consistent():
    # allow=True -> zone_count > 0; allow=False -> zone_count == 0
    for m in _maps():
        sp = m['spawn_policy']
        if sp['allow_monster_spawn']:
            assert sp['zone_count_hint'] > 0,                 f"allow=True nhưng zone=0: map {m['map_id']}"
        else:
            assert sp['zone_count_hint'] == 0,                 f"allow=False nhưng zone>0: map {m['map_id']}"
def test_28_safe_zone_no_spawn():
    # safe_zone TUYỆT ĐỐI không quái
    for m in _maps():
        if m['safe_zone']:
            assert not m['spawn_policy']['allow_monster_spawn'],                 f"safe_zone vẫn có quái: map {m['map_id']}"

if __name__ == "__main__":
    import traceback, sys
    _tests = sorted(n for n in dir() if n.startswith("test_"))
    _p = _f = 0
    for _n in _tests:
        try:
            globals()[_n](); _p += 1; print("  PASS " + _n)
        except Exception as _e:
            _f += 1; print("  FAIL " + _n + ": " + str(_e))
    print(str(_p) + "/" + str(_p + _f) + " tests pass")
    sys.exit(0 if _f == 0 else 1)
