#!/usr/bin/env python3
"""CMD_ART_SPEC v1.0 — sinh đặc tả vẽ map background cho LoRA/ControlNet.
Đọc output CMD_MAP. KHÔNG sinh ảnh, KHÔNG sprite, KHÔNG train LoRA."""
import os, sys, json, time, hashlib, subprocess, logging
from pathlib import Path

# ── 1 NGUỒN — version sửa đúng 1 chỗ ──
CMD_VERSION = "1.0.0"
CMD_NAME = "ART_SPEC"
SCHEMA_VERSION = f'art-spec-v{CMD_VERSION}'
SPEC_VERSION = 1

# ── Foundation (v2.10.0 — kế thừa R1-R83, +R84-R87) ──
FOUNDATION_HASH = "cc194e6cad2225d197c4a5539352deb538c99cdd6a21845a8354260602287bbb"
FOUNDATION_FILE = "SVTK_FOUNDATION_v2.10.0.md"
FOUNDATION_VERIFIED = False

REPO_URL = "https://github.com/Trinhlong1988/svtk-status.git"
REPO_DIR = Path('/tmp/svtk-status-artspec')
OUTPUT_DIR = Path('/tmp/cmd-art-spec-out')
SCORE_THRESHOLD = 0.95
LOOP_INTERVAL_SEC = 60
MAX_PUSH_ATTEMPTS = 3
RETRY_DELAY_SEC = 10

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s [ART_SPEC] %(message)s')
log = logging.getLogger(CMD_NAME)

# ── 22 BIOME — đồng bộ CMD_MAP/CMD_PLACE ──
BIOMES = ['forest', 'mountain', 'river', 'plain', 'sea', 'swamp',
          'craft_village', 'rice_field', 'fishing_village', 'salt_field',
          'plantation', 'wharf', 'capital', 'capital_inner', 'town',
          'village', 'citadel', 'frontier_pass', 'battlefield', 'cave',
          'scenic', 'garden']

# ── 10 ERA — đồng bộ ──
ERAS = ['ly', 'tran', 'le', 'tay_son', 'nguyen',
        'f1', 'f2', 'f3', 'f4', 'f5']

# ── MÔ TẢ BIOME (tiếng Anh, cho prompt) ──
BIOME_EN = {
    'forest': 'ancient Vietnamese forest, dense bamboo and old trees',
    'mountain': 'majestic mountains, terraced slopes, mist',
    'river': 'calm river delta, wooden boats, reed banks',
    'plain': 'open lowland plain, scattered shrubs',
    'sea': 'coastal sea, fishing junks, rocky shore',
    'swamp': 'misty marshland, mangrove, still water',
    'craft_village': 'traditional craft village, workshops, tile roofs',
    'rice_field': 'wet rice paddies, dykes, water buffalo',
    'fishing_village': 'coastal fishing village, drying nets, stilt houses',
    'salt_field': 'salt evaporation fields, white mounds',
    'plantation': 'tea and mulberry plantation, ordered rows',
    'wharf': 'busy river wharf, loading docks, cargo',
    'capital': 'imperial capital, grand gates, stone roads',
    'capital_inner': 'inner palace district, ornate halls, courtyards',
    'town': 'provincial town, market streets, brick houses',
    'village': 'quiet rural village, thatched houses, banyan tree',
    'citadel': 'fortified citadel, stone ramparts, watchtowers',
    'frontier_pass': 'border mountain pass, defensive gate, cliffs',
    'battlefield': 'old battlefield, broken banners, scarred earth',
    'cave': 'dark cave dungeon, stalactites, underground stream',
    'scenic': 'famous scenic landmark, pavilions, calm water',
    'garden': 'ornamental garden, ponds, bonsai, stone path',
}

# ── ERA — phong cách kiến trúc/màu (cho prompt) ──
ERA_STYLE = {
    'ly': 'Ly dynasty 11th century, lotus motifs, warm earth tones',
    'tran': 'Tran dynasty 13th century, sturdy wood, deep red and gold',
    'le': 'Le dynasty 15th century, refined stone, blue and jade',
    'tay_son': 'Tay Son era 18th century, rugged military, ochre tones',
    'nguyen': 'Nguyen dynasty 19th century, ornate citadel, imperial yellow',
    'f1': 'legendary myth era, ethereal mist, muted ancient palette',
    'f2': 'legendary myth era, ethereal mist, muted ancient palette',
    'f3': 'legendary myth era, ethereal mist, muted ancient palette',
    'f4': 'legendary myth era, ethereal mist, muted ancient palette',
    'f5': 'legendary myth era, ethereal mist, muted ancient palette',
}

# ── FORBIDDEN STYLE — chống lạc văn hoá/thời đại (điều 7) ──
FORBIDDEN_STYLE = [
    'modern city', 'cyberpunk', 'neon', 'sci-fi', 'cars', 'guns',
    'western castle', 'japanese shrine', 'chinese palace copy',
    'gothic cathedral', 'skyscraper', 'text', 'watermark', 'UI',
    'signature', 'logo',
]

