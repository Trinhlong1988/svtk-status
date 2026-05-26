#!/usr/bin/env python3
"""TOOL_MASK_EXPORTER v1.0 — render dữ liệu mask CMD_MAP thành PNG.
Tool phụ trợ ART pipeline. KHÔNG sinh map background, KHÔNG sprite,
KHÔNG train LoRA, KHÔNG sửa CMD_MAP."""
import os, sys, re, json, time, hashlib, subprocess, logging
from pathlib import Path

CMD_VERSION = "1.0.1"
TOOL_NAME = "MASK_EXPORTER"
SCHEMA_VERSION = f'mask-export-v{CMD_VERSION}'

# ── Foundation v2.10.0 ──
FOUNDATION_HASH = "cc194e6cad2225d197c4a5539352deb538c99cdd6a21845a8354260602287bbb"
FOUNDATION_FILE = "SVTK_FOUNDATION_v2.10.0.md"
FOUNDATION_VERIFIED = False

REPO_URL = "https://github.com/Trinhlong1988/svtk-status.git"
REPO_DIR = Path('/tmp/svtk-status-maskexp')
OUTPUT_DIR = Path('/tmp/tool-mask-exporter-out')
SCORE_THRESHOLD = 0.95
MAX_PUSH_ATTEMPTS = 3
RETRY_DELAY_SEC = 10

# ── CHẾ ĐỘ ──
MODE = os.getenv('MASK_MODE', 'sample')      # sample | batch | full
SAMPLE_RAW = os.getenv('MASK_SAMPLE', '20')  # validate sau, không crash import
BATCH_IDS = os.getenv('MASK_BATCH_IDS', '')  # "1,5,99" cho batch mode


def _parse_sample_count():
    """Parse MASK_SAMPLE an toàn. Trả int>0 hoặc None (sai)."""
    s = SAMPLE_RAW.strip()
    if not s.isdigit():        # loại 'abc', '-1', '', '1.5'
        return None
    n = int(s)
    return n if n > 0 else None

# ── CANVAS — khoá theo project: master 1920×1080 (16:9), full màn.
# Game render 1 tấm liền 1920×1080. Mask của tool: source grid CMD_MAP
# là 4:3 -> letterbox vào canvas 16:9, GIỮ tỉ lệ (pad đen 2 bên), khung
# map thật ghi ở content_rect trong meta. walk_mask scale theo. ──
CANVAS_W = 1920
CANVAS_H = 1080

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s [MASK_EXP] %(message)s')
log = logging.getLogger(TOOL_NAME)

# ── walk_mask 4 trạng thái (đồng bộ CMD_MAP) ──
WALK_FREE, WALK_BLOCK, WALK_WATER, WALK_SLOPE = 0, 1, 2, 3

# ── grid hợp lệ — đồng bộ CMD_MAP (4:3) ──
VALID_GRIDS = {(32, 24), (40, 30), (48, 36), (56, 42), (64, 48)}

# ── MÀU MẶC ĐỊNH — fallback nếu chưa đọc được ART_SPEC convention ──
DEFAULT_COLORS = {
    'free':   '#3CB043', 'block':  '#4A4A4A', 'water':  '#2E6FB0',
    'slope':  '#C9A227', 'portal': '#E03C3C', 'anchor': '#B040C0',
    'spawn':  '#E0902C',
}


def _compute_build_rule_hash():
    blob = json.dumps({
        'canvas': [CANVAS_W, CANVAS_H], 'schema_version': SCHEMA_VERSION,
        'default_colors': DEFAULT_COLORS,
        'valid_grids': sorted(list(VALID_GRIDS)),
    }, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()


BUILD_RULE_HASH = _compute_build_rule_hash()


_HEX_RE = re.compile(r'^#[0-9A-Fa-f]{6}$')


def _hex_to_rgb(h):
    """'#RRGGBB' STRICT -> (r,g,b). Phải đúng dấu # + 6 hex digit.
    '123456' / '#12345' / '#1234567' -> ValueError."""
    if not isinstance(h, str) or not _HEX_RE.match(h):
        raise ValueError(f"màu sai định dạng (cần #RRGGBB): {h!r}")
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16))


def verify_foundation():
    """Verify foundation hash. Mismatch -> exit 99 (điều 12).
    Git lỗi (mất mạng / repo lock / fetch fail) -> exit 98, log sạch."""
    try:
        if not REPO_DIR.exists():
            subprocess.run(['git', 'clone', '--depth=1', REPO_URL,
                            str(REPO_DIR)], check=True, timeout=120)
        else:
            # repo đã có sẵn trong /tmp -> sync về origin/main, tránh đọc
            # bản stale từ lần chạy trước.
            subprocess.run(['git', '-C', str(REPO_DIR), 'fetch', 'origin'],
                           check=True, timeout=120)
            subprocess.run(['git', '-C', str(REPO_DIR), 'reset', '--hard',
                            'origin/main'], check=True, timeout=60)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired,
            OSError) as e:
        log.error(f"Git sync lỗi (mất mạng / repo lock / fetch fail): {e}")
        sys.exit(98)
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


def rle_decode(rle):
    """RLE [[value,count],...] -> list phẳng. CANONICAL strict:
    mỗi entry list/tuple len 2; value int thật (không bool) ∈ {0,1,2,3};
    count int thật (không bool) > 0. Sai -> ValueError."""
    if not isinstance(rle, list):
        raise ValueError("RLE không phải list")
    out = []
    for i, entry in enumerate(rle):
        if not isinstance(entry, (list, tuple)) or len(entry) != 2:
            raise ValueError(f"RLE entry #{i} không phải [value,count]")
        v, c = entry
        # bool là subclass của int -> loại riêng
        if isinstance(v, bool) or not isinstance(v, int):
            raise ValueError(f"RLE entry #{i} value không phải int: {v!r}")
        if v not in (0, 1, 2, 3):
            raise ValueError(f"RLE entry #{i} value {v} ngoài {{0,1,2,3}}")
        if isinstance(c, bool) or not isinstance(c, int):
            raise ValueError(f"RLE entry #{i} count không phải int: {c!r}")
        if c <= 0:
            raise ValueError(f"RLE entry #{i} count {c} <= 0")
        out.extend([v] * c)
    return out


