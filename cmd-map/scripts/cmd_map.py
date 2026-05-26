#!/usr/bin/env python3
"""CMD_MAP v1.1.0 — autonomous builder. Sinh DỮ LIỆU layout từng map.
CMD_MAP = xương map (layout + collision + walkable + portal + anchor
position + art_group). KHÔNG sinh ảnh, KHÔNG kiểm ảnh, KHÔNG gameplay
logic. Đọc map_registry.jsonl của CMD_PLACE, sinh map_layout.json."""
import os, sys, json, time, hashlib, subprocess, signal, re, logging, shutil
from pathlib import Path

# ── 1 NGUỒN — version sửa đúng 1 chỗ ──
CMD_VERSION = "1.1.0"
# v1.1.0 (2026-05-26): hỗ trợ CMD_PLACE v2.4.0 — đọc 10102 map
# (10000 thường + 100 cõi + 2 start). Thêm 14 biome mới (12 sub-realm
# cõi + 2 map start). realm gate/hub + start map: spawn_policy
# allow=False -> tự KHÔNG sinh spawn_zone. 10000 map thường không đổi.
CMD_NAME = "MAP"
FOUNDATION_HASH = "cc194e6cad2225d197c4a5539352deb538c99cdd6a21845a8354260602287bbb"
FOUNDATION_FILE = "SVTK_FOUNDATION_v2.10.0.md"
# LAYOUT_VERSION — khóa cấu trúc layout. Đổi = sinh lại toàn bộ map.
LAYOUT_VERSION = 1

REPO_URL = os.getenv('SVTK_REPO_URL',
                     "https://github.com/Trinhlong1988/svtk-status.git")
REPO_DIR = Path(os.getenv('SVTK_REPO_DIR', "/tmp/svtk-status"))
OUTPUT_DIR = Path(f"/tmp/cmd-{CMD_NAME.lower()}-output")
GIT_EMAIL = os.getenv('GIT_EMAIL', "cmd-map@svtk.local")
MAX_PUSH_ATTEMPTS = 3
RETRY_DELAY_SEC = 5
SCORE_THRESHOLD = 0.95
LOOP_INTERVAL_SEC = 60
LOCK_STALE_SEC = int(os.getenv('SVTK_LOCK_STALE_SEC', '180'))
LOCK_HEARTBEAT_SEC = int(os.getenv('SVTK_LOCK_HEARTBEAT_SEC', '20'))

TARGET_MAP_COUNT = 10000     # map THƯỜNG — khớp place_meta.target_map_count
# TOTAL_MAP_COUNT = thường (10000) + cõi (100) + start (2) = 10102.
# CMD_PLACE v2.4.0 ghi target_map_count=10000 trong manifest (số map
# thường) NHƯNG file map_registry.jsonl có 10102 dòng. CMD_MAP đọc
# đủ 10102, chỉ dùng TARGET_MAP_COUNT để verify khớp manifest.
TOTAL_MAP_COUNT = 10102
TARGET_REGION_SHARDS = 64    # khớp CMD_PLACE — verify cross-CMD contract
SCHEMA_VERSION = f'map-v{CMD_VERSION}'

# ── Grid map — kích thước tile theo tier, tỉ lệ 4:3 (như màn hình) ──
# Tile 32px. TS Online map ~832x640px = 4:3. SVTK map tile-based cùng
# tỉ lệ: (rộng, cao). tier cao rộng hơn. KHÔNG dùng grid vuông.
GRID_BY_TIER = {
    1: (32, 24), 2: (40, 30), 3: (48, 36), 4: (56, 42), 5: (64, 48),
}

# ── 22 biome thường + 14 biome đặc biệt — ĐỒNG BỘ với CMD_PLACE v2.4.0 ──
BIOMES = [
    # 22 biome thường (map lịch sử trần gian)
    'forest', 'mountain', 'river', 'plain', 'sea', 'swamp',
    'craft_village', 'rice_field', 'fishing_village', 'salt_field',
    'plantation', 'wharf', 'capital', 'capital_inner', 'town',
    'village', 'citadel', 'frontier_pass', 'battlefield', 'cave',
    'scenic', 'garden',
]
# 12 biome cõi (6 Tiên Giới + 6 Âm Phủ) — CMD_PLACE realm
REALM_BIOMES = [
    'thien_mon', 'coi_troi', 'dong_tien',
    'tan_vien_linh_son', 'long_cung', 'thien_dai',
    'quy_mon_quan', 'hoang_tuyen', 'u_minh_lo',
    'dia_phu_dien', 'me_cung_u_minh', 'vong_hon_dai',
]
# 2 biome map start cốt truyện
START_BIOMES = ['bao_tang', 'co_do_hoa_lu']
# danh sách đầy đủ — biome nào CMD_PLACE sinh thì CMD_MAP phải nhận
ALL_BIOMES = BIOMES + REALM_BIOMES + START_BIOMES
# ── NAVAL_BIOMES — biome THỦY CHIẾN: quái spawn TRÊN MẶT NƯỚC ──
# Map nhiều nước: Long Cung (cõi thủy), Hoàng Tuyền (sông Nại Hà —
# hồn lội bến), sea/river/swamp trần gian. Với các biome này,
# spawn_zone tính ô WATER là spawnable, KHÔNG chỉ tính ô đất — nếu
# không map toàn nước sẽ ra 0 zone. Map đất thường giữ nguyên.
NAVAL_BIOMES = {'long_cung', 'hoang_tuyen', 'sea', 'river', 'swamp'}
ERAS = ['ly', 'tran', 'le', 'tay_son', 'nguyen',
        'f1', 'f2', 'f3', 'f4', 'f5']
# era đặc biệt — realm + start (CMD_MAP chỉ cần nhận, không xử riêng)
SPECIAL_ERAS = ['than_thoai', 'hien_dai', 'dinh']

# ── BIOME TERRAIN — tỉ lệ ô walk_mask theo biome (0-100) ──
# water: % ô nước. block: % ô cản (vật cản/công trình). slope: % ô dốc.
# Còn lại = ô đi được tự do. CMD_MAP chỉ sinh hình học walk_mask;
# ảnh đẹp (nhà, cây, đèn) là việc LoRA qua art_group.
BIOME_TERRAIN = {
    'forest':          {'water': 6,  'block': 26, 'slope': 14},
    'mountain':        {'water': 3,  'block': 14, 'slope': 46},
    'river':           {'water': 52, 'block': 8,  'slope': 6},
    'plain':           {'water': 5,  'block': 10, 'slope': 6},
    'sea':             {'water': 74, 'block': 4,  'slope': 2},
    'swamp':           {'water': 42, 'block': 14, 'slope': 8},
    'craft_village':   {'water': 6,  'block': 30, 'slope': 4},
    'rice_field':      {'water': 28, 'block': 12, 'slope': 4},
    'fishing_village': {'water': 32, 'block': 22, 'slope': 4},
    'salt_field':      {'water': 26, 'block': 10, 'slope': 3},
    'plantation':      {'water': 6,  'block': 22, 'slope': 10},
    'wharf':           {'water': 36, 'block': 24, 'slope': 4},
    'capital':         {'water': 6,  'block': 32, 'slope': 4},
    'capital_inner':   {'water': 4,  'block': 38, 'slope': 3},
    'town':            {'water': 6,  'block': 28, 'slope': 5},
    'village':         {'water': 8,  'block': 24, 'slope': 6},
    'citadel':         {'water': 5,  'block': 34, 'slope': 8},
    'frontier_pass':   {'water': 4,  'block': 18, 'slope': 32},
    'battlefield':     {'water': 6,  'block': 18, 'slope': 14},
    'cave':            {'water': 10, 'block': 34, 'slope': 18},
    'scenic':          {'water': 20, 'block': 20, 'slope': 16},
    'garden':          {'water': 16, 'block': 26, 'slope': 8},
    # ── 12 biome cõi (khớp REALM_TERRAIN CMD_PLACE) ──
    # Tiên Giới — sáng, ít cản, đường rõ (readability DNA TS Online)
    'thien_mon':         {'water': 4,  'block': 14, 'slope': 8},
    'coi_troi':          {'water': 4,  'block': 16, 'slope': 10},
    'dong_tien':         {'water': 12, 'block': 30, 'slope': 22},
    'tan_vien_linh_son': {'water': 8,  'block': 18, 'slope': 44},
    'long_cung':         {'water': 70, 'block': 12, 'slope': 6},
    'thien_dai':         {'water': 4,  'block': 16, 'slope': 12},
    # Âm Phủ — tối, vẫn giữ đường đi rõ
    'quy_mon_quan':      {'water': 8,  'block': 24, 'slope': 16},
    'hoang_tuyen':       {'water': 44, 'block': 14, 'slope': 8},
    'u_minh_lo':         {'water': 22, 'block': 28, 'slope': 18},
    'dia_phu_dien':      {'water': 8,  'block': 26, 'slope': 8},
    'me_cung_u_minh':    {'water': 18, 'block': 38, 'slope': 20},
    'vong_hon_dai':      {'water': 12, 'block': 20, 'slope': 14},
    # ── 2 biome map start — an toàn, ít cản, dễ đi ──
    'bao_tang':          {'water': 2,  'block': 20, 'slope': 4},
    'co_do_hoa_lu':      {'water': 8,  'block': 24, 'slope': 6},
}