# ── MASK COLOR CONVENTION — khoá (điều 10) ──
MASK_COLORS = {
    'free':   {'code': 0, 'rgb': '#3CB043', 'meaning': 'o di duoc'},
    'block':  {'code': 1, 'rgb': '#4A4A4A', 'meaning': 'vat can'},
    'water':  {'code': 2, 'rgb': '#2E6FB0', 'meaning': 'nuoc'},
    'slope':  {'code': 3, 'rgb': '#C9A227', 'meaning': 'doc'},
    'portal': {'code': -1, 'rgb': '#E03C3C', 'meaning': 'cua di chuyen'},
    'anchor': {'code': -2, 'rgb': '#B040C0', 'meaning': 'cho NPC dung'},
    'spawn':  {'code': -3, 'rgb': '#E0902C', 'meaning': 'vung quai'},
}


def _compute_build_rule_hash():
    """Hash mọi hằng quyết định output — đổi hằng thì hash đổi."""
    blob = json.dumps({
        'biomes': BIOMES, 'eras': ERAS, 'biome_en': BIOME_EN,
        'era_style': ERA_STYLE, 'forbidden_style': FORBIDDEN_STYLE,
        'mask_colors': MASK_COLORS, 'spec_version': SPEC_VERSION,
        'schema_version': SCHEMA_VERSION,
    }, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()


BUILD_RULE_HASH = _compute_build_rule_hash()


def verify_foundation():
    """Verify foundation hash. Mismatch -> exit 99 (điều 13)."""
    if not REPO_DIR.exists():
        subprocess.run(['git', 'clone', '--depth=1', REPO_URL,
                        str(REPO_DIR)], check=True, timeout=120)
    fp = REPO_DIR / 'foundation' / FOUNDATION_FILE
    if not fp.exists():
        print(f"FOUNDATION_NOT_FOUND: {fp}")
        sys.exit(99)
    actual = hashlib.sha256(fp.read_bytes()).hexdigest()
    if actual != FOUNDATION_HASH:
        print(f"FOUNDATION_HASH_MISMATCH actual={actual}")
        sys.exit(99)
    global FOUNDATION_VERIFIED
    FOUNDATION_VERIFIED = True
    log.info("Foundation v2.10.0 verified")


# ── CROSS-CMD CONTRACT — đọc + verify output CMD_MAP (điều 3, 11) ──
def load_map_output():
    """Đọc output CMD_MAP. Verify CHẶT cross-CMD contract — lệch BẤT KỲ
    điều nào -> trả None (DỪNG). KHÔNG relax: foundation lệch / CMD_MAP
    chưa freeze (score thấp / có gap) đều phải dừng.
    Verify:
    (a) thư mục output + art_profiles + maps + schema tồn tại.
    (b) build_manifest đọc được.
    (c) manifest.cmd == 'MAP'.
    (d) manifest.foundation_hash KHỚP foundation của ART_SPEC.
        -> nếu lệch: phải rerun CMD_MAP với cùng foundation.
    (e) schema_version bắt đầu 'map-v'.
    (f) build_rule_hash + layout_version tồn tại.
    (g) validation_score >= 0.95 (CMD_MAP đã đạt ngưỡng freeze).
    (h) honest_gaps rỗng (CMD_MAP không còn lỗi treo).
    (i) output_sha256 tồn tại.
    (j) đủ art_profile_count nhóm + map_count layout.
    Trả (art_profiles, group_stats, manifest)."""
    base = REPO_DIR / 'cmd-map' / 'output'
    ap_dir = base / 'art_profiles'
    maps_dir = base / 'maps'
    mf_fp = base / 'build_manifest.json'
    sql_fp = base / 'schema' / 'map_layouts.sql'
    # (a)
    if not ap_dir.exists() or not maps_dir.exists():
        log.error("Chưa có cmd-map/output (art_profiles/maps) — chờ CMD_MAP")
        return None
    if not mf_fp.exists():
        log.error("Thiếu cmd-map build_manifest.json — chờ CMD_MAP")
        return None
    if not sql_fp.exists():
        log.error("Thiếu cmd-map schema/map_layouts.sql — CMD_MAP chưa đủ")
        return None
    # (b)
    try:
        manifest = json.loads(mf_fp.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError) as e:
        log.error(f"Đọc CMD_MAP manifest lỗi: {e}")
        return None
    # (c) đúng là output của CMD_MAP
    if manifest.get('cmd') != 'MAP':
        log.error(f"manifest.cmd = {manifest.get('cmd')} != 'MAP' — DỪNG")
        return None
    # (d) foundation KHỚP — KHÔNG relax. Lệch -> phải rerun CMD_MAP.
    if manifest.get('foundation_hash') != FOUNDATION_HASH:
        log.error(f"CMD_MAP foundation {manifest.get('foundation_hash')} "
                  f"!= ART_SPEC {FOUNDATION_HASH}. "
                  f"PHẢI rerun CMD_MAP với cùng foundation — DỪNG")
        return None
    # (e) schema_version đúng dạng map-v...
    sv = manifest.get('schema_version')
    if not isinstance(sv, str) or not sv.startswith('map-v'):
        log.error(f"CMD_MAP schema_version sai: {sv} — DỪNG")
        return None
    # (f) build_rule_hash + layout_version tồn tại
    if not manifest.get('build_rule_hash'):
        log.error("CMD_MAP manifest thiếu build_rule_hash — DỪNG")
        return None
    if manifest.get('layout_version') is None:
        log.error("CMD_MAP manifest thiếu layout_version — DỪNG")
        return None
    # (g) CMD_MAP đã đạt ngưỡng freeze
    score = manifest.get('validation_score')
    if not isinstance(score, (int, float)) or score < 0.95:
        log.error(f"CMD_MAP validation_score {score} < 0.95 — "
                  f"CMD_MAP chưa freeze — DỪNG")
        return None
    # (h) CMD_MAP không còn lỗi treo
    if manifest.get('honest_gaps'):
        log.error(f"CMD_MAP còn honest_gaps: {manifest['honest_gaps']} "
                  f"— chưa freeze — DỪNG")
        return None
    # (i) output_sha256 tồn tại
    if not manifest.get('output_sha256'):
        log.error("CMD_MAP manifest thiếu output_sha256 — DỪNG")
        return None
    # đọc art_profiles
    art_profiles = {}
    for fp in sorted(ap_dir.glob('*.json')):
        try:
            prof = json.loads(fp.read_text(encoding='utf-8'))
            art_profiles[prof['art_group']] = prof
        except (json.JSONDecodeError, KeyError, OSError) as e:
            log.error(f"art_profile {fp.name} lỗi: {e}")
            return None
    if not art_profiles:
        log.error("CMD_MAP không có art_profile nào — DỪNG")
        return None
    # (j) đủ số nhóm so manifest
    expect_ap = manifest.get('art_profile_count')
    if expect_ap is not None and len(art_profiles) != expect_ap:
        log.error(f"art_profile {len(art_profiles)} != manifest {expect_ap}")
        return None
    # đọc TOÀN BỘ layout — gom theo art_group (readability thật) +
    # tính output_sha256 ĐÚNG cách CMD_MAP (read_text, update raw utf-8,
    # duyệt map_id tăng dần — folder map_NNNNN sorted theo tên = map_id).
    group_stats = {}
    layout_count = 0
    _agg = hashlib.sha256()
    for mdir in sorted(maps_dir.iterdir()):
        lf = mdir / 'map_layout.json'
        if not lf.exists():
            continue
        try:
            raw = lf.read_text(encoding='utf-8')
            l = json.loads(raw)
        except (json.JSONDecodeError, OSError):
            continue
        _agg.update(raw.encode('utf-8'))   # khớp cách CMD_MAP agg
        layout_count += 1
        g = l.get('background', {}).get('art_group')
        if g is None:
            continue
        s = group_stats.setdefault(g, {
            'map_ids': [], 'biome': l['biome'], 'era': l['era'],
            'tier': l['tier'], 'safe_any': False, 'safe_all': True,
            'portal_total': 0, 'anchor_total': 0, 'spawn_total': 0,
        })
        s['map_ids'].append(l['map_id'])
        if l.get('safe_zone'):
            s['safe_any'] = True
        else:
            s['safe_all'] = False
        s['portal_total'] += len(l.get('portal_points', []))
        s['anchor_total'] += len(l.get('anchor_points', []))
        s['spawn_total'] += len(l.get('spawn_zones', []))
    # (j) đủ map_count
    expect_mc = manifest.get('map_count')
    if expect_mc is not None and layout_count != expect_mc:
        log.error(f"layout {layout_count} != manifest map_count {expect_mc}")
        return None
    # BUG 2 FIX: verify output_sha256 THẬT — recompute từ layout đã đọc.
    # Artifact CMD_MAP bị sửa tay -> hash lệch -> DỪNG.
    actual_sha = _agg.hexdigest()
    map_sha = manifest['output_sha256'].get('map_layouts') \
        if isinstance(manifest.get('output_sha256'), dict) \
        else manifest.get('output_sha256')
    if map_sha != actual_sha:
        log.error(f"CMD_MAP output_sha256 mismatch — artifact bị sửa "
                  f"hoặc stale (manifest={map_sha} actual={actual_sha})")
        return None
    # BUG 1 FIX: art_group khớp 2 CHIỀU. Layout có nhóm lạ không có
    # profile -> ART_SPEC bỏ sót. Profile thừa không có layout -> nhóm
    # rỗng. Cả 2 đều DỪNG.
    layout_groups = set(group_stats.keys())
    profile_groups = set(art_profiles.keys())
    if layout_groups != profile_groups:
        missing = sorted(layout_groups - profile_groups)
        unused = sorted(profile_groups - layout_groups)
        log.error(f"art_group mismatch 2 chiều — "
                  f"missing_profile={missing}, unused_profile={unused}")
        return None
    log.info(f"Đọc CMD_MAP (verified): {len(art_profiles)} nhóm, "
             f"{layout_count} layout, score {score:.2f}")
    return art_profiles, group_stats, manifest



def build_art_group_spec(group, stats):
    """Sinh spec đầy đủ cho 1 art_group. Đọc stats thật từ layout
    (portal/anchor/spawn) để mask_requirements đúng readability."""
    biome = stats['biome']
    era = stats['era']
    tier = stats['tier']
    biome_en = BIOME_EN.get(biome, biome)
    era_en = ERA_STYLE.get(era, era)

    # positive prompt — sử Việt, đường đi rõ (DNA readability, điều 6)
    positive = (
        f"2D isometric MMORPG map background, {biome_en}, "
        f"{era_en}, SVTK Vietnamese historical fantasy style, "
        f"hand-painted soft cel shading, clean readable walkable paths, "
        f"clear object separation, tier {tier} area, "
        f"top-down 3/4 view, no characters, no UI"
    )
    negative = ", ".join(FORBIDDEN_STYLE)

    # caption tokens — chuẩn hoá cho LoRA dataset (điều 9)
    caption_tokens = [
        'svtk_map', 'vietnamese_historical_fantasy',
        f'biome_{biome}', f'era_{era}', f'tier_{tier}',
        'isometric_2d_background', 'clear_walkable_path',
        'no_characters', 'hand_painted',
    ]

    # mask_requirements — đọc stats thật, ép readability
    has_portal = stats['portal_total'] > 0
    has_anchor = stats['anchor_total'] > 0
    has_spawn = stats['spawn_total'] > 0
    mask_req = {
        'walkable_area_must_match_walk_mask': True,
        'portal_tiles_must_be_visually_readable': has_portal,
        'npc_anchor_area_must_remain_clear': has_anchor,
        'spawn_zone_must_be_visually_open': has_spawn,
    }

    return {
        'art_group': group,
        'spec_version': SPEC_VERSION,
        'biome': biome, 'era': era, 'tier': tier,
        'map_count': len(stats['map_ids']),
        'safe_zone_group': stats['safe_all'],
        'camera': '2D isometric 3/4 top-down MMORPG background',
        'style': {
            'project_style': 'SVTK Vietnamese historical fantasy',
            'readability': ('TS-style readable walk paths, '
                            'clear object separation'),
            'rendering': ('soft cel shading, hand-painted 2D, '
                          'clean silhouettes'),
        },
        'positive_prompt': positive,
        'negative_prompt': negative,
        'caption_tokens': caption_tokens,
        'mask_requirements': mask_req,
        'forbidden': list(FORBIDDEN_STYLE),
    }


# ── MASK COLOR CONVENTION (điều 10) ──
def build_mask_convention():
    """Bảng màu mask cố định — LoRA/ControlNet đọc."""
    return {
        'spec_version': SPEC_VERSION,
        'description': ('Bang mau mask cho walk_mask + portal/anchor/'
                        'spawn. Moi map dung chung.'),
        'colors': MASK_COLORS,
        'rule': ('Mau mask phai khop walk_mask cua CMD_MAP. '
                 'Vung FREE/SLOPE = di duoc. Portal/anchor/spawn '
                 've theo mau quy uoc de doc.'),
    }


def build_controlnet_guide():
    """Hướng dẫn dùng mask làm ControlNet input khi vẽ map."""
    return {
        'spec_version': SPEC_VERSION,
        'controlnet_type': 'segmentation / color mask',
        'input': ('Mask anh tu walk_mask cua CMD_MAP, to mau theo '
                  'mask_color_convention.json'),
        'rule': [
            'Vung mau FREE/SLOPE -> ve duong di, mat dat thoang.',
            'Vung BLOCK -> ve vat can (tuong/da/cay lon).',
            'Vung WATER -> ve nuoc.',
            'O PORTAL -> giu thoang, de nhin thay loi ra/vao.',
            'O ANCHOR -> giu trong, KHONG ve vat che (cho NPC dung).',
            'Vung SPAWN -> giu thoang, du cho quai xuat hien.',
        ],
        'forbidden': ('KHONG ve de len o portal/anchor. '
                      'KHONG lam vung spawn bi chan.'),
    }


# ── SCHEMA — validate spec ──
def build_schema():
    """Strict JSON Schema cho art_group spec — LoRA/Mask Exporter/
    Artist pipeline đọc để validate. type/required/enum/range đầy đủ,
    additionalProperties=false (chặn field lạ)."""
    return {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        'schema_version': SCHEMA_VERSION,
        'title': 'SVTK art_group spec',
        'type': 'object',
        'additionalProperties': False,
        'required': ['art_group', 'spec_version', 'biome', 'era',
                     'tier', 'map_count', 'safe_zone_group', 'camera',
                     'style', 'positive_prompt', 'negative_prompt',
                     'caption_tokens', 'mask_requirements', 'forbidden'],
        'properties': {
            'art_group': {'type': 'string', 'minLength': 3},
            'spec_version': {'type': 'integer', 'const': SPEC_VERSION},
            'biome': {'type': 'string', 'enum': BIOMES},
            'era': {'type': 'string', 'enum': ERAS},
            'tier': {'type': 'integer', 'minimum': 1, 'maximum': 5},
            'map_count': {'type': 'integer', 'minimum': 1},
            'safe_zone_group': {'type': 'boolean'},
            'camera': {'type': 'string', 'minLength': 5},
            'style': {
                'type': 'object',
                'additionalProperties': False,
                'required': ['project_style', 'readability', 'rendering'],
                'properties': {
                    'project_style': {'type': 'string'},
                    'readability': {'type': 'string'},
                    'rendering': {'type': 'string'},
                },
            },
            'positive_prompt': {'type': 'string', 'minLength': 20},
            'negative_prompt': {'type': 'string', 'minLength': 10},
            'caption_tokens': {
                'type': 'array', 'minItems': 5,
                'items': {'type': 'string'},
            },
            'mask_requirements': {
                'type': 'object',
                'additionalProperties': False,
                'required': ['walkable_area_must_match_walk_mask',
                             'portal_tiles_must_be_visually_readable',
                             'npc_anchor_area_must_remain_clear',
                             'spawn_zone_must_be_visually_open'],
                'properties': {
                    'walkable_area_must_match_walk_mask':
                        {'type': 'boolean'},
                    'portal_tiles_must_be_visually_readable':
                        {'type': 'boolean'},
                    'npc_anchor_area_must_remain_clear':
                        {'type': 'boolean'},
                    'spawn_zone_must_be_visually_open':
                        {'type': 'boolean'},
                },
            },
            'forbidden': {
                'type': 'array', 'minItems': 10,
                'items': {'type': 'string'},
            },
        },
        'mask_convention': {
            'required_colors': list(MASK_COLORS.keys()),
        },
    }


def _schema_check(obj, schema, path='root'):
    """Validate obj theo JSON Schema (draft-07 subset) — kiểm sâu:
    type, required, enum, minimum/maximum, minItems, minLength, const,
    additionalProperties nested. Trả [] nếu hợp lệ, hoặc list lỗi.
    Tự viết — KHÔNG phụ thuộc lib jsonschema."""
    errs = []
    t = schema.get('type')
    if t == 'object':
        if not isinstance(obj, dict):
            return [f'{path}: cần object']
        for k in schema.get('required', []):
            if k not in obj:
                errs.append(f'{path}.{k}: thiếu required')
        props = schema.get('properties', {})
        if schema.get('additionalProperties') is False:
            for k in obj:
                if k not in props:
                    errs.append(f'{path}.{k}: field lạ (additionalProp=false)')
        for k, sub in props.items():
            if k in obj:
                errs += _schema_check(obj[k], sub, f'{path}.{k}')
    elif t == 'array':
        if not isinstance(obj, list):
            return [f'{path}: cần array']
        if 'minItems' in schema and len(obj) < schema['minItems']:
            errs.append(f'{path}: minItems {schema["minItems"]}')
        item_s = schema.get('items')
        if item_s:
            for i, it in enumerate(obj):
                errs += _schema_check(it, item_s, f'{path}[{i}]')
    elif t == 'string':
        if not isinstance(obj, str):
            return [f'{path}: cần string']
        if 'minLength' in schema and len(obj) < schema['minLength']:
            errs.append(f'{path}: minLength {schema["minLength"]}')
        if 'enum' in schema and obj not in schema['enum']:
            errs.append(f'{path}: ngoài enum')
    elif t == 'integer':
        if not isinstance(obj, int) or isinstance(obj, bool):
            return [f'{path}: cần integer']
        if 'minimum' in schema and obj < schema['minimum']:
            errs.append(f'{path}: < minimum')
        if 'maximum' in schema and obj > schema['maximum']:
            errs.append(f'{path}: > maximum')
    elif t == 'boolean':
        if not isinstance(obj, bool):
            return [f'{path}: cần boolean']
    if 'const' in schema and obj != schema['const']:
        errs.append(f'{path}: != const {schema["const"]}')
    return errs


def self_validate(specs, art_profiles, mask_conv, schema):
    """Verify spec — trả (score, [check fail])."""
    fail = {
        'spec_count_match': False, 'all_have_prompt': False,
        'prompt_not_empty': False, 'negative_has_forbidden': False,
        'caption_tokens_present': False, 'biome_valid': False,
        'era_valid': False, 'tier_valid': False,
        'mask_req_present': False, 'no_image_gen': False,
        'forbidden_complete': False, 'art_group_match_map': False,
        'mask_colors_complete': False, 'schema_present': False,
        'spec_match_schema': False,
    }
    map_groups = set(art_profiles.keys())
    spec_groups = set(s['art_group'] for s in specs)
    if spec_groups != map_groups:
        fail['art_group_match_map'] = True   # điều 4: không tạo nhóm mới
    if len(specs) != len(art_profiles):
        fail['spec_count_match'] = True
    for s in specs:
        if not s.get('positive_prompt') or not s.get('negative_prompt'):
            fail['all_have_prompt'] = True
        if len(s.get('positive_prompt', '')) < 20:
            fail['prompt_not_empty'] = True
        # negative phải chứa các token forbidden cốt lõi
        neg = s.get('negative_prompt', '')
        if not all(t in neg for t in ('cyberpunk', 'neon', 'sci-fi')):
            fail['negative_has_forbidden'] = True
        if not s.get('caption_tokens'):
            fail['caption_tokens_present'] = True
        if s.get('biome') not in BIOMES:
            fail['biome_valid'] = True
        if s.get('era') not in ERAS:
            fail['era_valid'] = True
        tv = s.get('tier')
        if not isinstance(tv, int) or isinstance(tv, bool) \
                or not (1 <= tv <= 5):
            fail['tier_valid'] = True
        if not isinstance(s.get('mask_requirements'), dict):
            fail['mask_req_present'] = True
        if set(s.get('forbidden', [])) != set(FORBIDDEN_STYLE):
            fail['forbidden_complete'] = True
        # điều 1: spec KHÔNG được chứa field sinh ảnh
        if any(k in s for k in ('image_data', 'image_url', 'png',
                                'pixels', 'lora_weights')):
            fail['no_image_gen'] = True
    # mask convention đủ 7 màu
    if set(mask_conv.get('colors', {}).keys()) != set(MASK_COLORS.keys()):
        fail['mask_colors_complete'] = True
    if not schema or schema.get('type') != 'object' \
            or 'properties' not in schema \
            or schema.get('additionalProperties') is not False:
        fail['schema_present'] = True
    else:
        # validate THẬT từng spec theo strict JSON Schema (sâu)
        for s in specs:
            if _schema_check(s, schema):
                fail['spec_match_schema'] = True
                break

    checks = [('foundation_verified', FOUNDATION_VERIFIED)]
    for name, bad in fail.items():
        checks.append((name, not bad))
    passed = sum(1 for _, ok in checks if ok)
    return passed / len(checks), [c for c, ok in checks if not ok]


# ── WRITE OUTPUT ──
def write_outputs(art_profiles, group_stats, map_manifest, out_dir):
    """Sinh toàn bộ spec + ghi file. Trả (số spec, score, [fail])."""
    out = Path(out_dir)
    for sub in ('art_groups', 'prompts', 'captions', 'masks',
                'schema', 'tests', 'status'):
        (out / sub).mkdir(parents=True, exist_ok=True)

    # sinh spec từng art_group
    specs = []
    for g in sorted(art_profiles.keys()):
        spec = build_art_group_spec(g, group_stats[g])
        specs.append(spec)
        (out / 'art_groups' / f'{g}.json').write_text(
            json.dumps(spec, indent=2, ensure_ascii=False),
            encoding='utf-8')

    # prompts jsonl — 1 dòng / nhóm
    with open(out / 'prompts' / 'map_background_prompts.jsonl', 'w',
              encoding='utf-8') as f:
        for s in specs:
            f.write(json.dumps({
                'art_group': s['art_group'],
                'positive_prompt': s['positive_prompt'],
                'negative_prompt': s['negative_prompt'],
            }, ensure_ascii=False) + '\n')

    # captions jsonl — LoRA dataset
    with open(out / 'captions' / 'lora_caption_profiles.jsonl', 'w',
              encoding='utf-8') as f:
        for s in specs:
            f.write(json.dumps({
                'art_group': s['art_group'],
                'caption': ', '.join(s['caption_tokens']),
                'caption_tokens': s['caption_tokens'],
            }, ensure_ascii=False) + '\n')

    # masks
    mask_conv = build_mask_convention()
    (out / 'masks' / 'mask_color_convention.json').write_text(
        json.dumps(mask_conv, indent=2, ensure_ascii=False),
        encoding='utf-8')
    (out / 'masks' / 'controlnet_mask_guide.json').write_text(
        json.dumps(build_controlnet_guide(), indent=2, ensure_ascii=False),
        encoding='utf-8')

    # schema
    schema = build_schema()
    (out / 'schema' / 'art_spec.schema.json').write_text(
        json.dumps(schema, indent=2, ensure_ascii=False),
        encoding='utf-8')

    # test ngoài
    (out / 'tests' / 'art_spec_tests.py').write_text(
        TEST_CODE, encoding='utf-8')

    # validate
    score, fails = self_validate(specs, art_profiles, mask_conv, schema)

    # output_sha256 — hash gộp toàn bộ output chính (forensic/rebuild).
    # Duyệt file theo thứ tự cố định -> hash deterministic.
    _agg = hashlib.sha256()
    for sub in ('art_groups', 'prompts', 'captions', 'masks', 'schema'):
        for fp in sorted((out / sub).rglob('*')):
            if fp.is_file():
                _agg.update(fp.read_bytes())
    output_sha256 = _agg.hexdigest()

    # build_manifest
    manifest = {
        'cmd': CMD_NAME, 'cmd_version': CMD_VERSION,
        'schema_version': SCHEMA_VERSION,
        'foundation_hash': FOUNDATION_HASH,
        'build_rule_hash': BUILD_RULE_HASH,
        'spec_version': SPEC_VERSION,
        'source_map_foundation': map_manifest.get('foundation_hash'),
        'source_map_count': map_manifest.get('map_count'),
        'art_group_count': len(specs),
        'validation_score': score,
        'honest_gaps': fails,
        'output_sha256': output_sha256,
    }
    (out / 'build_manifest.json').write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding='utf-8')
    # status file — forensic, LEAD đọc duyệt (constitution điều output)
    ts = time.strftime('%Y%m%d-%H%M%S')
    status = {
        'cmd': CMD_NAME, 'cmd_version': CMD_VERSION,
        'schema_version': SCHEMA_VERSION, 'timestamp': ts,
        'validation_score': score, 'honest_gaps': fails,
        'exit_code': 0 if score >= SCORE_THRESHOLD else 1,
    }
    (out / 'status' / f'status-{ts}.json').write_text(
        json.dumps(status, indent=2, ensure_ascii=False),
        encoding='utf-8')
    return len(specs), score, fails