# ── ĐỌC MÀU TỪ CMD_ART_SPEC (điều 8) ──
def load_mask_colors(allow_default=False):
    """Đọc mask_color_convention.json của CMD_ART_SPEC. BẮT BUỘC —
    production phải có file này, đủ 7 màu free/block/water/slope/portal/
    anchor/spawn. Thiếu / JSON lỗi / thiếu màu -> trả None (DỪNG).
    allow_default=True CHỈ cho unit test — fallback DEFAULT_COLORS."""
    fp = (REPO_DIR / 'cmd-art-spec' / 'output' / 'masks'
          / 'mask_color_convention.json')
    NEED = ('free', 'block', 'water', 'slope', 'portal', 'anchor', 'spawn')
    # BUG 3 FIX: verify ART_SPEC đã freeze TRƯỚC khi tin màu của nó
    mf_fp = REPO_DIR / 'cmd-art-spec' / 'output' / 'build_manifest.json'
    if not fp.exists():
        if allow_default:
            log.warning("[TEST] Chưa có ART_SPEC convention — DEFAULT_COLORS")
            return dict(DEFAULT_COLORS), False
        log.error("Thiếu cmd-art-spec mask_color_convention.json — "
                  "chạy CMD_ART_SPEC trước — DỪNG")
        return None
    if not allow_default:
        if not mf_fp.exists():
            log.error("Thiếu cmd-art-spec build_manifest.json — DỪNG")
            return None
        try:
            amf = json.loads(mf_fp.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError) as e:
            log.error(f"ART_SPEC manifest lỗi: {e} — DỪNG")
            return None
        if amf.get('cmd') != 'ART_SPEC':
            log.error(f"ART_SPEC manifest.cmd != 'ART_SPEC' — DỪNG")
            return None
        if amf.get('foundation_hash') != FOUNDATION_HASH:
            log.error("ART_SPEC foundation lệch — DỪNG")
            return None
        asc = amf.get('validation_score')
        if not isinstance(asc, (int, float)) or asc < 0.95:
            log.error(f"ART_SPEC score {asc} < 0.95 — chưa freeze — DỪNG")
            return None
        if amf.get('honest_gaps'):
            log.error("ART_SPEC còn honest_gaps — chưa freeze — DỪNG")
            return None
        if not amf.get('output_sha256'):
            log.error("ART_SPEC manifest thiếu output_sha256 — DỪNG")
            return None
        # recompute output_sha256 THẬT — đúng cách CMD_ART_SPEC:
        # duyệt 5 thư mục theo sorted(rglob), read_bytes. Mismatch =
        # ART_SPEC artifact bị sửa/stale -> DỪNG.
        as_out = REPO_DIR / 'cmd-art-spec' / 'output'
        # check từng thư mục tồn tại — báo lỗi rõ ràng, không để lẫn
        # vào 'output_sha256 mismatch' khó hiểu.
        for sub in ('art_groups', 'prompts', 'captions', 'masks',
                    'schema'):
            if not (as_out / sub).exists():
                log.error(f"ART_SPEC thiếu output/{sub} — DỪNG")
                return None
        _as_agg = hashlib.sha256()
        for sub in ('art_groups', 'prompts', 'captions', 'masks', 'schema'):
            for f in sorted((as_out / sub).rglob('*')):
                if f.is_file():
                    _as_agg.update(f.read_bytes())
        as_actual = _as_agg.hexdigest()
        if amf['output_sha256'] != as_actual:
            log.error(f"ART_SPEC output_sha256 mismatch — artifact bị "
                      f"sửa/stale (manifest={amf['output_sha256']} "
                      f"actual={as_actual}) — DỪNG")
            return None
    try:
        conv = json.loads(fp.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError) as e:
        log.error(f"ART_SPEC convention JSON lỗi: {e} — DỪNG")
        return None
    colors = conv.get('colors', {})
    out = {}
    for k in NEED:
        if k not in colors or 'rgb' not in colors[k]:
            log.error(f"ART_SPEC convention thiếu màu '{k}' — DỪNG")
            return None
        rgb = colors[k]['rgb']
        # màu phải hợp lệ '#RRGGBB'
        try:
            _hex_to_rgb(rgb)
        except (ValueError, IndexError):
            log.error(f"ART_SPEC convention màu '{k}' sai: {rgb} — DỪNG")
            return None
        out[k] = rgb
    log.info("Dùng màu từ ART_SPEC convention (verified)")
    return out, True


def _walk_mask_valid(layout):
    """Verify walk_mask 1 layout: decode đúng grid_w*grid_h ô, mọi value
    thuộc {0,1,2,3}. Input bất kỳ -> STOP sạch, KHÔNG crash."""
    if not isinstance(layout, dict):
        return False, f'layout không phải dict: {type(layout).__name__}'
    wm = layout.get('walk_mask')
    if not isinstance(wm, dict) or 'data' not in wm:
        return False, 'thiếu walk_mask.data'
    try:
        dec = rle_decode(wm['data'])
    except (TypeError, ValueError) as e:
        return False, f'RLE hỏng: {e}'
    gw, gh = layout.get('grid_w'), layout.get('grid_h')
    if (not isinstance(gw, int) or isinstance(gw, bool)
            or not isinstance(gh, int) or isinstance(gh, bool)):
        return False, 'grid_w/grid_h sai'
    if len(dec) != gw * gh:
        return False, f'RLE giải nén {len(dec)} ô != grid {gw}x{gh}={gw*gh}'
    for v in dec:
        if v not in (WALK_FREE, WALK_BLOCK, WALK_WATER, WALK_SLOPE):
            return False, f'value {v} ngoài {{0,1,2,3}}'
    return True, ''


