#!/usr/bin/env python3
"""CMD_RESOURCE_SPEC v1.0.0 — CMD thứ 18 SVTK. Sinh ĐẶC TẢ tài nguyên.

CMD_RESOURCE_SPEC = lớp Rule cho hệ tài nguyên (farm/nghề/crafting/
economy/quest/event/reborn). Đọc output CMD_PLACE + CMD_MAP, sinh
TAXONOMY + RULE đặt tài nguyên. KHÔNG sinh data thật.

RANH GIỚI (hard rules):
- KHÔNG sinh item_id thật       -> CMD_ITEM lo
- KHÔNG sinh drop_table/loot    -> CMD_RESOURCE_DATA lo
- KHÔNG sinh resource_node thật -> CMD_RESOURCE_DATA lo
- KHÔNG sinh npc_id/monster_id  -> CMD_NPC lo
- KHÔNG sinh quest_id thật      -> CMD_QUEST lo
- KHÔNG sinh ảnh, KHÔNG train LoRA
- KHÔNG sửa CMD_PLACE/CMD_MAP/CMD_ART_SPEC
- KHÔNG hardcode theo map_id lẻ — data-driven toàn bộ

Output 8 file: resource_type_catalog / biome_resource_rules /
resource_anchor_rules / quest_item_anchor_rules / event_resource_rules
/ reborn_material_rules / resource_spec.schema / build_manifest.
"""
import os, sys, json, re, time, hashlib, subprocess, logging, shutil
from pathlib import Path

# ── 1 NGUỒN — version sửa đúng 1 chỗ ──
CMD_VERSION = "1.0.0"
CMD_NAME = "RESOURCE_SPEC"
SCHEMA_VERSION = f'resource-spec-v{CMD_VERSION}'
SPEC_VERSION = 1

# ── Foundation v2.10.0 ──
FOUNDATION_HASH = "cc194e6cad2225d197c4a5539352deb538c99cdd6a21845a8354260602287bbb"
FOUNDATION_FILE = "SVTK_FOUNDATION_v2.10.0.md"
FOUNDATION_VERIFIED = False

REPO_URL = os.getenv('SVTK_REPO_URL',
                     'https://github.com/Trinhlong1988/svtk-status.git')
REPO_DIR = Path(os.getenv('SVTK_REPO_DIR', '/tmp/svtk-status-rspec'))
OUTPUT_DIR = Path('/tmp/cmd-resource-spec-out')

# ── HARD CHECK input cross-CMD ──
EXPECT_MAP_COUNT = 10102
MIN_MAP_CMD_VERSION = (1, 1, 0)      # CMD_MAP tối thiểu v1.1.0
MIN_PLACE_CMD_VERSION = (2, 4, 0)    # CMD_PLACE tối thiểu v2.4.0
MAX_PUSH_ATTEMPTS = 3
RETRY_DELAY_SEC = 5
SCORE_THRESHOLD = 0.95

log = logging.getLogger(CMD_NAME)
logging.basicConfig(level=logging.INFO, format='[%(name)s] %(message)s')

# ════════════════════════════════════════════════════════════════════
# ── RESOURCE TAXONOMY — phân loại tài nguyên (KHÔNG phải item thật) ──
# Mỗi resource_type chỉ là 1 LOẠI tài nguyên trừu tượng. item_id thật
# do CMD_ITEM định nghĩa sau; drop/economy do CMD_RESOURCE_DATA.
# resource_family gom nhóm để nghề nghiệp/crafting tham chiếu.
# class: gathering (thu hái lặp lại) / quest (vật phẩm nhiệm vụ) /
#        event (chỉ trong event) / realm (vật liệu cõi).
# ════════════════════════════════════════════════════════════════════

# ── classes tài nguyên ──
RESOURCE_CLASSES = ['gathering', 'quest', 'event', 'realm']

# ── nghề nghiệp gắn với thu hái (taxonomy, không phải skill thật) ──
PROFESSIONS = [
    'logging', 'mining', 'herbalism', 'fishing',
    'farming', 'foraging', 'weaving', 'salt_making',
]