# Tile code trong layer (số nguyên — RLE nén tốt)
# ── WALK MASK — 1 lớp, đúng TS Online Ground.MMG ──
# Mỗi ô 1 trong 4 trạng thái. Đây là DỮ LIỆU hình học, KHÔNG gameplay.
WALK_FREE = 0    # đi được (đất, đường)
WALK_BLOCK = 1   # cản (tường, công trình, vật cản)
WALK_WATER = 2   # nước (cản với người, dùng cho thuyền sau này)
WALK_SLOPE = 3   # dốc (đi được nhưng chậm — núi, đồi)

# Tỉ lệ ô đi được tối thiểu mỗi map — map nhiều nước (sea/river) vẫn
# phải chơi được. Dưới ngưỡng -> đục thêm đường/cầu (điều 2).
MIN_WALKABLE_RATIO = 0.25


UUID_NS_SEED = '7c3e9f2a1b8d4e6f5a0c9b8d7e6f5a4b'

log = logging.getLogger(CMD_NAME)
logging.basicConfig(level=logging.INFO, format='[%(name)s] %(message)s')

# Flag set bởi verify_foundation() — KHÔNG hardcode
FOUNDATION_VERIFIED = False


# ── seeded RNG (R68 — deterministic, KHÔNG random) ──
def seeded_int(seed_str, lo, hi):
    """Deterministic int từ seed — sha256, KHÔNG dùng hash()."""
    h = int(hashlib.sha256(seed_str.encode()).hexdigest(), 16)
    return lo + (h % (hi - lo + 1))