def _geometry_valid(layout):
    """Verify portal/anchor/spawn nằm trong grid — forensic, KHÔNG
    clamp im lặng. Input bất kỳ (kể cả thiếu field / sai kiểu) ->
    STOP sạch, KHÔNG crash."""
    if not isinstance(layout, dict):
        return False, f'layout không phải dict: {type(layout).__name__}'
    gw, gh = layout.get('grid_w'), layout.get('grid_h')
    if (not isinstance(gw, int) or isinstance(gw, bool)
            or not isinstance(gh, int) or isinstance(gh, bool)):
        return False, f'grid_w/grid_h thiếu/sai kiểu: {gw!r}x{gh!r}'
    if gw <= 0 or gh <= 0:
        return False, f'grid_w/grid_h <= 0: {gw}x{gh}'
    portals = layout.get('portal_points', [])
    if not isinstance(portals, list):
        return False, f'portal_points không phải list: {type(portals).__name__}'
    for p in portals:
        if not isinstance(p, dict):
            return False, f'portal item không phải dict: {p!r}'
        x, y = p.get('tile_x'), p.get('tile_y')
        if (not isinstance(x, int) or isinstance(x, bool)
                or not isinstance(y, int) or isinstance(y, bool)
                or not (0 <= x < gw and 0 <= y < gh)):
            return False, f'portal tile sai/ngoài grid: ({x!r},{y!r}) grid {gw}x{gh}'
    anchors = layout.get('anchor_points', [])
    if not isinstance(anchors, list):
        return False, f'anchor_points không phải list: {type(anchors).__name__}'
    for a in anchors:
        if not isinstance(a, dict):
            return False, f'anchor item không phải dict: {a!r}'
        x, y = a.get('tile_x'), a.get('tile_y')
        if (not isinstance(x, int) or isinstance(x, bool)
                or not isinstance(y, int) or isinstance(y, bool)
                or not (0 <= x < gw and 0 <= y < gh)):
            return False, f'anchor tile sai/ngoài grid: ({x!r},{y!r}) grid {gw}x{gh}'
    spawns = layout.get('spawn_zones', [])
    if not isinstance(spawns, list):
        return False, f'spawn_zones không phải list: {type(spawns).__name__}'
    for z in spawns:
        if not isinstance(z, dict):
            return False, f'spawn item không phải dict: {z!r}'
        b = z.get('bounds')
        if not isinstance(b, dict):
            return False, 'spawn bounds không phải dict'
        bx, by = b.get('x'), b.get('y')
        bw, bh = b.get('w'), b.get('h')
        if not all(isinstance(v, int) and not isinstance(v, bool)
                   for v in (bx, by, bw, bh)):
            return False, 'spawn bounds thiếu/sai kiểu'
        if bx < 0 or by < 0 or bw <= 0 or bh <= 0:
            return False, f'spawn bounds sai: x{bx} y{by} w{bw} h{bh}'
        if bx + bw > gw or by + bh > gh:
            return False, (f'spawn vượt grid: ({bx}+{bw},{by}+{bh}) '
                           f'> {gw}x{gh}')
    return True, ''


def _required_fields_ok(layout):
    """Verify layout có đủ trường bắt buộc + đúng kiểu cơ bản, để
    export_one_map không crash giữa chừng. Input bất kỳ -> STOP sạch."""
    if not isinstance(layout, dict):
        return False, f'layout không phải dict: {type(layout).__name__}'
    REQ = ('map_id', 'uuid', 'grid_w', 'grid_h', 'walk_mask',
           'portal_points', 'anchor_points', 'spawn_zones', 'safe_zone',
           'background', 'layout_hash')
    for k in REQ:
        if k not in layout:
            return False, f'thiếu trường {k}'
    if not isinstance(layout['map_id'], int) or isinstance(layout['map_id'], bool):
        return False, 'map_id không phải int'
    if not isinstance(layout['uuid'], str) or not layout['uuid']:
        return False, 'uuid rỗng/sai kiểu'
    gw, gh = layout['grid_w'], layout['grid_h']
    if (not isinstance(gw, int) or isinstance(gw, bool)
            or not isinstance(gh, int) or isinstance(gh, bool)):
        return False, 'grid_w/grid_h không phải int'
    if gw <= 0 or gh <= 0:
        return False, f'grid_w/grid_h <= 0: {gw}x{gh}'
    if (gw, gh) not in VALID_GRIDS:
        return False, (f'grid {gw}x{gh} không thuộc VALID_GRIDS '
                       f'{sorted(VALID_GRIDS)}')
    wm = layout['walk_mask']
    if not isinstance(wm, dict) or 'data' not in wm:
        return False, 'walk_mask thiếu data'
    for k in ('portal_points', 'anchor_points', 'spawn_zones'):
        if not isinstance(layout[k], list):
            return False, f'{k} không phải list'
    bg = layout['background']
    if not isinstance(bg, dict) or not bg.get('art_group'):
        return False, 'background.art_group thiếu'
    if not isinstance(layout['safe_zone'], bool):
        return False, f"safe_zone không phải bool: {layout['safe_zone']!r}"
    lh = layout['layout_hash']
    if not isinstance(lh, str) or not lh:
        return False, 'layout_hash rỗng/không phải string'
    return True, ''