# ── TEST_CODE — file test ngoài (CI) ──
TEST_CODE = '''# CMD_ART_SPEC v1.0 — test ngoai (doc art_groups/ + masks/)
import json, sys
from pathlib import Path
OUT = Path(__file__).parent.parent

_CACHE = None

def _specs():
    """Doc moi art_group spec 1 LAN, cache."""
    global _CACHE
    if _CACHE is None:
        _CACHE = []
        for fp in sorted((OUT / "art_groups").glob("*.json")):
            _CACHE.append(json.loads(fp.read_text(encoding="utf-8")))
    return _CACHE

def test_01_has_specs():
    assert len(_specs()) > 0, "khong co spec nao"

def test_02_required_fields():
    need = {"art_group", "spec_version", "biome", "era", "tier",
            "camera", "style", "positive_prompt", "negative_prompt",
            "caption_tokens", "mask_requirements", "forbidden"}
    for s in _specs():
        assert need <= set(s.keys()), f"thieu field: {s.get('art_group')}"

def test_03_prompt_not_empty():
    for s in _specs():
        assert len(s["positive_prompt"]) >= 20
        assert len(s["negative_prompt"]) >= 10

def test_04_negative_has_forbidden():
    for s in _specs():
        neg = s["negative_prompt"]
        for t in ("cyberpunk", "neon", "sci-fi"):
            assert t in neg, f"negative thieu '{t}': {s['art_group']}"

def test_05_caption_tokens():
    for s in _specs():
        assert s["caption_tokens"], f"thieu caption: {s['art_group']}"
        assert "svtk_map" in s["caption_tokens"]

def test_06_no_image_data():
    # CMD_ART_SPEC KHONG sinh anh
    ban = ("image_data", "image_url", "png", "pixels", "lora_weights")
    for s in _specs():
        for k in ban:
            assert k not in s, f"spec lan anh '{k}': {s['art_group']}"

def test_07_tier_range():
    for s in _specs():
        assert 1 <= s["tier"] <= 5, f"tier sai: {s['art_group']}"

def test_08_art_group_unique():
    gs = [s["art_group"] for s in _specs()]
    assert len(gs) == len(set(gs)), "art_group trung"

def test_09_mask_convention():
    mc = json.loads((OUT / "masks" / "mask_color_convention.json")
                    .read_text(encoding="utf-8"))
    need = {"free", "block", "water", "slope", "portal", "anchor", "spawn"}
    assert set(mc["colors"].keys()) == need, "mask thieu mau"

def test_10_controlnet_guide():
    cg = json.loads((OUT / "masks" / "controlnet_mask_guide.json")
                    .read_text(encoding="utf-8"))
    assert "rule" in cg and len(cg["rule"]) > 0

def test_11_prompts_jsonl():
    fp = OUT / "prompts" / "map_background_prompts.jsonl"
    lines = [l for l in fp.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert len(lines) == len(_specs()), "prompt jsonl lech so spec"

def test_12_captions_jsonl():
    fp = OUT / "captions" / "lora_caption_profiles.jsonl"
    lines = [l for l in fp.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert len(lines) == len(_specs()), "caption jsonl lech so spec"

def test_13_schema_strict():
    sc = json.loads((OUT / "schema" / "art_spec.schema.json")
                    .read_text(encoding="utf-8"))
    assert sc.get("type") == "object"
    assert sc.get("additionalProperties") is False
    assert "required" in sc and "properties" in sc
    # spec khop schema: du required, khong field la
    req = set(sc["required"])
    allowed = set(sc["properties"].keys())
    for s in _specs():
        assert req <= set(s.keys()), f"thieu required: {s['art_group']}"
        assert not (set(s.keys()) - allowed), f"field la: {s['art_group']}"

def test_14_status_file():
    fps = list((OUT / "status").glob("status-*.json"))
    assert len(fps) >= 1, "thieu status file"
    st = json.loads(fps[-1].read_text(encoding="utf-8"))
    for k in ("cmd", "cmd_version", "schema_version", "timestamp",
              "validation_score", "honest_gaps", "exit_code"):
        assert k in st, f"status thieu {k}"

def test_15_manifest_output_sha():
    mf = json.loads((OUT / "build_manifest.json").read_text(encoding="utf-8"))
    assert mf.get("output_sha256"), "manifest thieu output_sha256"
    assert len(mf["output_sha256"]) == 64, "output_sha256 sai do dai"

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


# ── GIT PUSH — branch staging (LEAD duyệt + merge) ──
def _git(args, cwd):
    try:
        r = subprocess.run(['git'] + args, cwd=str(cwd),
                           capture_output=True, text=True, timeout=120)
        return r.returncode == 0, r.stdout + r.stderr
    except (subprocess.TimeoutExpired, OSError) as e:
        return False, str(e)


def push_to_github(out_dir, score, fails):
    """Push output lên branch staging. KHÔNG merge main — LEAD duyệt."""
    if not REPO_DIR.exists():
        ok, _ = _git(['clone', REPO_URL, str(REPO_DIR)], Path('/tmp'))
        if not ok:
            log.error("Clone repo lỗi")
            return False
    ts = time.strftime('%Y%m%d-%H%M%S')
    for attempt in range(MAX_PUSH_ATTEMPTS):
        branch = f"staging-art-spec-{ts}" + (f"-r{attempt}" if attempt else "")
        try:
            _git(['fetch', 'origin'], REPO_DIR)
            _git(['switch', '-C', branch], REPO_DIR)
            dst = REPO_DIR / 'cmd-art-spec' / 'output'
            if dst.exists():
                import shutil
                shutil.rmtree(str(dst))
            import shutil
            shutil.copytree(str(out_dir), str(dst))
            git_email = os.getenv("GIT_EMAIL", "cmd-art-spec-bot@svtk.local")
            git_name = os.getenv("GIT_NAME", "CMD_ART_SPEC_BOT")
            _git(['config', 'user.email', git_email], REPO_DIR)
            _git(['config', 'user.name', git_name], REPO_DIR)
            _git(['add', '-A'], REPO_DIR)
            has_change = subprocess.run(
                ['git', '-C', str(REPO_DIR), 'diff', '--cached', '--quiet']
            ).returncode != 0
            if has_change:
                _git(['commit', '-m',
                      f'CMD_ART_SPEC v{CMD_VERSION} ts={ts} '
                      f'score={score:.2f}'], REPO_DIR)
            ok, out = _git(['push', 'origin', branch], REPO_DIR)
            if ok:
                log.info(f"Pushed: {branch}")
                return True
            log.warning(f"Push attempt {attempt+1} fail: {out[:80]}")
        except Exception as e:
            log.warning(f"Push attempt {attempt+1} lỗi: {e}")
        time.sleep(RETRY_DELAY_SEC)
    return False


def main_loop():
    """Vòng đời: verify foundation -> đọc CMD_MAP -> sinh spec ->
    validate -> push staging."""
    if not verify_foundation():
        return 1
    loaded = load_map_output()
    if loaded is None:
        log.error("Đọc CMD_MAP fail — DỪNG")
        return 1
    art_profiles, group_stats, map_manifest = loaded
    n, score, fails = write_outputs(art_profiles, group_stats,
                                    map_manifest, OUTPUT_DIR)
    log.info(f"Sinh {n} spec — score {score:.3f} — "
             f"gaps: {fails or 'KHÔNG'}")
    if score < SCORE_THRESHOLD:
        log.error(f"Score {score:.3f} < {SCORE_THRESHOLD} — không push")
        return 1
    if push_to_github(str(OUTPUT_DIR), score, fails):
        return 0
    return 1


if __name__ == '__main__':
    sys.exit(main_loop())