# ── catalog resource_type — 'gathering' class (farm thường) ──
# field: family, profession, civil (True=tài nguyên dân sinh, đặt
# được ở safe_zone), rare_combat (True=hiếm, chỉ wilderness).
RESOURCE_TYPE_CATALOG = {
    # timber / gỗ
    'wood':            {'family': 'timber',   'profession': 'logging',
                        'civil': True,  'rare_combat': False},
    'bamboo':          {'family': 'timber',   'profession': 'logging',
                        'civil': True,  'rare_combat': False},
    'processed_wood':  {'family': 'timber',   'profession': 'weaving',
                        'civil': True,  'rare_combat': False},
    # ore / khoáng
    'stone':           {'family': 'mineral',  'profession': 'mining',
                        'civil': True,  'rare_combat': False},
    'copper_ore':      {'family': 'mineral',  'profession': 'mining',
                        'civil': False, 'rare_combat': False},
    'iron_ore':        {'family': 'mineral',  'profession': 'mining',
                        'civil': False, 'rare_combat': False},
    'ore':             {'family': 'mineral',  'profession': 'mining',
                        'civil': False, 'rare_combat': False},
    'jade_raw':        {'family': 'gemstone', 'profession': 'mining',
                        'civil': False, 'rare_combat': True},
    'crystal':         {'family': 'gemstone', 'profession': 'mining',
                        'civil': False, 'rare_combat': True},
    'gem':             {'family': 'gemstone', 'profession': 'mining',
                        'civil': False, 'rare_combat': True},
    'relic_fragment':  {'family': 'relic',    'profession': 'foraging',
                        'civil': False, 'rare_combat': True},
    # herb / dược liệu
    'herb':            {'family': 'herb',     'profession': 'herbalism',
                        'civil': True,  'rare_combat': False},
    'water_herb':      {'family': 'herb',     'profession': 'herbalism',
                        'civil': True,  'rare_combat': False},
    # fiber / sợi-vải
    'fiber':           {'family': 'fiber',    'profession': 'foraging',
                        'civil': True,  'rare_combat': False},
    'cloth':           {'family': 'fiber',    'profession': 'weaving',
                        'civil': True,  'rare_combat': False},
    'dye':             {'family': 'fiber',    'profession': 'weaving',
                        'civil': True,  'rare_combat': False},
    # thủy sản
    'fish':            {'family': 'aquatic',  'profession': 'fishing',
                        'civil': True,  'rare_combat': False},
    'lotus':           {'family': 'aquatic',  'profession': 'foraging',
                        'civil': True,  'rare_combat': False},
    'shell':           {'family': 'aquatic',  'profession': 'fishing',
                        'civil': True,  'rare_combat': False},
    'pearl':           {'family': 'aquatic',  'profession': 'fishing',
                        'civil': False, 'rare_combat': True},
    'river_pearl':     {'family': 'aquatic',  'profession': 'fishing',
                        'civil': False, 'rare_combat': True},
    'coral':           {'family': 'aquatic',  'profession': 'fishing',
                        'civil': False, 'rare_combat': True},
    # nông sản
    'rice':            {'family': 'crop',     'profession': 'farming',
                        'civil': True,  'rare_combat': False},
    'straw':           {'family': 'crop',     'profession': 'farming',
                        'civil': True,  'rare_combat': False},
    'crop_seed':       {'family': 'crop',     'profession': 'farming',
                        'civil': True,  'rare_combat': False},
    # muối
    'salt':            {'family': 'mineral',  'profession': 'salt_making',
                        'civil': True,  'rare_combat': False},
    'brine_crystal':   {'family': 'mineral',  'profession': 'salt_making',
                        'civil': True,  'rare_combat': False},
    # gốm
    'ceramic_clay':    {'family': 'mineral',  'profession': 'foraging',
                        'civil': True,  'rare_combat': False},
}

# ── RESOURCE TYPE — 'realm' class: vật liệu cõi Tiên Giới/Âm Phủ.
# CHƯA gắn item_id. realm_group quy định cõi nào dùng được.
REALM_RESOURCE_CATALOG = {
    # Tiên Giới (celestial)
    'celestial_crystal':       {'family': 'celestial', 'realm_group': 'celestial'},
    'cloud_silk':              {'family': 'celestial', 'realm_group': 'celestial'},
    'sacred_jade':             {'family': 'celestial', 'realm_group': 'celestial'},
    'dragon_scale_fragment':   {'family': 'celestial', 'realm_group': 'celestial'},
    'blue_jade':               {'family': 'celestial', 'realm_group': 'celestial'},
    'water_pearl':             {'family': 'celestial', 'realm_group': 'celestial'},
    # Âm Phủ (underworld)
    'soul_stone':              {'family': 'underworld', 'realm_group': 'underworld'},
    'yin_herb':                {'family': 'underworld', 'realm_group': 'underworld'},
    'underworld_ore':          {'family': 'underworld', 'realm_group': 'underworld'},
}

# ════════════════════════════════════════════════════════════════════
# ── BIOME -> RESOURCE: biome nào CHO PHÉP resource_type nào ──
# Đây là RULE (taxonomy), KHÔNG phải data. CMD_RESOURCE_DATA sau đọc
# rule này + anchor candidate để sinh node thật.
# ════════════════════════════════════════════════════════════════════
BIOME_RESOURCE_RULES = {
    # ── 22 biome thường ──
    'forest':          ['wood', 'bamboo', 'herb', 'fiber'],
    'mountain':        ['stone', 'copper_ore', 'iron_ore', 'jade_raw'],
    'cave':            ['ore', 'crystal', 'gem', 'relic_fragment'],
    'river':           ['fish', 'lotus', 'water_herb', 'river_pearl'],
    'sea':             ['fish', 'shell', 'pearl', 'coral'],
    'swamp':           ['water_herb', 'fiber', 'herb', 'fish'],
    'rice_field':      ['rice', 'straw', 'crop_seed'],
    'salt_field':      ['salt', 'brine_crystal'],
    'craft_village':   ['cloth', 'dye', 'processed_wood', 'ceramic_clay'],
    'plain':           ['herb', 'fiber', 'crop_seed'],
    'fishing_village': ['fish', 'shell', 'cloth'],
    'plantation':      ['herb', 'fiber', 'dye'],
    'wharf':           ['fish', 'processed_wood', 'cloth'],
    'garden':          ['herb', 'lotus', 'dye'],
    'scenic':          ['herb', 'lotus'],
    # biome ít/không tài nguyên farm (đô thị, quân sự) -> rỗng
    'capital':         [],
    'capital_inner':   [],
    'town':            [],
    'village':         ['fiber', 'crop_seed'],
    'citadel':         [],
    'frontier_pass':   ['stone', 'herb'],
    'battlefield':     ['relic_fragment'],
    # ── 12 biome cõi — realm resource ──
    'long_cung':       ['coral', 'water_pearl', 'dragon_scale_fragment',
                        'blue_jade'],
    'u_minh_lo':       ['soul_stone', 'yin_herb', 'underworld_ore'],
    'hoang_tuyen':     ['soul_stone', 'yin_herb', 'underworld_ore'],
    'me_cung_u_minh':  ['soul_stone', 'underworld_ore'],
    'coi_troi':        ['celestial_crystal', 'cloud_silk', 'sacred_jade'],
    'thien_dai':       ['celestial_crystal', 'sacred_jade'],
    'dong_tien':       ['celestial_crystal', 'cloud_silk'],
    'tan_vien_linh_son': ['sacred_jade', 'cloud_silk'],
    # cõi gate/hub -> không tài nguyên farm (an toàn, NPC)
    'thien_mon':       [],
    'quy_mon_quan':    [],
    'dia_phu_dien':    [],
    'vong_hon_dai':    [],
    # ── 2 biome map start — cốt truyện, không farm ──
    'bao_tang':        [],
    'co_do_hoa_lu':    [],
}