# ── ĐỌC OUTPUT CMD_MAP — verify contract (điều 2, 10) ──
def load_map_layouts():
    """Đọc map_layout.json theo MODE. Verify CMD_MAP manifest chặt.
    Trả (list layout, map_manifest) hoặc None."""
    base = REPO_DIR / 'cmd-map' / 'output'
    maps_dir = base / 'maps'
    mf_fp = base / 'build_manifest.json'
    if not maps_dir.exists() or not mf_fp.exists():
        log.error("Chưa có cmd-map/output — chờ CMD_MAP")
        return None
    try:
        manifest = json.loads(mf_fp.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError) as e:
        log.error(f"Đọc CMD_MAP manifest lỗi: {e}")
        return None
    # verify contract — CMD_MAP đã freeze
    if manifest.get('cmd') != 'MAP':
        log.error(f"manifest.cmd != 'MAP' — DỪNG")
        return None
    if manifest.get('foundation_hash') != FOUNDATION_HASH:
        log.error("CMD_MAP foundation lệch — rerun CMD_MAP — DỪNG")
        return None
    score = manifest.get('validation_score')
    if not isinstance(score, (int, float)) or score < 0.95:
        log.error(f"CMD_MAP score {score} < 0.95 — chưa freeze — DỪNG")
        return None
    if manifest.get('honest_gaps'):
        log.error("CMD_MAP còn honest_gaps — chưa freeze — DỪNG")
        return None

    # ── VERIFY CMD_MAP output_sha256 — MỌI mode (sample/batch/full) ──
    # Hash tính từ TOÀN BỘ map_layout.json, không phụ thuộc render bao
    # nhiêu map. Artifact CMD_MAP bị sửa/stale -> DỪNG, không render từ
    # dữ liệu bẩn dù chỉ vẽ thử 20 map.
    # ── map_dirs HỢP LỆ — is_dir + tên map_NNNNN (NNNNN toàn digit) ──
    map_dirs = []
    for d in sorted(maps_dir.iterdir()):
        if not d.is_dir() or not d.name.startswith('map_'):
            continue
        if d.name[4:].isdigit():
            map_dirs.append(d)
        else:
            # folder map_* tên sai định dạng — nếu chứa layout thì đây
            # là artifact bẩn, KHÔNG được lặng lẽ bỏ qua.
            if (d / 'map_layout.json').exists():
                log.error(f"folder '{d.name}' tên map_* sai định dạng "
                          f"nhưng có map_layout.json — artifact bẩn — DỪNG")
                return None
    if not map_dirs:
        log.error("Không có folder map_NNNNN hợp lệ — DỪNG")
        return None
    # all_layout_files DẪN XUẤT từ map_dirs — không glob độc lập.
    all_layout_files = [d / 'map_layout.json' for d in map_dirs]
    for lf in all_layout_files:
        if not lf.exists():
            log.error(f"{lf.parent.name} thiếu map_layout.json — DỪNG")
            return None
    # manifest.map_count phải khớp số file layout thực — artifact thiếu/
    # thừa map -> manifest stale -> DỪNG.
    mc = manifest.get('map_count')
    if mc != len(all_layout_files):
        log.error(f"CMD_MAP map_count={mc} != số file layout thực "
                  f"{len(all_layout_files)} — artifact stale — DỪNG")
        return None
    _src_agg = hashlib.sha256()
    for lf in all_layout_files:
        _src_agg.update(lf.read_text(encoding='utf-8').encode('utf-8'))
    src_actual = _src_agg.hexdigest()
    osha = manifest.get('output_sha256')
    map_sha = osha.get('map_layouts') if isinstance(osha, dict) else osha
    if map_sha != src_actual:
        log.error(f"CMD_MAP output_sha256 mismatch — artifact bị sửa/"
                  f"stale (manifest={map_sha} actual={src_actual}) — DỪNG")
        return None

    # ── GLOBAL SOURCE AUDIT — verify TOÀN BỘ map (không chỉ phần pick)
    # trước khi chọn sample/batch/full. Bắt duplicate/mismatch/field
    # sai dù nó nằm ngoài range sample.
    seen_global = set()
    for d in map_dirs:
        lf = d / 'map_layout.json'
        if not lf.exists():
            log.error(f"[audit] {d.name} thiếu map_layout.json — DỪNG")
            return None
        try:
            la = json.loads(lf.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError) as e:
            log.error(f"[audit] {d.name} JSON lỗi: {e} — DỪNG")
            return None
        ok, why = _required_fields_ok(la)
        if not ok:
            log.error(f"[audit] {d.name} field sai: {why} — DỪNG")
            return None
        ok, why = _walk_mask_valid(la)
        if not ok:
            log.error(f"[audit] {d.name} walk_mask sai: {why} — DỪNG")
            return None
        ok, why = _geometry_valid(la)
        if not ok:
            log.error(f"[audit] {d.name} geometry sai: {why} — DỪNG")
            return None
        folder_id = int(d.name[4:])
        if la['map_id'] != folder_id:
            log.error(f"[audit] {d.name} map_id={la['map_id']} != "
                      f"folder_id {folder_id} — DỪNG")
            return None
        if la['map_id'] in seen_global:
            log.error(f"[audit] map_id {la['map_id']} TRÙNG — DỪNG")
            return None
        seen_global.add(la['map_id'])
    log.info(f"Global source audit OK — {len(map_dirs)} map sạch")

    # ── chọn map theo MODE (chỉ trên map_dirs hợp lệ) ──
    if MODE == 'sample':
        sc = _parse_sample_count()
        if sc is None:
            log.error(f"MASK_SAMPLE sai: {SAMPLE_RAW!r} (cần int > 0) "
                      f"— DỪNG")
            return None
        if sc > len(map_dirs):
            log.error(f"MASK_SAMPLE={sc} > map_count={len(map_dirs)} "
                      f"— DỪNG")
            return None
        pick = map_dirs[:sc]
    elif MODE == 'batch':
        want = set()
        for x in BATCH_IDS.split(','):
            x = x.strip()
            if x.isdigit():
                want.add(int(x))
            elif x:
                log.error(f"MASK_BATCH_IDS có giá trị sai: '{x}' — DỪNG")
                return None
        if not want:
            log.error("batch mode nhưng MASK_BATCH_IDS rỗng — DỪNG")
            return None
        # map_id thực có trên repo (map_dirs đã lọc hợp lệ)
        have = {int(d.name[4:]) for d in map_dirs}
        missing = sorted(want - have)
        if missing:
            log.error(f"batch mode — thiếu map_id: missing_ids={missing} "
                      f"— DỪNG (không export thiếu)")
            return None
        pick = [d for d in map_dirs if int(d.name[4:]) in want]
    elif MODE == 'full':
        pick = map_dirs
        log.warning("FULL MODE — 10000 PNG. KHÔNG commit repo, "
                    "chỉ local/artifact (điều 7)")
    else:
        log.error(f"MODE lạ: {MODE} — DỪNG")
        return None

    layouts = []
    seen_ids = set()
    for d in pick:
        lf = d / 'map_layout.json'
        # BUG 4 FIX: folder được chọn mà thiếu layout -> DỪNG, KHÔNG skip
        if not lf.exists():
            log.error(f"folder {d.name} được chọn nhưng thiếu "
                      f"map_layout.json — DỪNG")
            return None
        try:
            l = json.loads(lf.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError) as e:
            log.error(f"layout {d.name} lỗi: {e}")
            return None
        # validate required fields TRƯỚC — tránh crash ở export_one_map
        ok, why = _required_fields_ok(l)
        if not ok:
            log.error(f"layout {d.name} thiếu/sai field: {why} — DỪNG")
            return None
        # folder map_NNNNN phải khớp layout['map_id']
        if d.name.startswith('map_') and d.name[4:].isdigit():
            folder_id = int(d.name[4:])
            if l['map_id'] != folder_id:
                log.error(f"folder {d.name} nhưng layout map_id="
                          f"{l['map_id']} — lệch — DỪNG")
                return None
        # map_id không được trùng
        if l['map_id'] in seen_ids:
            log.error(f"map_id {l['map_id']} trùng — DỪNG")
            return None
        seen_ids.add(l['map_id'])
        # validate walk_mask
        ok, why = _walk_mask_valid(l)
        if not ok:
            log.error(f"layout {d.name} walk_mask sai: {why} — DỪNG")
            return None
        # BUG 5 FIX: validate geometry — KHÔNG clamp im lặng
        ok, why = _geometry_valid(l)
        if not ok:
            log.error(f"layout {d.name} geometry sai: {why} — DỪNG")
            return None
        layouts.append(l)
    if not layouts:
        log.error("Không chọn được map nào — DỪNG")
        return None
    log.info(f"MODE={MODE}: đọc {len(layouts)} layout "
             f"(canvas {CANVAS_W}x{CANVAS_H})")
    return layouts, manifest