def _compute_build_rule_hash():
    """Hash ĐỦ mọi bảng logic CMD_MAP dùng (rà ast). Đổi mà quên bump
    version -> cache layout cũ bị từ chối reuse."""
    blob = json.dumps({
        'grid_by_tier': GRID_BY_TIER,
        'biome_terrain': BIOME_TERRAIN,
        'biomes': BIOMES,
        'realm_biomes': REALM_BIOMES,
        'start_biomes': START_BIOMES,
        'eras': ERAS,
        'special_eras': SPECIAL_ERAS,
        'layout_version': LAYOUT_VERSION,
        'target_map_count': TARGET_MAP_COUNT,
        'total_map_count': TOTAL_MAP_COUNT,
        'walk_states': [WALK_FREE, WALK_BLOCK, WALK_WATER, WALK_SLOPE],
        'min_walkable_ratio': MIN_WALKABLE_RATIO,
        'uuid_ns_seed': UUID_NS_SEED,
    }, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()
BUILD_RULE_HASH = _compute_build_rule_hash()


# ── Foundation verify ──
def _ensure_repo():
    """Đảm bảo REPO_DIR có sẵn + đồng bộ origin/main.
    - chưa tồn tại  -> git clone --depth=1 REPO_URL REPO_DIR
    - đã tồn tại    -> git fetch origin + reset --hard origin/main
    Mọi lỗi git (CalledProcessError/TimeoutExpired/OSError) -> log
    sạch, trả False. KHÔNG crash bot."""
    try:
        if not REPO_DIR.exists():
            log.info(f"Repo chưa có — clone {REPO_URL}")
            ok, out = _run_git(
                ['clone', '--depth=1', REPO_URL, str(REPO_DIR)],
                Path('/tmp'))
            if not ok:
                log.error(f"git clone lỗi: {out.strip()[:200]}")
                return False
        else:
            ok, out = _run_git(['fetch', 'origin'], REPO_DIR)
            if not ok:
                log.error(f"git fetch lỗi: {out.strip()[:200]}")
                return False
            ok, out = _run_git(
                ['reset', '--hard', 'origin/main'], REPO_DIR)
            if not ok:
                log.error(f"git reset lỗi: {out.strip()[:200]}")
                return False
        return True
    except (subprocess.CalledProcessError,
            subprocess.TimeoutExpired, OSError) as e:
        log.error(f"git thao tác repo lỗi: {e}")
        return False


def verify_foundation():
    """Đồng bộ repo (clone/fetch/reset) rồi verify SVTK_FOUNDATION
    hash khớp — chung mọi CMD. Set flag."""
    global FOUNDATION_VERIFIED
    if not _ensure_repo():
        log.error("Không đồng bộ được repo — DỪNG")
        return False
    fp = REPO_DIR / 'foundation' / FOUNDATION_FILE
    if not fp.exists():
        log.error(f"Không tìm thấy {FOUNDATION_FILE}")
        return False
    h = hashlib.sha256(fp.read_bytes()).hexdigest()
    if h != FOUNDATION_HASH:
        log.error(f"Foundation hash sai: {h[:16]} != {FOUNDATION_HASH[:16]}")
        return False
    FOUNDATION_VERIFIED = True
    return True


# ── CROSS-CMD CONTRACT — verify input CMD_PLACE (điều 2) ──
def load_place_registry():
    """Đọc map_registry.jsonl + meta của CMD_PLACE. Verify CHẶT input —
    lệch bất kỳ -> trả None (DỪNG, không build từ data sai/không rõ
    nguồn):
    (a) foundation_hash khớp — cùng hiến pháp.
    (b) schema_version tồn tại + đúng dạng 'place-v...'.
    (c) build_rule_hash tồn tại (không None).
    (d) topology_version tồn tại (không None).
    (e) target_map_count == TARGET_MAP_COUNT.
    (f) target_region_shards == TARGET_REGION_SHARDS.
    (g) content_hash khớp — file không bị sửa tay.
    (h) đủ TARGET_MAP_COUNT map.
    Trả (maps, place_meta) nếu hợp lệ."""
    fp = REPO_DIR / 'cmd-place' / 'output' / 'registry' / 'map_registry.jsonl'
    meta_fp = fp.with_suffix('.jsonl.meta')
    if not fp.exists() or not meta_fp.exists():
        log.error("Chưa có map_registry.jsonl của CMD_PLACE — chờ CMD_PLACE")
        return None
    try:
        place_meta = json.loads(meta_fp.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError) as e:
        log.error(f"Đọc place meta lỗi: {e}")
        return None
    # (a) foundation khớp
    if place_meta.get('foundation_hash') != FOUNDATION_HASH:
        log.error("CMD_PLACE dùng foundation khác — DỪNG")
        return None
    # (b) schema_version tồn tại + đúng dạng
    sv = place_meta.get('schema_version')
    if not isinstance(sv, str) or not sv.startswith('place-v'):
        log.error(f"CMD_PLACE schema_version sai: {sv} — DỪNG")
        return None
    # (c) build_rule_hash tồn tại
    if not place_meta.get('build_rule_hash'):
        log.error("CMD_PLACE meta thiếu build_rule_hash — DỪNG")
        return None
    # (d) topology_version tồn tại
    if place_meta.get('topology_version') is None:
        log.error("CMD_PLACE meta thiếu topology_version — DỪNG")
        return None
    # (e) target_map_count khớp
    if place_meta.get('target_map_count') != TARGET_MAP_COUNT:
        log.error(f"CMD_PLACE target_map_count "
                  f"{place_meta.get('target_map_count')} != {TARGET_MAP_COUNT}")
        return None
    # (f) target_region_shards khớp
    if place_meta.get('target_region_shards') != TARGET_REGION_SHARDS:
        log.error(f"CMD_PLACE target_region_shards "
                  f"{place_meta.get('target_region_shards')} "
                  f"!= {TARGET_REGION_SHARDS}")
        return None
    # (g) content_hash khớp — file không bị sửa tay
    actual = hashlib.sha256(fp.read_bytes()).hexdigest()
    if place_meta.get('content_hash') != actual:
        log.error("map_registry.jsonl bị sửa tay (content_hash lệch) — DỪNG")
        return None
    # (h) đọc maps + đếm
    maps = []
    for line in fp.read_text(encoding='utf-8').splitlines():
        if line.strip():
            maps.append(json.loads(line))
    if len(maps) != TOTAL_MAP_COUNT:
        log.error(f"CMD_PLACE có {len(maps)} map, cần {TOTAL_MAP_COUNT}")
        return None
    return maps, place_meta


def place_source_info(place_meta):
    """Trả 3 hash định danh nguồn CMD_PLACE — gắn vào mỗi layout để
    CMD_NPC/Unity bắt stale data. load_place_registry đã verify chặt
    nên 3 hash này LUÔN có; raise nếu thiếu (không để None lọt vào
    layout — layout không rõ nguồn là bug nghiêm trọng)."""
    ph = place_meta.get('content_hash')
    bh = place_meta.get('build_rule_hash')
    tv = place_meta.get('topology_version')
    if not ph or not bh or tv is None:
        raise ValueError(
            "place_meta thiếu hash nguồn — load_place_registry phải "
            "verify trước khi gọi place_source_info")
    return {
        'source_place_hash': ph,
        'source_build_rule_hash': bh,
        'source_topology_version': tv,
    }


# ── RLE — nén layer (chống phình data 10000 map) ──
def rle_encode(grid):
    """Nén list số nguyên thành [[value, count], ...]."""
    if not grid:
        return []
    out = []
    cur, cnt = grid[0], 1
    for v in grid[1:]:
        if v == cur:
            cnt += 1
        else:
            out.append([cur, cnt])
            cur, cnt = v, 1
    out.append([cur, cnt])
    return out


def rle_decode(rle):
    """Giải nén RLE về list."""
    out = []
    for v, c in rle:
        out.extend([v] * c)
    return out


def _tile_stream(seed, n):
    """Sinh n số 0-99 deterministic từ 1 seed. sha256 làm mầm, sinh
    bytes hàng loạt rồi map sang 0-99 — nhanh, deterministic."""
    out = []
    need = n
    ctr = 0
    while need > 0:
        block = hashlib.sha256(f'{seed}:{ctr}'.encode()).digest()  # 32 byte
        for b in block:
            out.append(b % 100)
            need -= 1
            if need == 0:
                break
        ctr += 1
    return out


# ── Sinh walk_mask — 1 lớp, đúng TS Online Ground.MMG ──
def build_walk_mask(seed, biome, terrain, grid_w, grid_h):
    """Sinh walk_mask — list n ô, mỗi ô 1 trong 4 trạng thái
    (FREE/BLOCK/WATER/SLOPE). water/slope theo biome + terrain CMD_PLACE
    (điều 6+9). ĐẢM BẢO ô FREE >= MIN_WALKABLE_RATIO (điều 2)."""
    n = grid_w * grid_h
    t = BIOME_TERRAIN.get(biome, BIOME_TERRAIN['plain'])
    # terrain CMD_PLACE điều chỉnh: water_ratio -> nước, roughness -> dốc
    water_pct = min(90, t['water'] + terrain.get('water_ratio', 0) // 4)
    slope_pct = min(60, t['slope'] + terrain.get('roughness', 0) // 5)
    block_pct = t['block']
    b1 = water_pct
    b2 = b1 + block_pct
    b3 = b2 + slope_pct
    stream = _tile_stream(f'{seed}:walk', n)
    mask = []
    for r in stream:
        if r < b1:
            mask.append(WALK_WATER)
        elif r < b2:
            mask.append(WALK_BLOCK)
        elif r < b3:
            mask.append(WALK_SLOPE)
        else:
            mask.append(WALK_FREE)
    _ensure_walkable(mask, grid_w, grid_h, MIN_WALKABLE_RATIO)
    return mask


def _is_walkable(state):
    """Ô đi được = FREE hoặc SLOPE (dốc đi được, chậm). WATER/BLOCK cản."""
    return state in (WALK_FREE, WALK_SLOPE)


def _ensure_walkable(mask, grid_w, grid_h, min_ratio):
    """Đảm bảo tỉ lệ ô đi được >= min_ratio. Đổi ô cản (WATER/BLOCK)
    thành FREE (đường/cầu) theo lưới đều cho tới khi đủ — map nhiều
    nước vẫn chơi được (điều 2)."""
    n = len(mask)
    need = int(n * min_ratio)
    walk = sum(1 for s in mask if _is_walkable(s))
    if walk >= need:
        return
    step = 2
    while walk < need and step >= 1:
        i = 0
        while i < n and walk < need:
            if not _is_walkable(mask[i]):
                if (i % step == 0) and ((i // grid_w) % step == 0):
                    mask[i] = WALK_FREE
                    walk += 1
            i += 1
        step -= 1


def _nearest_walkable(mask, grid_w, grid_h, tx, ty, avoid=None):
    """Tìm ô đi được gần (tx,ty) nhất, KHÔNG trong avoid (ô portal +
    anchor đã đặt). Quét xoắn ốc tăng bán kính (điều 4+8)."""
    avoid = avoid or set()

    def ok(x, y):
        if not (0 <= x < grid_w and 0 <= y < grid_h):
            return False
        if (x, y) in avoid:
            return False
        return _is_walkable(mask[y * grid_w + x])
    if ok(tx, ty):
        return tx, ty
    for rad in range(1, max(grid_w, grid_h)):
        for dx in range(-rad, rad + 1):
            for dy in range(-rad, rad + 1):
                if abs(dx) != rad and abs(dy) != rad:
                    continue
                x, y = tx + dx, ty + dy
                if ok(x, y):
                    return x, y
    return tx, ty


def _portal_side(my_x, my_y, to_x, to_y):
    """Hướng mép đặt portal dựa coord map đích so map hiện tại.
    Map đích bên phải -> mép phải; bên trên -> mép trên... Chọn trục
    chênh lớn hơn. Trả 0=trái 1=phải 2=trên 3=dưới."""
    dx = to_x - my_x
    dy = to_y - my_y
    if abs(dx) >= abs(dy):
        return 1 if dx > 0 else 0
    return 3 if dy > 0 else 2


def _portal_edge_pos(seed, idx, side, grid_w, grid_h, used_edge):
    """Đặt portal trên MÉP đúng hướng (side từ _portal_side). Nếu ô
    trùng portal khác -> dịch dọc mép tới ô trống. used_edge = set ô
    portal đã đặt."""
    for shift in range(max(grid_w, grid_h)):
        if side == 0:      # mép trái
            base = seeded_int(f'{seed}:py:{idx}', 1, grid_h - 2)
            x, y = 1, 1 + (base - 1 + shift) % (grid_h - 2)
        elif side == 1:    # mép phải
            base = seeded_int(f'{seed}:py:{idx}', 1, grid_h - 2)
            x, y = grid_w - 2, 1 + (base - 1 + shift) % (grid_h - 2)
        elif side == 2:    # mép trên
            base = seeded_int(f'{seed}:px:{idx}', 1, grid_w - 2)
            x, y = 1 + (base - 1 + shift) % (grid_w - 2), 1
        else:              # mép dưới
            base = seeded_int(f'{seed}:px:{idx}', 1, grid_w - 2)
            x, y = 1 + (base - 1 + shift) % (grid_w - 2), grid_h - 2
        if (x, y) not in used_edge:
            return x, y
    return x, y


def _carve_path(mask, grid_w, grid_h, x0, y0, x1, y1):
    """Đục đường đi được nối (x0,y0)->(x1,y1) — ngang rồi dọc. Mọi ô
    trên đường thành FREE. Đảm bảo portal/anchor nối vùng chính."""
    x, y = x0, y0
    while x != x1:
        mask[y * grid_w + x] = WALK_FREE
        x += 1 if x1 > x else -1
    while y != y1:
        mask[y * grid_w + x] = WALK_FREE
        y += 1 if y1 > y else -1
    mask[y1 * grid_w + x1] = WALK_FREE


def build_spawn_zones(seed, place_map, mask, grid_w, grid_h, used,
                      portal_tiles):
    """Sinh vùng spawn quái — HÌNH HỌC (CMD_MAP vẽ vùng, CMD_NPC điền
    quái). Đọc spawn_policy CMD_PLACE. Mỗi zone PHẢI:
    - walkable_ratio >= 0.70 (vùng đi được, quái spawn được).
    - KHÔNG đè ô portal / ô anchor.
    Thử nhiều vị trí (dịch theo lưới) tới khi đạt; không đạt -> bỏ zone
    đó (thà ít zone còn hơn zone xấu)."""
    sp = place_map.get('spawn_policy', {})
    if not sp.get('allow_monster_spawn'):
        return [], {'requested': 0, 'generated': 0, 'reason': 'not_allowed'}
    count = sp.get('zone_count_hint', 0)
    if count <= 0:
        return [], {'requested': 0, 'generated': 0, 'reason': 'hint_zero'}
    tier = place_map['tier']
    biome = place_map['biome']
    blocked = set(portal_tiles) | set(used)
    zones = []
    # biome thủy chiến: quái spawn TRÊN NƯỚC -> ô WATER cũng tính
    # spawnable. Map đất thường: chỉ FREE/SLOPE (như cũ).
    is_naval = biome in NAVAL_BIOMES

    def _cell_spawnable(state):
        """Ô có thể spawn quái. Map thủy: + WATER. Map đất: FREE/SLOPE."""
        if _is_walkable(state):
            return True
        return is_naval and state == WALK_WATER

    def _zone_ok(x0, y0, zw, zh):
        """Trả spawnable_ratio nếu zone hợp lệ, -1 nếu đè portal/anchor."""
        free = tot = 0
        for yy in range(y0, y0 + zh):
            for xx in range(x0, x0 + zw):
                if (xx, yy) in blocked:
                    return -1.0      # đè portal/anchor -> loại
                tot += 1
                if _cell_spawnable(mask[yy * grid_w + xx]):
                    free += 1
        return free / tot if tot else 0.0

    for i in range(count):
        zw0 = seeded_int(f'{seed}:zw:{i}', 3, max(4, grid_w // 6))
        zh0 = seeded_int(f'{seed}:zh:{i}', 3, max(4, grid_h // 6))
        # thử dịch zone theo lưới tới khi đạt spawnable >= 0.70 +
        # không đè. Nếu trượt hết -> THU NHỎ zone dần (map nhiều cản
        # như mê cung khó tìm vùng rộng) tới min 3x3.
        placed = None
        for shrink in range(0, max(zw0, zh0)):
            zw = max(3, zw0 - shrink)
            zh = max(3, zh0 - shrink)
            bx = seeded_int(f'{seed}:zx:{i}:{shrink}', 0, grid_w - zw)
            by = seeded_int(f'{seed}:zy:{i}:{shrink}', 0, grid_h - zh)
            for sx in range(0, grid_w - zw + 1, 2):
                for sy in range(0, grid_h - zh + 1, 2):
                    x0 = (bx + sx) % (grid_w - zw + 1)
                    y0 = (by + sy) % (grid_h - zh + 1)
                    ratio = _zone_ok(x0, y0, zw, zh)
                    if ratio >= 0.70:
                        placed = (x0, y0, zw, zh, ratio)
                        break
                if placed:
                    break
            if placed:
                break
        if not placed:
            continue   # cả zone 3x3 cũng không đặt được -> bỏ zone này
        x0, y0, zw, zh, ratio = placed
        # đánh dấu ô zone đã chiếm -> zone sau không chồng zone trước
        for yy in range(y0, y0 + zh):
            for xx in range(x0, x0 + zw):
                blocked.add((xx, yy))
        zones.append({
            'zone_id': f'm{place_map["map_id"]:05d}_spawn_{i:02d}',
            'zone_type': 'monster_spawn',
            'bounds': {'x': x0, 'y': y0, 'w': zw, 'h': zh},
            'biome': biome, 'tier': tier,
            'spawn_profile': sp.get('spawn_profile', 'none'),
            'density_hint': sp.get('density_hint', 'none'),
            'walkable_ratio': round(ratio, 2),
            'naval': is_naval,   # True -> zone thủy chiến (CMD_NPC spawn thủy quái)
            'forbidden': ['portal', 'npc_anchor', 'safe_zone_core'],
        })
    # status: zone_count_hint là GỢI Ý — sinh đủ hay ít hơn đều hợp lệ,
    # nhưng phải ghi rõ requested/generated/reason cho CMD_NPC biết.
    gen = len(zones)
    if gen == count:
        reason = 'ok'
    elif gen == 0:
        reason = 'no_valid_area'
    else:
        reason = 'partial_not_enough_walkable_area'
    status = {'requested': count, 'generated': gen, 'reason': reason}
    return zones, status


def build_map_layout(place_map, src_info, place_index):
    """Sinh map_layout.json cho 1 map — kiểu TS Online (lớp L2).
    place_index = {map_id: (coord_x, coord_y)} để đặt portal đúng hướng.
    - background: art_group (LoRA vẽ ảnh nền).
    - walk_mask: 1 lớp RLE 4 trạng thái (Ground.MMG của TS).
    - portal_points: khớp portal_graph CMD_PLACE, mép đúng hướng to_map.
    - anchor_points: anchor CMD_PLACE -> tile thật, đi được.
    - spawn_zones: vùng hình học (CMD_NPC điền quái). safe_zone -> [].
    KHÔNG gameplay logic."""
    mid = place_map['map_id']
    biome = place_map['biome']
    tier = place_map['tier']
    terrain = place_map.get('terrain', {})
    seed = f"maplayout:{place_map['natural_key']}:{LAYOUT_VERSION}"
    gw, gh = GRID_BY_TIER.get(tier, (48, 36))

    mask = build_walk_mask(seed, biome, terrain, gw, gh)
    cx, cy = gw // 2, gh // 2
    my_x, my_y = place_index.get(mid, (0, 0))

    # ── portal_points: mép đúng hướng to_map (coord) ──
    portal_points = []
    used_edge = set()
    for i, lk in enumerate(place_map.get('portal_graph', [])):
        to_x, to_y = place_index.get(lk['to_map'], (my_x, my_y))
        side = _portal_side(my_x, my_y, to_x, to_y)
        px, py = _portal_edge_pos(seed, i, side, gw, gh, used_edge)
        used_edge.add((px, py))
        _carve_path(mask, gw, gh, px, py, cx, cy)
        portal_points.append({
            'from_map': mid, 'to_map': lk['to_map'],
            'tile_x': px, 'tile_y': py, 'edge_side': side,
        })

    # ── anchor_points: anchor CMD_PLACE rel_x/y (0-100) -> tile ──
    portal_tiles = {(p['tile_x'], p['tile_y']) for p in portal_points}
    anchor_points = []
    used = set(portal_tiles)
    for atype, items in sorted(place_map.get('anchors', {}).items()):
        for a in items:
            tx = min(gw - 1, max(0, a['rel_x'] * gw // 100))
            ty = min(gh - 1, max(0, a['rel_y'] * gh // 100))
            tx, ty = _nearest_walkable(mask, gw, gh, tx, ty, used)
            used.add((tx, ty))
            _carve_path(mask, gw, gh, tx, ty, cx, cy)
            anchor_points.append({
                'anchor_id': a['anchor_id'], 'type': atype,
                'tile_x': tx, 'tile_y': ty,
            })

    # ── spawn_zones: vùng hình học. safe_zone -> KHÔNG có vùng quái ──
    if place_map.get('safe_zone'):
        spawn_zones = []
        spawn_status = {'requested': 0, 'generated': 0,
                        'reason': 'safe_zone'}
    else:
        spawn_zones, spawn_status = build_spawn_zones(
            seed, place_map, mask, gw, gh, used, portal_tiles)

    art_group = f"{biome}_{place_map['era']}_t{tier}"
    layout = {
        'map_id': mid,
        'uuid': place_map['uuid'],          # copy uuid từ CMD_PLACE
        'layout_version': LAYOUT_VERSION,
        'natural_key': place_map['natural_key'],
        'source_place_hash': src_info['source_place_hash'],
        'source_build_rule_hash': src_info['source_build_rule_hash'],
        'topology_version': src_info['source_topology_version'],
        'biome': biome, 'era': place_map['era'],
        'zone': place_map['zone'], 'tier': tier,
        'safe_zone': place_map.get('safe_zone', False),
        'grid_w': gw, 'grid_h': gh,
        'background': {'art_group': art_group},
        'walk_mask': {
            'encoding': 'rle', 'width': gw, 'height': gh,
            'data': rle_encode(mask),
        },
        'portal_points': portal_points,
        'anchor_points': anchor_points,
        'spawn_zones': spawn_zones,
        # status: zone_count_hint là gợi ý — ghi rõ requested/generated/
        # reason để CMD_NPC biết vì sao ít hơn (hướng A, production-safe).
        'spawn_zone_status': spawn_status,
    }
    layout['layout_hash'] = hashlib.sha256(
        json.dumps(layout, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()
    return layout


def iter_layouts(place_maps, place_meta):
    """STREAMING — yield từng layout, KHÔNG giữ cả 10000 trong RAM
    (fix OOM: 10000 layout ~2.4GB). Caller ghi file rồi giải phóng."""
    src_info = place_source_info(place_meta)
    # index map_id -> coord, để đặt portal đúng hướng to_map
    place_index = {pm['map_id']: (pm['coord_x'], pm['coord_y'])
                   for pm in place_maps}
    for pm in place_maps:
        yield build_map_layout(pm, src_info, place_index)


def build_art_profiles(place_maps):
    """Gom art_prompt theo nhóm biome+era+tier (điều 10). Tính từ
    place_maps (nhẹ) — KHÔNG cần giữ layouts trong RAM."""
    biome_desc = {
        'forest': 'rung Viet co', 'mountain': 'nui non hung vi',
        'river': 'song nuoc', 'plain': 'dong bang', 'sea': 'bien ca',
        'swamp': 'dam lay', 'craft_village': 'lang nghe thu cong',
        'rice_field': 'ruong lua nuoc', 'fishing_village': 'lang chai',
        'salt_field': 'dong muoi', 'plantation': 'don dien',
        'wharf': 'ben cang', 'capital': 'kinh do', 'capital_inner': 'noi thanh',
        'town': 'thi tran', 'village': 'lang que', 'citadel': 'thanh tri',
        'frontier_pass': 'ai quan bien gioi', 'battlefield': 'chien truong',
        'cave': 'hang dong', 'scenic': 'danh thang', 'garden': 'vuon canh',
    }
    profiles = {}
    for pm in place_maps:
        biome, era, tier = pm['biome'], pm['era'], pm['tier']
        g = f"{biome}_{era}_t{tier}"
        if g in profiles:
            continue
        desc = biome_desc.get(biome, biome)
        profiles[g] = {
            'art_group': g,
            'art_prompt': (f"SVTK style, ancient Vietnamese {desc}, "
                           f"era {era}, isometric 2D MMORPG map, "
                           f"readable paths, soft cel shading, "
                           f"tier {tier} difficulty"),
            'negative_prompt': ("modern city, cyberpunk, neon, sci-fi, "
                                "cars, guns, western castle, japanese, chinese"),
            'lora_tags': ['svtk_style', 'viet_ancient', biome,
                          'isometric_2d', 'mmo_map', f'era_{era}'],
        }
    return profiles


# ── VALIDATOR phụ ──
def _bfs_reach(walk, start):
    """BFS — trả set ô đi tới được từ start trong vùng walk."""
    if start not in walk:
        return set()
    seen = {start}
    stack = [start]
    while stack:
        x, y = stack.pop()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nb = (x + dx, y + dy)
            if nb in walk and nb not in seen:
                seen.add(nb)
                stack.append(nb)
    return seen


def build_layout_context(layout):
    """Decode walk_mask 1 LẦN + BFS 1 LẦN cho 1 layout. Mọi check
    dùng lại context này — KHÔNG decode/BFS lặp (fix timeout: trước
    mỗi layout decode 4 lần + BFS theo từng portal).
    BFS xuất phát từ tâm map (hoặc ô đi được gần tâm) — vì build_map
    đã carve đường từ mọi portal/anchor về tâm, nên 1 lần BFS từ tâm
    phủ đủ để check mọi portal/anchor có nối được không."""
    m = rle_decode(layout['walk_mask']['data'])
    gw, gh = layout['grid_w'], layout['grid_h']
    walkable = {(i % gw, i // gw) for i, s in enumerate(m)
                if _is_walkable(s)}
    portal_tiles = {(p['tile_x'], p['tile_y'])
                    for p in layout['portal_points']}
    anchor_tiles = {(a['tile_x'], a['tile_y'])
                    for a in layout['anchor_points']}
    # ô tâm để BFS — nếu tâm bị cản, lấy ô đi được gần nhất
    cx, cy = gw // 2, gh // 2
    if (cx, cy) not in walkable:
        cand = [(x, y) for (x, y) in walkable
                if abs(x - cx) <= 3 and abs(y - cy) <= 3]
        center = cand[0] if cand else None
    else:
        center = (cx, cy)
    reachable = _bfs_reach(walkable, center) if center else set()
    walk_ratio = len(walkable) / len(m) if m else 0.0
    return {
        'gw': gw, 'gh': gh, 'mask_len': len(m),
        'walkable': walkable, 'walk_ratio': walk_ratio,
        'portal_tiles': portal_tiles, 'anchor_tiles': anchor_tiles,
        'center': center, 'reachable': reachable,
    }


# ── VALIDATOR phụ — nhận ctx (đã decode/BFS sẵn), KHÔNG decode lại ──
def _anchor_on_walkable(ctx, layout):
    """Mọi anchor_point nằm trên ô đi được."""
    return all((a['tile_x'], a['tile_y']) in ctx['walkable']
               for a in layout['anchor_points'])


def _portal_on_edge(ctx, layout):
    """Mọi portal gần MÉP map — cách mép <= 2 ô."""
    gw, gh = ctx['gw'], ctx['gh']
    for p in layout['portal_points']:
        x, y = p['tile_x'], p['tile_y']
        if not (x <= 2 or x >= gw - 3 or y <= 2 or y >= gh - 3):
            return False
    return True


def _portal_connected(ctx, layout):
    """Mọi portal có đường đi được nối vào tâm map. Dùng reachable
    đã BFS sẵn từ tâm — portal nối tâm <=> portal nằm trong reachable."""
    if not layout['portal_points']:
        return True
    if ctx['center'] is None:
        return False
    return all((p['tile_x'], p['tile_y']) in ctx['reachable']
               for p in layout['portal_points'])


def _anchor_reachable_from_portal(ctx, layout):
    """Mọi anchor đi tới được trong cùng vùng nối với portal/tâm.
    reachable BFS từ tâm — anchor nằm trong reachable <=> tới được."""
    if not layout['portal_points'] or not layout['anchor_points']:
        return True
    if ctx['center'] is None:
        return False
    return all((a['tile_x'], a['tile_y']) in ctx['reachable']
               for a in layout['anchor_points'])


def _layout_hash_ok(layout):
    """layout_hash khớp nội dung — recompute so sánh."""
    h = layout.get('layout_hash')
    tmp = {k: v for k, v in layout.items() if k != 'layout_hash'}
    calc = hashlib.sha256(
        json.dumps(tmp, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()
    return h == calc


def _walk_mask_ok(ctx, layout):
    """walk_mask RLE giải nén đúng grid_w*grid_h ô, trạng thái hợp lệ."""
    n = ctx['gw'] * ctx['gh']
    rle = layout['walk_mask']['data']
    if sum(c for _, c in rle) != n:
        return False
    if ctx['mask_len'] != n:
        return False
    return all(v in (WALK_FREE, WALK_BLOCK, WALK_WATER, WALK_SLOPE)
               for v, _ in rle)


def _walkable_ratio_ok(ctx):
    """Tỉ lệ ô đi được >= MIN_WALKABLE_RATIO — map chơi được."""
    return ctx['walk_ratio'] >= MIN_WALKABLE_RATIO


def _anchor_not_on_portal(ctx, layout):
    """Anchor không đè ô portal."""
    return not (ctx['anchor_tiles'] & ctx['portal_tiles'])



def _spawn_zone_ok(ctx, layout):
    """spawn_zone hợp lệ: bounds trong map, KHÔNG gameplay, KHÔNG đè
    BẤT KỲ ô portal/anchor nào, walkable_ratio >= 0.70. safe_zone thì
    phải KHÔNG có spawn_zone."""
    gw, gh = ctx['gw'], ctx['gh']
    blocked = ctx['portal_tiles'] | ctx['anchor_tiles']
    GP = ('monster_id', 'level', 'level_min', 'level_max', 'drop',
          'exp', 'respawn', 'ai', 'skill', 'monster_group')
    # safe_zone -> KHÔNG được có vùng quái
    if layout.get('safe_zone') and layout.get('spawn_zones'):
        return False
    # spawn_zone_status nhất quán: generated == số zone thực
    st = layout.get('spawn_zone_status')
    if not isinstance(st, dict):
        return False
    if set(st.keys()) != {'requested', 'generated', 'reason'}:
        return False
    if st['generated'] != len(layout.get('spawn_zones', [])):
        return False
    if st['generated'] > st['requested']:
        return False
    for z in layout.get('spawn_zones', []):
        b = z['bounds']
        if b['x'] < 0 or b['y'] < 0:
            return False
        if b['x'] + b['w'] > gw or b['y'] + b['h'] > gh:
            return False
        if any(k in z for k in GP):
            return False
        if z.get('walkable_ratio', 0) < 0.70:
            return False
        # KHÔNG đè ô portal/anchor — duyệt ô zone
        for x in range(b['x'], b['x'] + b['w']):
            for y in range(b['y'], b['y'] + b['h']):
                if (x, y) in blocked:
                    return False
    return True



def _portal_side_ok(layout, place_index):
    """Portal nằm đúng MÉP theo hướng to_map (coord). edge_side phải
    khớp _portal_side(my_coord, to_coord)."""
    mid = layout['map_id']
    my = place_index.get(mid)
    if my is None:
        return True
    for p in layout['portal_points']:
        to = place_index.get(p['to_map'])
        if to is None:
            continue
        want = _portal_side(my[0], my[1], to[0], to[1])
        if p.get('edge_side') != want:
            return False
    return True


def _db_contract_ok(sample_layout):
    """SQL map_layouts phải có cột cho mọi field top-level của
    map_layout.json (chống DB drift — Unity/CMD_NPC đọc SQL phải khớp
    JSON). Bỏ qua các field gom JSON (background)."""
    import re as _re
    sql = build_schema_sql()
    cols = set(_re.findall(r'^\s*([a-z_0-9]+)\s+'
                           r'(?:INT|VARCHAR|TEXT|BOOLEAN)',
                           sql, _re.MULTILINE))
    # field JSON gói thành cột riêng / cột con
    alias = {'background': 'art_group', 'walk_mask': 'walk_mask'}
    for k in sample_layout:
        col = alias.get(k, k)
        if col not in cols:
            return False
    return True


def self_validate(layout_iter, place_maps, profiles):
    """Verify layout — STREAMING, KHÔNG giữ cả 10000 layout trong RAM.
    Duyệt iterator 1 lần, cộng dồn kết quả. Trả (score, [check fail])."""
    place_ids = set(m['map_id'] for m in place_maps)
    place_index = {m['map_id']: (m['coord_x'], m['coord_y'])
                   for m in place_maps}
    seen_ids = set()
    n = 0
    fail = {
        'layout_version_set': False, 'all_have_layout_hash': False,
        'layout_hash_valid': False, 'all_have_source_hash': False,
        'all_have_source_build_rule': False, 'walk_mask_present': False,
        'walk_mask_valid': False, 'no_dead_map': False,
        'all_have_portal': False, 'anchor_on_walkable': False,
        'anchor_not_on_portal': False, 'portal_on_edge': False,
        'portal_connected': False, 'anchor_reachable': False,
        'portal_no_overlap': False,
        'walkable_ratio_ok': False, 'art_group_has_profile': False,
        'background_has_art_group': False, 'spawn_zone_valid': False,
        'no_gameplay_logic': False, 'biome_valid': False, 'era_valid': False,
        'map_id_unique': False, 'has_uuid': False, 'portal_side_ok': False,
    }
    # CMD_MAP KHÔNG được chứa gameplay (điều 1)
    GP_KEYS = ('damage', 'skill', 'drop_rate', 'combat_formula',
               'ai_behavior', 'hp', 'atk', 'monster_id', 'level', 'exp')
    for l in layout_iter:
        n += 1
        mid = l['map_id']
        if mid in seen_ids:
            fail['map_id_unique'] = True
        seen_ids.add(mid)
        if l.get('layout_version') != LAYOUT_VERSION:
            fail['layout_version_set'] = True
        if not l.get('layout_hash'):
            fail['all_have_layout_hash'] = True
        elif not _layout_hash_ok(l):
            fail['layout_hash_valid'] = True
        if not l.get('source_place_hash'):
            fail['all_have_source_hash'] = True
        if not l.get('source_build_rule_hash'):
            fail['all_have_source_build_rule'] = True
        # walk_mask thiếu -> bỏ qua check cần ctx (tránh decode lỗi)
        if 'walk_mask' not in l or 'data' not in l.get('walk_mask', {}):
            fail['walk_mask_present'] = True
            ctx = None
        else:
            # DECODE + BFS 1 LẦN — mọi check dùng lại ctx (fix timeout)
            ctx = build_layout_context(l)
        if ctx is not None:
            if not _walk_mask_ok(ctx, l):
                fail['walk_mask_valid'] = True
            if not _anchor_on_walkable(ctx, l):
                fail['anchor_on_walkable'] = True
            if not _anchor_not_on_portal(ctx, l):
                fail['anchor_not_on_portal'] = True
            if not _portal_on_edge(ctx, l):
                fail['portal_on_edge'] = True
            if not _portal_connected(ctx, l):
                fail['portal_connected'] = True
            if not _anchor_reachable_from_portal(ctx, l):
                fail['anchor_reachable'] = True
            if not _walkable_ratio_ok(ctx):
                fail['walkable_ratio_ok'] = True
            if not _spawn_zone_ok(ctx, l):
                fail['spawn_zone_valid'] = True
        # BUG CŨ 1: map chết — phải có >=1 anchor
        if not l.get('anchor_points'):
            fail['no_dead_map'] = True
        # BUG CŨ 3: thiếu travel_node — phải có >=1 portal
        if not l.get('portal_points'):
            fail['all_have_portal'] = True
        # 2 portal KHÔNG được trùng 1 ô
        ppt = [(p['tile_x'], p['tile_y']) for p in l['portal_points']]
        if len(ppt) != len(set(ppt)):
            fail['portal_no_overlap'] = True
        # background trỏ art_group, art_group có profile (điều 10)
        ag = l.get('background', {}).get('art_group')
        if not ag:
            fail['background_has_art_group'] = True
        elif ag not in profiles:
            fail['art_group_has_profile'] = True
        if any(k in l for k in GP_KEYS):
            fail['no_gameplay_logic'] = True
        if l['biome'] not in ALL_BIOMES:
            fail['biome_valid'] = True
        if l['era'] not in ERAS and l['era'] not in SPECIAL_ERAS:
            fail['era_valid'] = True
        # uuid copy từ CMD_PLACE
        if not l.get('uuid'):
            fail['has_uuid'] = True
        # portal đặt đúng mép theo hướng to_map
        if not _portal_side_ok(l, place_index):
            fail['portal_side_ok'] = True

    checks = [
        ('foundation_verified', FOUNDATION_VERIFIED),
        ('layout_count_match', n == TOTAL_MAP_COUNT),
        ('map_id_match_place', seen_ids == place_ids),
    ]
    # SQL map_layouts phủ đủ field layout (chống DB drift). Chỉ cần
    # kiểm TÊN field nên dùng src_info placeholder (không cần hash thật).
    if place_maps:
        _pidx = {m['map_id']: (m['coord_x'], m['coord_y'])
                 for m in place_maps}
        _si = {'source_place_hash': 'x', 'source_build_rule_hash': 'x',
               'source_topology_version': 0}
        _sample = build_map_layout(place_maps[0], _si, _pidx)
        checks.append(('db_contract_fields_present',
                       _db_contract_ok(_sample)))
    for name, bad in fail.items():
        checks.append((name, not bad))
    passed = sum(1 for _, ok in checks if ok)
    return passed / len(checks), [c for c, ok in checks if not ok]


# ── SCHEMA SQL — map_layouts (projection của map_layout.json) ──
def build_schema_sql():
    """SQL bảng map_layouts — CMD_NPC/Unity đọc. walk_mask/portal/anchor/
    spawn_zone lưu JSON (TEXT). KHÔNG cột gameplay."""
    return f"""-- CMD_MAP v{CMD_VERSION} — schema map_layouts
CREATE TABLE map_layouts (
    map_id INT PRIMARY KEY,
    uuid VARCHAR(36) NOT NULL,      -- copy từ CMD_PLACE
    layout_version INT NOT NULL,
    layout_hash VARCHAR(64) NOT NULL,
    source_place_hash VARCHAR(64) NOT NULL,
    source_build_rule_hash VARCHAR(64) NOT NULL,
    topology_version INT NOT NULL,
    natural_key VARCHAR(64) NOT NULL,
    biome VARCHAR(32) NOT NULL,
    era VARCHAR(16) NOT NULL,
    zone VARCHAR(16) NOT NULL,
    tier INT NOT NULL,
    safe_zone BOOLEAN NOT NULL,     -- vùng an toàn (không quái)
    grid_w INT NOT NULL,
    grid_h INT NOT NULL,
    art_group VARCHAR(48) NOT NULL,
    walk_mask TEXT NOT NULL,        -- JSON: {{encoding,width,height,data}}
    portal_points TEXT NOT NULL,    -- JSON array
    anchor_points TEXT NOT NULL,    -- JSON array
    spawn_zones TEXT NOT NULL,      -- JSON array (vùng — KHÔNG quái)
    spawn_zone_status TEXT NOT NULL, -- JSON: {{requested,generated,reason}}
    UNIQUE(uuid),
    UNIQUE(natural_key),
    UNIQUE(layout_hash),
    CHECK (map_id BETWEEN 1 AND {TOTAL_MAP_COUNT}),
    CHECK (tier BETWEEN 1 AND 5)
);
CREATE INDEX idx_layout_biome ON map_layouts(biome);
CREATE INDEX idx_layout_era ON map_layouts(era);
CREATE INDEX idx_layout_art_group ON map_layouts(art_group);
CREATE INDEX idx_layout_tier ON map_layouts(tier);
"""


# ── WRITE — streaming, ghi từng map (KHÔNG giữ 10000 trong RAM) ──
def write_outputs(place_maps, place_meta, out_dir):
    """Ghi output: art_profiles/<group>.json + map_<id>/map_layout.json
    + schema.sql. STREAMING — build từng layout, ghi, giải phóng. Trả
    (số map ghi, score, [fail]).
    CLEAN trước khi build: xoá sạch out_dir cũ rồi tạo lại — tránh
    map_layout.json / map dir của lần build trước (vd 10000 map cũ)
    còn sót lại bị push theo."""
    out = Path(out_dir)
    if out.exists():
        shutil.rmtree(out)        # xoá sạch output cũ — chống stale
    (out / 'art_profiles').mkdir(parents=True, exist_ok=True)
    (out / 'maps').mkdir(parents=True, exist_ok=True)
    (out / 'schema').mkdir(parents=True, exist_ok=True)

    # art_profiles — gom nhóm, ghi 1 lần
    profiles = build_art_profiles(place_maps)
    for g, prof in profiles.items():
        (out / 'art_profiles' / f'{g}.json').write_text(
            json.dumps(prof, ensure_ascii=False, indent=1), encoding='utf-8')

    # schema SQL
    (out / 'schema' / 'map_layouts.sql').write_text(
        build_schema_sql(), encoding='utf-8')
    # file test ngoài (CI) — đặt cạnh maps/ để đọc layout đã ghi
    (out / 'map_tests.py').write_text(TEST_CODE, encoding='utf-8')

    # layout — STREAMING: build -> ghi -> giải phóng. Đồng thời validate.
    src_info = place_source_info(place_meta)
    place_index = {pm['map_id']: (pm['coord_x'], pm['coord_y'])
                   for pm in place_maps}
    n = 0
    spawn_zone_count = 0
    for pm in place_maps:
        layout = build_map_layout(pm, src_info, place_index)
        mdir = out / 'maps' / f'map_{layout["map_id"]:05d}'
        mdir.mkdir(exist_ok=True)
        (mdir / 'map_layout.json').write_text(
            json.dumps(layout, ensure_ascii=False), encoding='utf-8')
        spawn_zone_count += len(layout['spawn_zones'])
        n += 1
        del layout  # giải phóng ngay

    # validate lại từ file đã ghi (streaming đọc) + tính output_sha256
    _agg = hashlib.sha256()

    def _read_iter():
        for pm in place_maps:
            mdir = out / 'maps' / f'map_{pm["map_id"]:05d}'
            raw = (mdir / 'map_layout.json').read_text(encoding='utf-8')
            _agg.update(raw.encode('utf-8'))
            yield json.loads(raw)
    score, fails = self_validate(_read_iter(), place_maps, profiles)
    output_sha256 = _agg.hexdigest()

    # build_manifest.json — ghi NGAY sau build (downstream/debug đọc
    # được kể cả khi chưa push). Khác meta.json (ghi lúc push).
    manifest = {
        'cmd': CMD_NAME, 'cmd_version': CMD_VERSION,
        'schema_version': SCHEMA_VERSION,
        'foundation_hash': FOUNDATION_HASH,
        'build_rule_hash': BUILD_RULE_HASH,
        'layout_version': LAYOUT_VERSION,
        'source_place_hash': src_info['source_place_hash'],
        'source_build_rule_hash': src_info['source_build_rule_hash'],
        'source_topology_version': src_info['source_topology_version'],
        'map_count': n,
        'art_profile_count': len(profiles),
        'spawn_zone_count': spawn_zone_count,
        'validation_score': score,
        'honest_gaps': fails,
        'output_sha256': output_sha256,
    }
    (out / 'build_manifest.json').write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding='utf-8')
    return n, score, fails


# ── GIT PUSH — theo mẫu CMD_PLACE (is_retry + dead-letter guard) ──
def _run_git(args, cwd):
    """Chạy git, trả (ok, output). Lỗi không crash bot."""
    try:
        r = subprocess.run(['git'] + args, cwd=str(cwd),
                           capture_output=True, text=True, timeout=120)
        return r.returncode == 0, (r.stdout + r.stderr)
    except (subprocess.CalledProcessError,
            subprocess.TimeoutExpired, OSError) as e:
        return False, str(e)


def push_to_github(out_dir, score, fails, is_retry=False):
    """Push output CMD_MAP lên repo qua BRANCH STAGING riêng — KHÔNG
    push branch hiện tại, KHÔNG merge main. LEAD review staging rồi
    mới merge. Trình tự:
    - đảm bảo repo có (clone nếu chưa)
    - git fetch origin
    - git switch -C staging-map-YYYYMMDD-HHMMSS (branch mới sạch)
    - xoá cmd-map/output cũ trong repo, copy output mới vào
    - git add -A + commit
    - git push origin <branch>
    - fail -> retry tối đa MAX_PUSH_ATTEMPTS, mỗi lần branch tên mới.
    Trả True nếu push thành công."""
    if not REPO_DIR.exists():
        ok, out = _run_git(
            ['clone', '--depth=1', REPO_URL, str(REPO_DIR)], Path('/tmp'))
        if not ok:
            log.error(f"Clone repo lỗi: {out.strip()[:200]}")
            return False

    for attempt in range(MAX_PUSH_ATTEMPTS):
        # branch staging tên duy nhất theo timestamp + số lần retry
        ts = time.strftime('%Y%m%d-%H%M%S')
        suffix = '' if attempt == 0 else f'-r{attempt}'
        branch = f'staging-map-{ts}{suffix}'

        ok, out = _run_git(['fetch', 'origin'], REPO_DIR)
        if not ok:
            log.warning(f"fetch lỗi lần {attempt + 1}: {out.strip()[:120]}")
            time.sleep(RETRY_DELAY_SEC)
            continue
        # switch -C: tạo (hoặc reset) branch staging mới, sạch
        ok, out = _run_git(['switch', '-C', branch], REPO_DIR)
        if not ok:
            log.warning(f"switch lỗi lần {attempt + 1}: {out.strip()[:120]}")
            time.sleep(RETRY_DELAY_SEC)
            continue

        # xoá cmd-map/output cũ trong repo, copy output mới
        dst = REPO_DIR / 'cmd-map' / 'output'
        if dst.exists():
            shutil.rmtree(str(dst))
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(str(Path(out_dir)), str(dst))
        # meta
        meta = {
            'cmd': CMD_NAME, 'cmd_version': CMD_VERSION,
            'schema_version': SCHEMA_VERSION,
            'foundation_hash': FOUNDATION_HASH,
            'build_rule_hash': BUILD_RULE_HASH,
            'layout_version': LAYOUT_VERSION,
            'total_map_count': TOTAL_MAP_COUNT,
            'validation_score': score, 'honest_gaps': fails,
            'is_retry': is_retry or attempt > 0,
            'staging_branch': branch,
        }
        (dst / 'meta.json').write_text(
            json.dumps(meta, indent=2, ensure_ascii=False), encoding='utf-8')

        _run_git(['add', '-A'], REPO_DIR)
        _run_git(['commit', '-m',
                  f'CMD_MAP v{CMD_VERSION} build — {TOTAL_MAP_COUNT} map '
                  f'(score {score:.3f})'], REPO_DIR)
        ok, out = _run_git(['push', 'origin', branch], REPO_DIR)
        if ok:
            log.info(f"Push thành công -> branch {branch}")
            return True
        log.warning(f"Push fail lần {attempt + 1}: {out.strip()[:120]}")
        time.sleep(RETRY_DELAY_SEC)
    log.error("Push thất bại sau mọi lần retry")
    return False


def main_loop():
    """Vòng đời CMD_MAP: verify foundation -> đọc CMD_PLACE -> build ->
    validate -> push. Lặp theo LOOP_INTERVAL_SEC."""
    if not verify_foundation():
        log.error("Foundation verify fail — DỪNG")
        return 1
    loaded = load_place_registry()
    if loaded is None:
        log.error("Đọc CMD_PLACE fail — DỪNG")
        return 1
    place_maps, place_meta = loaded
    n, score, fails = write_outputs(place_maps, place_meta, OUTPUT_DIR)
    log.info(f"Build {n} layout — score {score:.3f} — gaps: {fails or 'KHÔNG'}")
    if score < SCORE_THRESHOLD:
        log.error(f"Score {score:.3f} < ngưỡng {SCORE_THRESHOLD} — không push")
        return 1
    if push_to_github(str(OUTPUT_DIR), score, fails):
        return 0
    return 1




# ── TEST_CODE — file test ngoài (CI). Đọc output đã ghi. ──
TEST_CODE = '''# CMD_MAP v1.1.0 — test file ngoài (đọc maps/ + art_profiles/)
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
    # 10000 map thường + 100 map cõi + 2 map start = 10102
    assert sum(1 for _ in _layouts()) == 10102

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
            assert (x <= 2 or x >= gw - 3 or y <= 2 or y >= gh - 3), \
                f"portal không gần mép: {l['map_id']}"

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
            assert (a["tile_x"], a["tile_y"]) not in pt, \
                f"anchor đè portal: {l['map_id']}"

def test_12_walkable_ratio():
    for l in _layouts():
        m = _rle_decode(l["walk_mask"]["data"])
        ratio = sum(1 for s in m if _is_walk(s)) / len(m)
        assert ratio >= MIN_WALKABLE_RATIO, \
            f"walkable quá thấp: {l['map_id']}"

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
            assert b["x"] + b["w"] <= gw and b["y"] + b["h"] <= gh, \
                f"spawn_zone vuot grid: {l['map_id']}"

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
        assert st["generated"] == len(l["spawn_zones"]), \
            f"status lech zone: {l['map_id']}"
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
'''

if __name__ == '__main__':
    sys.exit(main_loop())