# ── ANCHOR PLACEMENT RULE — ô nào HỢP LỆ đặt resource candidate ──
# CMD_RESOURCE_SPEC tự suy từ walk_mask + portal + anchor + spawn_zone
# + safe_zone (đường (a), KHÔNG patch CMD_MAP). Đây là RULE, candidate
# THẬT do CMD_RESOURCE_DATA sinh.
RESOURCE_ANCHOR_RULES = {
    # ô đặt được: chỉ FREE (0) hoặc SLOPE (3) — walk_mask code.
    'allowed_walk_codes': [0, 3],
    'forbidden_walk_codes': [1, 2],          # BLOCK / WATER -> cấm
    # cấm đè ô đã dùng
    'forbid_on_portal_tile': True,
    'forbid_on_existing_anchor_tile': True,
    # safe_zone: chỉ cho tài nguyên dân sinh (civil), cấm rare combat
    'safe_zone_allows_only_civil': True,
    'safe_zone_forbids_rare_combat': True,
    # spawn_zone overlap: civil resource KHÔNG đặt trong spawn_zone;
    # wilderness resource CHO PHÉP overlap (chỉ ghi rule, chưa sinh data).
    'civil_resource_avoid_spawn_zone': True,
    'wilderness_resource_may_overlap_spawn_zone': True,
    # mật độ gợi ý (CMD_RESOURCE_DATA dùng) — số candidate / 100 ô free.
    'density_hint_per_100_free': {1: 2, 2: 3, 3: 4, 4: 5, 5: 6},
    # khoảng cách tối thiểu giữa 2 candidate (ô) — tránh chùm.
    'min_tile_spacing': 3,
}

# ── QUEST ITEM ANCHOR RULE — vật phẩm nhiệm vụ KHÁC resource farm ──
# quest item node CHỈ hiện khi quest cần. CMD_RESOURCE_SPEC chỉ định
# nghĩa RULE đặt; quest_id thật + gắn node do CMD_QUEST lo sau.
QUEST_ITEM_ANCHOR_RULES = {
    'allowed_walk_codes': [0, 3],
    'forbid_on_portal_tile': True,
    'forbid_on_existing_anchor_tile': True,
    'forbid_on_spawn_zone': True,            # quest item không trong vùng quái
    # interact_type cho phép (taxonomy)
    'interact_types': ['inspect', 'pickup', 'use', 'talk_object'],
    # required_state — trạng thái quest để node hiện
    'required_states': ['quest_active', 'quest_step_n', 'always'],
    # respawn_rule cho quest item
    'respawn_rules': ['per_player_once', 'per_player_repeatable',
                      'shared_timed'],
    # map_role nào hay đặt quest item: start/hub/gate ưu tiên (cốt truyện)
    'preferred_map_roles': ['start', 'hub', 'gate'],
    # ví dụ kệ sách Hoa Lư — chỉ MÔ TẢ rule, KHÔNG gắn quest_id thật:
    # quest item node ở map start (Bảo tàng/Hoa Lư) thường interact
    # 'inspect', required_state 'quest_active', respawn 'per_player_once'.
}

# ── EVENT RESOURCE RULE — tài nguyên chỉ trong event mùa ──
EVENT_RESOURCE_RULES = {
    'allowed_walk_codes': [0, 3],
    'forbid_on_portal_tile': True,
    # event types (taxonomy) — gắn lịch thật do CMD_QUEST/event lo.
    'event_types': ['seasonal', 'festival', 'limited_time'],
    # event resource KHÔNG ghi đè resource thường — node riêng, tạm thời.
    'event_resource_is_temporary': True,
    'event_resource_no_permanent_node': True,
    # biome ưu tiên event: scenic/garden (lễ hội), realm (event cõi)
    'preferred_biomes': ['scenic', 'garden', 'capital'],
    'realm_event_allowed': True,
}

# ── REBORN MATERIAL RULE — vật liệu chuyển sinh (cõi) ──
# Vật liệu chỉ thu được khi player ở trạng thái chuyển sinh, trong map
# cõi realm_access='reborn'. CHƯA gắn item_id.
REBORN_MATERIAL_RULES = {
    'allowed_walk_codes': [0, 3],
    'forbid_on_portal_tile': True,
    # chỉ map cõi (realm_group celestial/underworld) mới có reborn mat.
    'realm_group_required': ['celestial', 'underworld'],
    # realm_access của map phải là 'reborn' (CMD_PLACE field)
    'required_realm_access': 'reborn',
    # reborn material gắn theo realm_group, family 'celestial'/'underworld'
    'material_family_by_group': {
        'celestial': 'celestial',
        'underworld': 'underworld',
    },
    # reborn material KHÔNG farm lặp — gated theo cấp chuyển sinh.
    'gather_rule': 'reborn_gated',
    'reborn_tiers': ['reborn_1', 'reborn_2', 'reborn_3'],
}