# ── RENDER PNG — canvas khoá 1920×1080 ──
# Cách làm: vẽ mask ở cỡ LƯỚI Ô (gw×gh px, 1 ô = 1 px), scale đều lên
# content_rect rồi LETTERBOX vào canvas 1920×1080 (pad đen 2 bên giữ
# tỉ lệ 4:3, KHÔNG méo). Khung map thật = content_rect (ghi trong meta).
# Bản *_content.png là phần map không pad cho AI.

def content_rect(gw, gh):
    """Tính khung map thật trong canvas 1920×1080 — GIỮ tỉ lệ grid 4:3,
    KHÔNG méo. Scale đều bằng 1 hệ số (tile_px nguyên), căn giữa, pad
    màu đen 2 bên. Trả (tile_px, content_w, content_h, content_x,
    content_y). gw/gh phải là int > 0."""
    if (not isinstance(gw, int) or isinstance(gw, bool)
            or not isinstance(gh, int) or isinstance(gh, bool)
            or gw <= 0 or gh <= 0):
        raise ValueError(f'content_rect: grid sai {gw!r}x{gh!r}')
    # tile_px lớn nhất để cả lưới vừa canvas, nguyên
    tile_px = min(CANVAS_W // gw, CANVAS_H // gh)
    if tile_px < 1:
        tile_px = 1
    cw, ch = gw * tile_px, gh * tile_px
    cx, cy = (CANVAS_W - cw) // 2, (CANVAS_H - ch) // 2
    return tile_px, cw, ch, cx, cy


def _letterbox(small, gw, gh):
    """Phóng ảnh lưới-ô lên content rect (GIỮ tỉ lệ), pad vào canvas
    1920×1080 nền đen. NEAREST giữ màu sắc nét. KHÔNG ép méo 4:3->16:9."""
    from PIL import Image
    tile_px, cw, ch, cx, cy = content_rect(gw, gh)
    scaled = small.resize((cw, ch), Image.NEAREST)
    canvas = Image.new('RGB', (CANVAS_W, CANVAS_H), (0, 0, 0))
    canvas.paste(scaled, (cx, cy))
    return canvas


def _grid_img(gw, gh, bg=(0, 0, 0)):
    """Ảnh cỡ lưới ô — 1 ô = 1 pixel."""
    from PIL import Image
    return Image.new('RGB', (gw, gh), bg)


def _content_scaled(grid_img, gw, gh):
    """Scale ảnh lưới-ô lên ĐÚNG content size (không canvas, KHÔNG pad).
    Dùng cho content mask cấp cho AI — chỉ phần map thật, tỉ lệ 4:3."""
    from PIL import Image
    tile_px, cw, ch, _, _ = content_rect(gw, gh)
    return grid_img.resize((cw, ch), Image.NEAREST)


def _grid_walk(layout, colors):
    """Dựng ảnh lưới-ô walk_mask (1 ô = 1 px)."""
    gw, gh = layout['grid_w'], layout['grid_h']
    mask = rle_decode(layout['walk_mask']['data'])
    state_color = {
        WALK_FREE: _hex_to_rgb(colors['free']),
        WALK_BLOCK: _hex_to_rgb(colors['block']),
        WALK_WATER: _hex_to_rgb(colors['water']),
        WALK_SLOPE: _hex_to_rgb(colors['slope']),
    }
    img = _grid_img(gw, gh)
    px = img.load()
    for i, s in enumerate(mask):
        px[i % gw, i // gw] = state_color.get(s, (0, 0, 0))
    return img


def render_walk_mask(layout, colors):
    """walk_mask.png 1920×1080 — FREE/BLOCK/WATER/SLOPE theo màu."""
    gw, gh = layout['grid_w'], layout['grid_h']
    return _letterbox(_grid_walk(layout, colors), gw, gh)


def _grid_point(layout, points, color, bg=(0, 0, 0)):
    """Dựng ảnh lưới-ô point mask (portal/anchor)."""
    gw, gh = layout['grid_w'], layout['grid_h']
    img = _grid_img(gw, gh, bg)
    px = img.load()
    rgb = _hex_to_rgb(color)
    for p in points:
        x, y = p['tile_x'], p['tile_y']
        if 0 <= x < gw and 0 <= y < gh:
            px[x, y] = rgb
    return img


def render_point_mask(layout, points, color, bg=(0, 0, 0)):
    """portal/anchor mask 1920×1080 — chỉ ô có điểm, nền đen."""
    gw, gh = layout['grid_w'], layout['grid_h']
    return _letterbox(_grid_point(layout, points, color, bg), gw, gh)


def _grid_spawn(layout, color):
    """Dựng ảnh lưới-ô spawn zone mask."""
    gw, gh = layout['grid_w'], layout['grid_h']
    img = _grid_img(gw, gh)
    px = img.load()
    rgb = _hex_to_rgb(color)
    for z in layout.get('spawn_zones', []):
        b = z['bounds']
        for x in range(b['x'], min(b['x'] + b['w'], gw)):
            for y in range(b['y'], min(b['y'] + b['h'], gh)):
                px[x, y] = rgb
    return img


def render_spawn_mask(layout, color):
    """spawn_zone_mask.png 1920×1080 — tô vùng quái."""
    gw, gh = layout['grid_w'], layout['grid_h']
    return _letterbox(_grid_spawn(layout, color), gw, gh)


def _compose_grid(layout, colors):
    """Vẽ ảnh lưới-ô gộp: walk_mask nền -> spawn -> anchor -> portal."""
    gw, gh = layout['grid_w'], layout['grid_h']
    mask = rle_decode(layout['walk_mask']['data'])
    state_color = {
        WALK_FREE: _hex_to_rgb(colors['free']),
        WALK_BLOCK: _hex_to_rgb(colors['block']),
        WALK_WATER: _hex_to_rgb(colors['water']),
        WALK_SLOPE: _hex_to_rgb(colors['slope']),
    }
    img = _grid_img(gw, gh)
    px = img.load()
    for i, s in enumerate(mask):
        px[i % gw, i // gw] = state_color.get(s, (0, 0, 0))
    # spawn
    rgb = _hex_to_rgb(colors['spawn'])
    for z in layout.get('spawn_zones', []):
        b = z['bounds']
        for x in range(b['x'], min(b['x'] + b['w'], gw)):
            for y in range(b['y'], min(b['y'] + b['h'], gh)):
                px[x, y] = rgb
    # anchor
    rgb = _hex_to_rgb(colors['anchor'])
    for a in layout.get('anchor_points', []):
        x, y = a['tile_x'], a['tile_y']
        if 0 <= x < gw and 0 <= y < gh:
            px[x, y] = rgb
    # portal — trên cùng
    rgb = _hex_to_rgb(colors['portal'])
    for p in layout.get('portal_points', []):
        x, y = p['tile_x'], p['tile_y']
        if 0 <= x < gw and 0 <= y < gh:
            px[x, y] = rgb
    return img


def render_controlnet_mask(layout, colors):
    """controlnet_mask.png 1920×1080 — gộp tất cả 1 ảnh."""
    gw, gh = layout['grid_w'], layout['grid_h']
    return _letterbox(_compose_grid(layout, colors), gw, gh)


def render_debug_overlay(layout, colors):
    """debug_overlay.png 1920×1080 — controlnet mask + lưới ô cho
    người soi. Lưới vẽ ĐÚNG content rect (khung map thật), KHÔNG vẽ
    toàn canvas (vùng pad đen không có ô)."""
    from PIL import ImageDraw
    gw, gh = layout['grid_w'], layout['grid_h']
    img = _letterbox(_compose_grid(layout, colors), gw, gh)
    draw = ImageDraw.Draw(img)
    tile_px, cw, ch, cx, cy = content_rect(gw, gh)
    grid_rgb = (90, 90, 90)
    # lưới chỉ trong content rect — mỗi ô = tile_px
    for c in range(gw + 1):
        x = cx + c * tile_px
        draw.line([(x, cy), (x, cy + ch)], fill=grid_rgb, width=1)
    for r in range(gh + 1):
        y = cy + r * tile_px
        draw.line([(cx, y), (cx + cw, y)], fill=grid_rgb, width=1)
    return img



def _save_png(img, path):
    """Lưu PNG với tham số cố định — giảm phụ thuộc môi trường.
    optimize=False + không metadata -> byte ổn định nhất có thể.
    (output_sha256 vẫn hash theo pixel data để chắc deterministic.)"""
    img.save(path, format='PNG', optimize=False)


# ── EXPORT 1 MAP ──
def export_one_map(layout, colors, out_dir):
    """Render PNG + meta cho 1 map. Trả dict thông tin.
    - Bản 1920×1080 letterbox (pad đen 2 bên) — cho debug/Unity.
    - Bản content (không pad, đúng tỉ lệ map) — cho AI/ControlNet."""
    mid = layout['map_id']
    gw, gh = layout['grid_w'], layout['grid_h']
    mdir = out_dir / 'maps' / f"map_{mid:05d}"
    mdir.mkdir(parents=True, exist_ok=True)

    # bản letterbox 1920×1080
    _save_png(render_walk_mask(layout, colors), mdir / 'walk_mask.png')
    _save_png(render_point_mask(layout, layout.get('portal_points', []),
              colors['portal']), mdir / 'portal_mask.png')
    _save_png(render_point_mask(layout, layout.get('anchor_points', []),
              colors['anchor']), mdir / 'anchor_mask.png')
    _save_png(render_spawn_mask(layout, colors['spawn']),
              mdir / 'spawn_zone_mask.png')
    _save_png(render_controlnet_mask(layout, colors),
              mdir / 'controlnet_mask.png')
    _save_png(render_debug_overlay(layout, colors),
              mdir / 'debug_overlay.png')

    # bản content — KHÔNG pad, đúng tỉ lệ map, cho AI vẽ
    _save_png(_content_scaled(_grid_walk(layout, colors), gw, gh),
              mdir / 'walk_mask_content.png')
    _save_png(_content_scaled(_compose_grid(layout, colors), gw, gh),
              mdir / 'controlnet_mask_content.png')
    _save_png(_content_scaled(_grid_point(layout,
              layout.get('portal_points', []), colors['portal']),
              gw, gh), mdir / 'portal_mask_content.png')
    _save_png(_content_scaled(_grid_point(layout,
              layout.get('anchor_points', []), colors['anchor']),
              gw, gh), mdir / 'anchor_mask_content.png')
    _save_png(_content_scaled(_grid_spawn(layout, colors['spawn']),
              gw, gh), mdir / 'spawn_zone_mask_content.png')

    tile_px, cw, ch, cx, cy = content_rect(gw, gh)
    meta = {
        'map_id': mid, 'uuid': layout['uuid'],
        'natural_key': layout.get('natural_key'),
        'grid_w': gw, 'grid_h': gh,
        'canvas_w': CANVAS_W, 'canvas_h': CANVAS_H,
        'image_w': CANVAS_W, 'image_h': CANVAS_H,
        # khung map THẬT trong canvas (giữ tỉ lệ 4:3, pad đen 2 bên)
        'tile_px': tile_px,
        'content_x': cx, 'content_y': cy,
        'content_w': cw, 'content_h': ch,
        # bản content không pad — đúng cw×ch
        'content_image_w': cw, 'content_image_h': ch,
        'layout_hash': layout.get('layout_hash'),
        'safe_zone': layout.get('safe_zone'),
        'art_group': layout.get('background', {}).get('art_group'),
        'portal_count': len(layout.get('portal_points', [])),
        'anchor_count': len(layout.get('anchor_points', [])),
        'spawn_zone_count': len(layout.get('spawn_zones', [])),
    }
    (mdir / 'mask_meta.json').write_text(
        json.dumps(meta, indent=2, ensure_ascii=False), encoding='utf-8')
    return meta


# ── SELF-VALIDATE ──
def self_validate(metas, out_dir):
    """Verify output — trả (score, [fail])."""
    fail = {
        'has_output': False, 'all_png': False,
        'png_size_correct': False, 'content_png_correct': False,
        'meta_present': False,
        'canvas_size_valid': False, 'aspect_not_distorted': False,
        'mode_not_full_commit': False,
    }
    if not metas:
        fail['has_output'] = True
    # 6 bản letterbox 1920×1080
    pngs = ('walk_mask.png', 'portal_mask.png', 'anchor_mask.png',
            'spawn_zone_mask.png', 'controlnet_mask.png',
            'debug_overlay.png')
    # 5 bản content không pad
    pngs_content = ('walk_mask_content.png',
                    'controlnet_mask_content.png',
                    'portal_mask_content.png', 'anchor_mask_content.png',
                    'spawn_zone_mask_content.png')
    from PIL import Image
    for m in metas:
        mdir = out_dir / 'maps' / f"map_{m['map_id']:05d}"
        for p in pngs + pngs_content:
            if not (mdir / p).exists():
                fail['all_png'] = True
        if not (mdir / 'mask_meta.json').exists():
            fail['meta_present'] = True
        # PNG letterbox đúng canvas 1920×1080
        try:
            with Image.open(mdir / 'walk_mask.png') as im:
                if im.size != (m['image_w'], m['image_h']):
                    fail['png_size_correct'] = True
        except (OSError, KeyError):
            fail['png_size_correct'] = True
        # PNG content đúng content_w×content_h (không pad)
        try:
            with Image.open(mdir / 'walk_mask_content.png') as im:
                if im.size != (m['content_image_w'], m['content_image_h']):
                    fail['content_png_correct'] = True
        except (OSError, KeyError):
            fail['content_png_correct'] = True
        # content rect GIỮ tỉ lệ grid — KHÔNG méo. tile vuông:
        try:
            gw, gh = m['grid_w'], m['grid_h']
            tp = m['tile_px']
            if m['content_w'] != gw * tp or m['content_h'] != gh * tp:
                fail['aspect_not_distorted'] = True
            if (m['content_x'] + m['content_w'] > CANVAS_W
                    or m['content_y'] + m['content_h'] > CANVAS_H):
                fail['aspect_not_distorted'] = True
        except (KeyError, TypeError):
            fail['aspect_not_distorted'] = True
    if (CANVAS_W, CANVAS_H) != (1920, 1080):
        fail['canvas_size_valid'] = True
    fail['mode_not_full_commit'] = False

    checks = [('foundation_verified', FOUNDATION_VERIFIED)]
    for name, bad in fail.items():
        checks.append((name, not bad))
    passed = sum(1 for _, ok in checks if ok)
    return passed / len(checks), [c for c, ok in checks if not ok]


# ── HASH OUTPUT (dùng chung 2 chỗ: ghi manifest + self-verify sau copy) ──
def _compute_output_sha256(out_dir):
    """Hash NỘI DUNG output (pixel data + tên file + .json text).
    Deterministic giữa các máy — KHÔNG phụ thuộc Pillow/zlib version.
    Duyệt map theo tên folder (đã 0-pad map_NNNNN -> lexicographic ==
    numeric), file theo tên cố định. Dùng cả khi ghi manifest VÀ khi
    self-verify sau copy sang repo (điều phòng hờ v1.0.1)."""
    from PIL import Image as _Img
    out = Path(out_dir)
    maps_dir = out / 'maps'
    map_dirs = sorted(d for d in maps_dir.iterdir()
                      if d.is_dir() and d.name.startswith('map_'))
    agg = hashlib.sha256()
    for mdir in map_dirs:
        for fn in sorted(p.name for p in mdir.iterdir() if p.is_file()):
            fp = mdir / fn
            agg.update(fn.encode('utf-8'))    # tên file vào hash
            if fn.endswith('.png'):
                with _Img.open(fp) as im:
                    # pixel data thô — deterministic, không phụ thuộc
                    # Pillow nén/ghi PNG.
                    agg.update(im.convert('RGB').tobytes())
            else:
                agg.update(fp.read_bytes())
    return agg.hexdigest()


# ── WRITE OUTPUT ──
def write_outputs(layouts, colors, color_from_artspec, map_manifest,
                  out_dir):
    """Render mọi map + manifest + status. Trả (n, score, fails)."""
    out = Path(out_dir)
    # CLEAN triệt để — xóa TOÀN BỘ out_dir cũ rồi tạo lại. Không để
    # bất kỳ stale file/folder nào (map cũ, file lạ) còn sót.
    import shutil as _sh
    if out.exists():
        _sh.rmtree(out)
    for sub in ('maps', 'status'):
        (out / sub).mkdir(parents=True, exist_ok=True)

    metas = []
    for l in layouts:
        metas.append(export_one_map(l, colors, out))

    score, fails = self_validate(metas, out)

    output_sha256 = _compute_output_sha256(out)

    manifest = {
        'tool': TOOL_NAME, 'tool_version': CMD_VERSION,
        'schema_version': SCHEMA_VERSION,
        'foundation_hash': FOUNDATION_HASH,
        'build_rule_hash': BUILD_RULE_HASH,
        'mode': MODE, 'canvas': [CANVAS_W, CANVAS_H],
        'map_count': len(metas),
        'color_source': 'art_spec' if color_from_artspec else 'default',
        'source_map_foundation': map_manifest.get('foundation_hash'),
        'validation_score': score, 'honest_gaps': fails,
        'output_sha256': output_sha256,
        'note': ('full mode KHÔNG commit repo — chỉ local/artifact'
                 if MODE == 'full' else 'sample/batch — commit OK'),
    }
    (out / 'build_manifest.json').write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding='utf-8')
    ts = time.strftime('%Y%m%d-%H%M%S')
    status = {
        'tool': TOOL_NAME, 'tool_version': CMD_VERSION,
        'schema_version': SCHEMA_VERSION, 'timestamp': ts,
        'mode': MODE, 'map_count': len(metas),
        'validation_score': score, 'honest_gaps': fails,
        'output_sha256': output_sha256,
        'exit_code': 0 if score >= SCORE_THRESHOLD else 1,
    }
    (out / 'status' / f'status-{ts}.json').write_text(
        json.dumps(status, indent=2, ensure_ascii=False),
        encoding='utf-8')
    return len(metas), score, fails


def _git(args, cwd):
    try:
        r = subprocess.run(['git'] + args, cwd=str(cwd),
                           capture_output=True, text=True, timeout=120)
        return r.returncode == 0, r.stdout + r.stderr
    except (subprocess.TimeoutExpired, OSError) as e:
        return False, str(e)


def push_to_github(out_dir, score):
    """Push lên branch staging. FULL MODE -> KHÔNG push (điều 7)."""
    if MODE == 'full':
        log.warning("FULL MODE — KHÔNG push repo. Output ở local: "
                    f"{out_dir}")
        return True
    if not REPO_DIR.exists():
        ok, _ = _git(['clone', REPO_URL, str(REPO_DIR)], Path('/tmp'))
        if not ok:
            return False
    ts = time.strftime('%Y%m%d-%H%M%S')
    for attempt in range(MAX_PUSH_ATTEMPTS):
        branch = f"staging-mask-exporter-{ts}" + (
            f"-r{attempt}" if attempt else "")
        try:
            _git(['fetch', 'origin'], REPO_DIR)
            _git(['switch', '-C', branch], REPO_DIR)
            dst = REPO_DIR / 'tool-mask-exporter' / 'output'
            if dst.exists():
                import shutil
                shutil.rmtree(str(dst))
            import shutil
            shutil.copytree(str(out_dir), str(dst))

            # ── SELF-VERIFY (v1.0.1) — đọc lại file ĐÃ COPY sang repo,
            # hash lại, so với output_sha256 trong manifest đích. Lệch
            # -> DỪNG, KHÔNG commit. Bug manifest-vs-file (race, retry,
            # human-edit, fs glitch) không bao giờ lọt lên repo. ──
            mf_dst = dst / 'build_manifest.json'
            try:
                mfj = json.loads(mf_dst.read_text(encoding='utf-8'))
            except (json.JSONDecodeError, OSError) as e:
                log.error(f"Self-verify đọc manifest đích lỗi: {e} "
                          f"— DỪNG, KHÔNG push")
                return False
            declared = mfj.get('output_sha256')
            actual = _compute_output_sha256(dst)
            if declared != actual:
                log.error(f"SELF-VERIFY FAIL — manifest.output_sha256="
                          f"{declared} nhưng file thực tế hash="
                          f"{actual}. Output đã copy KHÔNG khớp "
                          f"manifest — DỪNG, KHÔNG push.")
                return False
            log.info(f"Self-verify OK — output_sha256 khớp "
                     f"({actual[:16]}...)")

            _git(['config', 'user.email',
                  os.getenv('GIT_EMAIL', 'tool-mask-bot@svtk.local')],
                 REPO_DIR)
            _git(['config', 'user.name',
                  os.getenv('GIT_NAME', 'TOOL_MASK_EXPORTER_BOT')],
                 REPO_DIR)
            _git(['add', '-A'], REPO_DIR)
            has = subprocess.run(
                ['git', '-C', str(REPO_DIR), 'diff', '--cached',
                 '--quiet'], timeout=60).returncode != 0
            if has:
                _git(['commit', '-m',
                      f'TOOL_MASK_EXPORTER v{CMD_VERSION} {MODE} '
                      f'ts={ts} score={score:.2f}'], REPO_DIR)
            ok, out = _git(['push', 'origin', branch], REPO_DIR)
            if ok:
                log.info(f"Pushed: {branch}")
                return True
            log.warning(f"Push attempt {attempt+1} fail: {out[:80]}")
        except Exception as e:
            log.warning(f"Push attempt {attempt+1} lỗi: {e}")
        time.sleep(RETRY_DELAY_SEC)
    return False


def main():
    verify_foundation()
    cres = load_mask_colors()
    if cres is None:
        log.error("Đọc màu ART_SPEC fail — DỪNG")
        return 1
    colors, from_artspec = cres
    loaded = load_map_layouts()
    if loaded is None:
        log.error("Đọc CMD_MAP fail — DỪNG")
        return 1
    layouts, map_manifest = loaded
    n, score, fails = write_outputs(layouts, colors, from_artspec,
                                    map_manifest, OUTPUT_DIR)
    log.info(f"Render {n} map — score {score:.3f} — "
             f"gaps: {fails or 'KHÔNG'}")
    if score < SCORE_THRESHOLD:
        log.error(f"Score {score:.3f} < {SCORE_THRESHOLD} — không push")
        return 1
    if push_to_github(str(OUTPUT_DIR), score):
        return 0
    return 1


if __name__ == '__main__':
    sys.exit(main())