# ════════════════════════════════════════════════════════════════════
# ── HẠ TẦNG — git, foundation, đọc input cross-CMD ──
# ════════════════════════════════════════════════════════════════════
def _git(args, cwd):
    """Chạy git, trả (ok, output). Lỗi không crash."""
    try:
        r = subprocess.run(['git'] + args, cwd=str(cwd),
                           capture_output=True, text=True, timeout=120)
        return r.returncode == 0, r.stdout + r.stderr
    except (subprocess.CalledProcessError,
            subprocess.TimeoutExpired, OSError) as e:
        return False, str(e)


def _sync_repo():
    """Đồng bộ REPO_DIR với origin/main.
    - chưa có  -> git clone --depth=1
    - đã có    -> git fetch origin + reset --hard origin/main
    Lỗi git -> log sạch, trả False."""
    try:
        if not REPO_DIR.exists():
            log.info(f"Repo chưa có — clone {REPO_URL}")
            subprocess.run(['git', 'clone', '--depth=1', REPO_URL,
                            str(REPO_DIR)], check=True,
                           capture_output=True, text=True, timeout=120)
        else:
            subprocess.run(['git', 'fetch', 'origin'], cwd=str(REPO_DIR),
                           check=True, capture_output=True,
                           text=True, timeout=120)
            subprocess.run(['git', 'reset', '--hard', 'origin/main'],
                           cwd=str(REPO_DIR), check=True,
                           capture_output=True, text=True, timeout=120)
        return True
    except subprocess.CalledProcessError as e:
        log.error(f"git lỗi (exit {e.returncode}): "
                  f"{(e.stderr or '').strip()[:200]}")
        return False
    except (subprocess.TimeoutExpired, OSError) as e:
        log.error(f"git thao tác repo lỗi: {e}")
        return False


def verify_foundation():
    """Đồng bộ repo rồi verify foundation hash. Lỗi -> return False."""
    global FOUNDATION_VERIFIED
    if not _sync_repo():
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
    log.info("Foundation v2.10.0 verified")
    return True


def _ver_tuple(v):
    """Parse '1.2.3' -> (1,2,3). Sai -> (0,0,0).
    LUÔN trả tuple ĐỦ 3 phần tử — pad 0 nếu thiếu. Nếu không,
    'place-v2.4' -> (2,4) < (2,4,0) sai (tuple ngắn < tuple dài
    khi prefix bằng) -> DỪNG nhầm dù version thực hợp lệ."""
    try:
        parts = [int(x) for x in str(v).split('.')[:3]]
    except (ValueError, AttributeError):
        return (0, 0, 0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


def rle_decode(rle):
    """Giải RLE walk_mask: [[code,count],...] -> [code,...]."""
    out = []
    for entry in rle:
        if not isinstance(entry, (list, tuple)) or len(entry) != 2:
            return None
        v, c = entry
        out.extend([v] * c)
    return out


def load_inputs():
    """Đọc + verify output CMD_PLACE và CMD_MAP. Verify CHẶT — lệch
    bất kỳ điều nào -> trả None (DỪNG, không build từ data sai).
    CMD_PLACE: map_registry.jsonl + .jsonl.meta sidecar.
    CMD_MAP: layout + build_manifest.json.
    Trả (place_maps, map_layouts, place_meta, map_manifest)."""
    # ── CMD_PLACE ──
    pdir = REPO_DIR / 'cmd-place' / 'output' / 'registry'
    pfp = pdir / 'map_registry.jsonl'
    # BLOCKER 2: meta đúng đường dẫn — CMD_PLACE ghi 'fp.with_suffix
    # (.jsonl.meta)' (xem write_meta), KHÔNG phải '.jsonl.meta.json'.
    pmeta_fp = pfp.with_suffix('.jsonl.meta')
    if not pfp.exists():
        log.error("Chưa có cmd-place map_registry.jsonl — chờ CMD_PLACE")
        return None
    # meta BẮT BUỘC — thiếu meta = không rõ nguồn -> DỪNG (không cho
    # place_meta = {} lọt qua).
    if not pmeta_fp.exists():
        log.error(f"Thiếu CMD_PLACE meta {pmeta_fp.name} — DỪNG")
        return None
    try:
        place_meta = json.loads(pmeta_fp.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError) as e:
        log.error(f"Đọc CMD_PLACE meta lỗi: {e}")
        return None
    # (1) foundation_hash khớp
    if place_meta.get('foundation_hash') != FOUNDATION_HASH:
        log.error(f"CMD_PLACE foundation lệch "
                  f"{place_meta.get('foundation_hash')} — DỪNG")
        return None
    # (2) schema_version startswith 'place-v'
    psv = place_meta.get('schema_version')
    if not isinstance(psv, str) or not psv.startswith('place-v'):
        log.error(f"CMD_PLACE schema_version sai: {psv!r} — DỪNG")
        return None
    # BLOCKER 1: CMD_PLACE version >= 2.4.0. Meta CMD_PLACE KHÔNG ghi
    # 'cmd_version' — lấy version từ schema_version 'place-v2.4.0'.
    pv = _ver_tuple(psv.replace('place-v', ''))
    if pv == (0, 0, 0):
        log.error(f"CMD_PLACE schema_version không parse được "
                  f"version: {psv!r} — DỪNG")
        return None
    if pv < MIN_PLACE_CMD_VERSION:
        log.error(f"CMD_PLACE version {'.'.join(map(str, pv))} "
                  f"< {'.'.join(map(str, MIN_PLACE_CMD_VERSION))} "
                  f"— PHẢI rerun CMD_PLACE bản mới — DỪNG")
        return None
    # (3) build_rule_hash tồn tại
    if not place_meta.get('build_rule_hash'):
        log.error("CMD_PLACE meta thiếu build_rule_hash — DỪNG")
        return None
    # (4) topology_version tồn tại
    if place_meta.get('topology_version') is None:
        log.error("CMD_PLACE meta thiếu topology_version — DỪNG")
        return None
    # (5) target_map_count == 10000 NẾU field tồn tại (= map thường)
    if 'target_map_count' in place_meta and \
            place_meta['target_map_count'] != 10000:
        log.error(f"CMD_PLACE target_map_count "
                  f"{place_meta['target_map_count']} != 10000 — DỪNG")
        return None
    # (6) target_region_shards == 64 NẾU field tồn tại
    if 'target_region_shards' in place_meta and \
            place_meta['target_region_shards'] != 64:
        log.error(f"CMD_PLACE target_region_shards "
                  f"{place_meta['target_region_shards']} != 64 — DỪNG")
        return None
    # (7) content_hash khớp sha256(map_registry.jsonl) — file không
    # bị sửa tay sau khi CMD_PLACE ghi meta.
    actual_hash = hashlib.sha256(pfp.read_bytes()).hexdigest()
    if place_meta.get('content_hash') != actual_hash:
        log.error("CMD_PLACE map_registry.jsonl bị sửa tay "
                  "(content_hash lệch) — DỪNG")
        return None
    # (8) đọc registry
    try:
        place_maps = [json.loads(l) for l in
                      pfp.read_text(encoding='utf-8').splitlines()
                      if l.strip()]
    except (json.JSONDecodeError, OSError) as e:
        log.error(f"Đọc CMD_PLACE registry lỗi: {e}")
        return None
    # số dòng map_registry == 10102
    if len(place_maps) != EXPECT_MAP_COUNT:
        log.error(f"CMD_PLACE có {len(place_maps)} map "
                  f"!= {EXPECT_MAP_COUNT} — DỪNG")
        return None

    # ── CMD_MAP ──
    mbase = REPO_DIR / 'cmd-map' / 'output'
    maps_dir = mbase / 'maps'
    mf_fp = mbase / 'build_manifest.json'
    if not maps_dir.exists() or not mf_fp.exists():
        log.error("Chưa có cmd-map/output — chờ CMD_MAP")
        return None
    try:
        map_manifest = json.loads(mf_fp.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError) as e:
        log.error(f"Đọc CMD_MAP manifest lỗi: {e}")
        return None
    if map_manifest.get('cmd') != 'MAP':
        log.error("manifest.cmd != 'MAP' — DỪNG")
        return None
    # CMD_MAP version >= 1.1.0
    if _ver_tuple(map_manifest.get('cmd_version')) < MIN_MAP_CMD_VERSION:
        log.error(f"CMD_MAP cmd_version {map_manifest.get('cmd_version')!r} "
                  f"< {'.'.join(map(str, MIN_MAP_CMD_VERSION))} — DỪNG")
        return None
    if map_manifest.get('foundation_hash') != FOUNDATION_HASH:
        log.error("CMD_MAP foundation lệch — rerun CMD_MAP — DỪNG")
        return None
    sc = map_manifest.get('validation_score')
    if not isinstance(sc, (int, float)) or sc < 0.95:
        log.error(f"CMD_MAP score {sc} < 0.95 — chưa freeze — DỪNG")
        return None
    if map_manifest.get('honest_gaps'):
        log.error("CMD_MAP còn honest_gaps — chưa freeze — DỪNG")
        return None
    # map_count == 10102 (chốt cứng, không chỉ so manifest)
    if map_manifest.get('map_count') != EXPECT_MAP_COUNT:
        log.error(f"CMD_MAP manifest.map_count "
                  f"{map_manifest.get('map_count')} != {EXPECT_MAP_COUNT}")
        return None
    # đọc toàn bộ layout — VỪA đọc VỪA tính output_sha256 đúng cách
    # CMD_MAP (update raw text utf-8 theo thứ tự map_id tăng dần).
    map_dirs = sorted(d for d in maps_dir.iterdir()
                      if d.is_dir() and d.name.startswith('map_')
                      and d.name[4:].isdigit())
    if len(map_dirs) != EXPECT_MAP_COUNT:
        log.error(f"CMD_MAP có {len(map_dirs)} folder map "
                  f"!= {EXPECT_MAP_COUNT} — DỪNG")
        return None
    map_layouts = []
    _agg = hashlib.sha256()
    for d in map_dirs:
        lf = d / 'map_layout.json'
        if not lf.exists():
            log.error(f"{d.name} thiếu map_layout.json — DỪNG")
            return None
        try:
            raw = lf.read_text(encoding='utf-8')
            _agg.update(raw.encode('utf-8'))   # khớp cách CMD_MAP agg
            map_layouts.append(json.loads(raw))
        except (json.JSONDecodeError, OSError) as e:
            log.error(f"{d.name} layout lỗi: {e}")
            return None
    # BLOCKER 3: verify output_sha256 — recompute từ layout đã đọc.
    # CMD_MAP artifact bị sửa tay / stale -> hash lệch -> DỪNG.
    actual_sha = _agg.hexdigest()
    raw_sha = map_manifest.get('output_sha256')
    map_sha = (raw_sha.get('map_layouts')
               if isinstance(raw_sha, dict) else raw_sha)
    if not map_sha:
        log.error("CMD_MAP manifest thiếu output_sha256 — DỪNG")
        return None
    if map_sha != actual_sha:
        log.error(f"CMD_MAP output_sha256 mismatch — artifact bị sửa "
                  f"/ stale (manifest={map_sha} actual={actual_sha}) "
                  f"— DỪNG")
        return None
    log.info(f"Input OK — CMD_PLACE {len(place_maps)} map, "
             f"CMD_MAP {len(map_layouts)} layout")
    return place_maps, map_layouts, place_meta, map_manifest


def _compute_build_rule_hash():
    """Hash mọi bảng taxonomy/rule — đổi rule thì hash đổi."""
    blob = json.dumps({
        'resource_classes': RESOURCE_CLASSES,
        'professions': PROFESSIONS,
        'resource_type_catalog': RESOURCE_TYPE_CATALOG,
        'realm_resource_catalog': REALM_RESOURCE_CATALOG,
        'biome_resource_rules': BIOME_RESOURCE_RULES,
        'resource_anchor_rules': RESOURCE_ANCHOR_RULES,
        'quest_item_anchor_rules': QUEST_ITEM_ANCHOR_RULES,
        'event_resource_rules': EVENT_RESOURCE_RULES,
        'reborn_material_rules': REBORN_MATERIAL_RULES,
        'spec_version': SPEC_VERSION,
    }, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode('utf-8')).hexdigest()


BUILD_RULE_HASH = _compute_build_rule_hash()


# ════════════════════════════════════════════════════════════════════
# ── BUILD — sinh 6 file spec/rule. CHỈ taxonomy + rule, KHÔNG data. ──
# ════════════════════════════════════════════════════════════════════
def build_resource_type_catalog():
    """File 1 — danh mục loại tài nguyên. KHÔNG có item_id."""
    types = []
    for name, info in sorted(RESOURCE_TYPE_CATALOG.items()):
        types.append({
            'resource_type': name,
            'resource_class': 'gathering',
            'family': info['family'],
            'profession_required': info['profession'],
            'civil': info['civil'],
            'rare_combat': info['rare_combat'],
        })
    for name, info in sorted(REALM_RESOURCE_CATALOG.items()):
        types.append({
            'resource_type': name,
            'resource_class': 'realm',
            'family': info['family'],
            'profession_required': None,   # realm material không gắn nghề
            'civil': False,
            'rare_combat': True,
            'realm_group': info['realm_group'],
        })
    return {
        'spec': 'resource_type_catalog',
        'spec_version': SPEC_VERSION,
        'note': 'Taxonomy loại tài nguyên — KHÔNG phải item thật. '
                'item_id do CMD_ITEM định nghĩa sau.',
        'resource_classes': RESOURCE_CLASSES,
        'professions': PROFESSIONS,
        'resource_type_count': len(types),
        'resource_types': types,
    }


def build_biome_resource_rules(place_maps):
    """File 2 — biome nào cho phép resource_type nào. Đối chiếu biome
    thực có trong CMD_PLACE để không khai báo biome thừa."""
    biomes_in_place = sorted(set(m['biome'] for m in place_maps))
    rules = []
    for biome in biomes_in_place:
        allowed = BIOME_RESOURCE_RULES.get(biome, [])
        rules.append({
            'biome': biome,
            'allowed_resource_types': list(allowed),
            'has_resource': len(allowed) > 0,
        })
    return {
        'spec': 'biome_resource_rules',
        'spec_version': SPEC_VERSION,
        'note': 'Rule: biome cho phép loại tài nguyên nào. '
                'CMD_RESOURCE_DATA dùng rule này + anchor candidate.',
        'biome_count': len(rules),
        'rules': rules,
    }


def build_resource_anchor_rules():
    """File 3 — rule suy ô hợp lệ đặt resource (đường a, tự suy từ
    walk_mask/portal/anchor/spawn_zone/safe_zone). KHÔNG sinh candidate
    thật — chỉ rule để CMD_RESOURCE_DATA áp dụng."""
    return {
        'spec': 'resource_anchor_rules',
        'spec_version': SPEC_VERSION,
        'note': 'Rule đặt resource candidate. CMD_RESOURCE_SPEC KHÔNG '
                'sinh candidate thật — CMD_RESOURCE_DATA suy candidate '
                'từ CMD_MAP layout theo rule này.',
        'derivation': 'tu_suy_tu_cmd_map_layout',
        'input_fields_used': ['walk_mask', 'portal_points',
                              'anchor_points', 'spawn_zones',
                              'safe_zone', 'biome', 'tier'],
        'rules': RESOURCE_ANCHOR_RULES,
    }


def build_quest_item_anchor_rules():
    """File 4 — rule đặt quest item node. KHÔNG gắn quest_id thật."""
    return {
        'spec': 'quest_item_anchor_rules',
        'spec_version': SPEC_VERSION,
        'note': 'Rule đặt quest item node. quest_id thật + gắn node '
                'do CMD_QUEST lo. Quest item node CHỈ hiện khi quest '
                'cần — khác resource farm lặp lại.',
        'rules': QUEST_ITEM_ANCHOR_RULES,
    }


def build_event_resource_rules():
    """File 5 — rule tài nguyên event mùa. KHÔNG gắn lịch/event_id."""
    return {
        'spec': 'event_resource_rules',
        'spec_version': SPEC_VERSION,
        'note': 'Rule tài nguyên event. event_id + lịch thật do '
                'CMD_QUEST/event lo. Event resource là node tạm thời.',
        'rules': EVENT_RESOURCE_RULES,
    }


def build_reborn_material_rules():
    """File 6 — rule vật liệu chuyển sinh (map cõi). KHÔNG item_id."""
    return {
        'spec': 'reborn_material_rules',
        'spec_version': SPEC_VERSION,
        'note': 'Rule vật liệu chuyển sinh. Chỉ map cõi '
                'realm_access=reborn. item_id thật do CMD_ITEM lo.',
        'rules': REBORN_MATERIAL_RULES,
    }


def build_schema():
    """File 7 — JSON Schema cho resource spec (CMD_ITEM/RESOURCE_DATA
    verify khi đọc). Strict — additionalProperties=False."""
    rt_names = (sorted(RESOURCE_TYPE_CATALOG.keys())
                + sorted(REALM_RESOURCE_CATALOG.keys()))
    return {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        'title': 'SVTK resource spec',
        'spec_version': SPEC_VERSION,
        'definitions': {
            'resource_type_entry': {
                'type': 'object',
                'required': ['resource_type', 'resource_class',
                             'family', 'civil', 'rare_combat'],
                'properties': {
                    'resource_type': {'type': 'string',
                                      'enum': rt_names},
                    'resource_class': {'type': 'string',
                                       'enum': RESOURCE_CLASSES},
                    'family': {'type': 'string'},
                    'profession_required': {
                        'type': ['string', 'null'],
                        'enum': PROFESSIONS + [None]},
                    'civil': {'type': 'boolean'},
                    'rare_combat': {'type': 'boolean'},
                    'realm_group': {'type': 'string',
                                    'enum': ['celestial', 'underworld']},
                },
                'additionalProperties': False,
            },
        },
    }


# ── SELF VALIDATE — kiểm taxonomy/rule nhất quán ──
def self_validate(catalog, biome_rules, place_maps):
    """Validate spec. Trả (score, [gaps]). 0 gap -> 1.0."""
    fail = {}
    # 1) mọi resource_type trong biome_rules phải có trong catalog
    cat_names = set(RESOURCE_TYPE_CATALOG) | set(REALM_RESOURCE_CATALOG)
    for biome, types in BIOME_RESOURCE_RULES.items():
        for t in types:
            if t not in cat_names:
                fail['biome_rule_type_in_catalog'] = (
                    f'{biome}:{t} không có trong catalog')
    # 2) mọi biome trong CMD_PLACE phải có entry trong BIOME_RESOURCE_RULES
    place_biomes = set(m['biome'] for m in place_maps)
    for b in place_biomes:
        if b not in BIOME_RESOURCE_RULES:
            fail['all_place_biome_has_rule'] = f'biome {b} thiếu rule'
    # 3) profession trong catalog phải thuộc PROFESSIONS
    for name, info in RESOURCE_TYPE_CATALOG.items():
        if info['profession'] not in PROFESSIONS:
            fail['profession_valid'] = f'{name}:{info["profession"]}'
    # 4) realm resource phải có realm_group hợp lệ
    for name, info in REALM_RESOURCE_CATALOG.items():
        if info['realm_group'] not in ('celestial', 'underworld'):
            fail['realm_group_valid'] = name
    # 5) anchor rule: allowed walk codes phải là FREE/SLOPE (0/3)
    if set(RESOURCE_ANCHOR_RULES['allowed_walk_codes']) != {0, 3}:
        fail['anchor_allowed_codes'] = 'phải = {0,3} (FREE/SLOPE)'
    # 6) anchor rule: forbidden phải gồm BLOCK/WATER (1/2)
    if set(RESOURCE_ANCHOR_RULES['forbidden_walk_codes']) != {1, 2}:
        fail['anchor_forbidden_codes'] = 'phải = {1,2} (BLOCK/WATER)'
    # 7) catalog không rỗng
    if not catalog['resource_types']:
        fail['catalog_not_empty'] = 'catalog rỗng'
    # 8) reborn rule: realm_group_required đúng 2 cõi
    if set(REBORN_MATERIAL_RULES['realm_group_required']) != \
            {'celestial', 'underworld'}:
        fail['reborn_realm_group'] = 'phải = celestial+underworld'
    # 9) HARD: KHÔNG có item_id/drop_table/quest_id trong mọi output
    blob = json.dumps([catalog, biome_rules,
                       build_resource_anchor_rules(),
                       build_quest_item_anchor_rules(),
                       build_event_resource_rules(),
                       build_reborn_material_rules()],
                      ensure_ascii=False).lower()
    for forbidden in ('item_id', 'drop_table', 'loot_table',
                      'npc_id', 'monster_id'):
        if f'"{forbidden}"' in blob:
            fail['no_forbidden_field'] = (
                f'output chứa field cấm: {forbidden}')
    gaps = sorted(f'{k}: {v}' for k, v in fail.items())
    score = 1.0 if not gaps else max(0.0, 1.0 - 0.1 * len(gaps))
    return score, gaps


# ════════════════════════════════════════════════════════════════════
# ── WRITE OUTPUTS — 8 file. CLEAN out_dir trước build. ──
# ════════════════════════════════════════════════════════════════════
def _write_json(path, obj):
    """Ghi JSON LF, deterministic."""
    data = json.dumps(obj, indent=2, ensure_ascii=False,
                      sort_keys=True).encode('utf-8')
    path.write_bytes(data)


def write_outputs(place_maps, map_layouts, place_meta,
                  map_manifest, out_dir):
    """Sinh 8 file spec/rule. CLEAN out_dir trước build — tránh file
    spec cũ sót lại bị hash + push theo. Trả (số file, score, [gaps])."""
    out = Path(out_dir)
    if out.exists():
        shutil.rmtree(out)            # xoá sạch output cũ — chống stale
    (out / 'spec').mkdir(parents=True, exist_ok=True)
    (out / 'schema').mkdir(parents=True, exist_ok=True)

    catalog = build_resource_type_catalog()
    biome_rules = build_biome_resource_rules(place_maps)
    anchor_rules = build_resource_anchor_rules()
    quest_rules = build_quest_item_anchor_rules()
    event_rules = build_event_resource_rules()
    reborn_rules = build_reborn_material_rules()
    schema = build_schema()

    files = {
        'spec/resource_type_catalog.json': catalog,
        'spec/biome_resource_rules.json': biome_rules,
        'spec/resource_anchor_rules.json': anchor_rules,
        'spec/quest_item_anchor_rules.json': quest_rules,
        'spec/event_resource_rules.json': event_rules,
        'spec/reborn_material_rules.json': reborn_rules,
        'schema/resource_spec.schema.json': schema,
    }
    for rel, obj in files.items():
        _write_json(out / rel, obj)

    score, gaps = self_validate(catalog, biome_rules, place_maps)

    # output_sha256 — hash 7 file spec/schema (không gồm manifest)
    agg = hashlib.sha256()
    for rel in sorted(files.keys()):
        agg.update((out / rel).read_bytes())
    output_sha256 = agg.hexdigest()

    # build_manifest.json — file 8
    manifest = {
        'cmd': CMD_NAME, 'cmd_version': CMD_VERSION,
        'schema_version': SCHEMA_VERSION,
        'spec_version': SPEC_VERSION,
        'foundation_hash': FOUNDATION_HASH,
        'build_rule_hash': BUILD_RULE_HASH,
        'source_place_count': len(place_maps),
        'source_map_count': len(map_layouts),
        'source_map_manifest_version': map_manifest.get('cmd_version'),
        'resource_type_count': catalog['resource_type_count'],
        'biome_rule_count': biome_rules['biome_count'],
        'validation_score': score,
        'honest_gaps': gaps,
        'output_sha256': output_sha256,
        'output_files': sorted(files.keys()),
        'exit_code': 0 if score >= SCORE_THRESHOLD else 1,
    }
    _write_json(out / 'build_manifest.json', manifest)
    return len(files) + 1, score, gaps


# ── PUSH — branch staging riêng, KHÔNG push main ──
def push_to_github(out_dir, score):
    """Push output qua branch staging-resource-spec-<ts>. KHÔNG merge
    main. Retry tối đa MAX_PUSH_ATTEMPTS."""
    if not REPO_DIR.exists():
        ok, out = _git(['clone', '--depth=1', REPO_URL,
                        str(REPO_DIR)], Path('/tmp'))
        if not ok:
            log.error(f"Clone repo lỗi: {out.strip()[:200]}")
            return False
    for attempt in range(MAX_PUSH_ATTEMPTS):
        ts = time.strftime('%Y%m%d-%H%M%S')
        suffix = '' if attempt == 0 else f'-r{attempt}'
        branch = f'staging-resource-spec-{ts}{suffix}'
        ok, _ = _git(['fetch', 'origin'], REPO_DIR)
        if not ok:
            time.sleep(RETRY_DELAY_SEC)
            continue
        ok, _ = _git(['switch', '-C', branch], REPO_DIR)
        if not ok:
            time.sleep(RETRY_DELAY_SEC)
            continue
        dst = REPO_DIR / 'cmd-resource-spec' / 'output'
        if dst.exists():
            shutil.rmtree(str(dst))
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(str(Path(out_dir)), str(dst))
        _git(['add', '-A'], REPO_DIR)
        _git(['commit', '-m',
              f'CMD_RESOURCE_SPEC v{CMD_VERSION} (score {score:.3f})'],
             REPO_DIR)
        ok, out = _git(['push', 'origin', branch], REPO_DIR)
        if ok:
            log.info(f"Push thành công -> branch {branch}")
            return True
        log.warning(f"Push fail lần {attempt + 1}: {out.strip()[:120]}")
        time.sleep(RETRY_DELAY_SEC)
    log.error("Push thất bại sau mọi lần retry")
    return False


def main():
    if not verify_foundation():
        return 1
    loaded = load_inputs()
    if loaded is None:
        log.error("Đọc input CMD_PLACE/CMD_MAP fail — DỪNG")
        return 1
    place_maps, map_layouts, place_meta, map_manifest = loaded
    n, score, gaps = write_outputs(place_maps, map_layouts,
                                   place_meta, map_manifest, OUTPUT_DIR)
    log.info(f"Sinh {n} file — score {score:.3f} — "
             f"gaps: {gaps or 'KHÔNG'}")
    if score < SCORE_THRESHOLD:
        log.error(f"Score {score:.3f} < {SCORE_THRESHOLD} — không push")
        return 1
    if push_to_github(str(OUTPUT_DIR), score):
        return 0
    return 1


if __name__ == '__main__':
    sys.exit(main())
