"""Extract 5 function core của cmd_place.py để mutmut/cosmic-ray test focused.

Cosmic-ray với cmd_place.py (1815 LOC) = 3099 mutations × 1.5s = ~80 phút.
Scope hẹp xuống 5 function core (~150 LOC) → ~200-400 mutations → ~10-15 phút.

Để mutmut/cosmic-ray mutate phải có file riêng. Import logic chia sẻ
từ cmd_place qua module-level. Test_core.py import cmd_place_core và test.
"""
import hashlib
import re


# ─── seeded_int (line 311 cmd_place) ────────────────────────────────────────
def seeded_int(seed_str, lo, hi):
    """Deterministic int từ seed string."""
    h = int(hashlib.sha256(seed_str.encode()).hexdigest(), 16)
    return lo + (h % (hi - lo + 1))


# ─── seeded_pick (line 316 cmd_place) ───────────────────────────────────────
def seeded_pick(seed_str, options):
    return options[seeded_int(seed_str, 0, len(options) - 1)]


# ─── G1 check ──────────────────────────────────────────────────────────────
G1_CAM = [
    'tây sa', 'nam sa', 'tam sa', 'lưỡi bò', 'đường chín đoạn',
    'diệt chủng', 'tận diệt', 'thảm sát', 'tế sống', 'luyện cốt',
    'thiên linh', 'bùa hại', 'khỏa thân', 'dâm phụ', 'loạn luân',
    'ma túy', 'thuốc phiện', 'sòng bài', 'casino', 'poker',
    'man di', 'rợ hồ', 'quỷ vương', 'tà thần', 'chùa ma',
]
G1_IP = ['thiên long', 'võ lâm', 'kim dung', 'cổ long', 'pokemon', 'marvel']
G1_NHAY_CAM = {
    'nam quan': 'Bối cảnh thời phong kiến, không phản ánh biên giới hiện hành.',
    'bản giốc': 'Danh thắng tự nhiên; không gắn yếu tố tranh chấp.',
    'hoàng sa': 'Quần đảo thuộc chủ quyền Việt Nam.',
    'trường sa': 'Quần đảo thuộc chủ quyền Việt Nam.',
}


def g1_check(text):
    """Kiểm tên map theo quy chuẩn G1. Trả (g1_pass, g1_note)."""
    low = text.lower()
    for k in G1_CAM:
        if k in low:
            return False, f'CẤM: chứa từ vi phạm "{k}"'
    for k in G1_IP:
        if k in low:
            return False, f'CẤM: trùng IP bên thứ ba "{k}"'
    for k, note in G1_NHAY_CAM.items():
        if k in low:
            return True, note
    return True, ''


# ─── Cultural lock (in-file copy, không import place_lib) ─────────────────
JP_KANA_RE = re.compile(r'[぀-ゟ゠-ヿ]')
TAM_QUOC_RE = re.compile(
    r'(Tào Tháo|Lưu Bị|Quan Vũ|Trương Phi|Khổng Minh|Tam Quốc|曹操|劉備)')
MODERN_SENSITIVE_RE = re.compile(
    r'(nội chiến|ngụy quân|ngụy quyền|cải cách ruộng đất|'
    r'chiến tranh biên giới|Khmer Đỏ|vượt biên|ly khai|'
    r'chia rẽ vùng miền|đảo chính|biểu tình|cách mạng văn hóa)',
    re.IGNORECASE)


def cultural_lock_ok(text):
    """True nếu text hợp lệ."""
    return (not JP_KANA_RE.search(text)
            and not TAM_QUOC_RE.search(text)
            and not MODERN_SENSITIVE_RE.search(text))


# ─── Portal graph valid (line 1456 cmd_place) ───────────────────────────────
def _portal_graph_valid(maps):
    """Kiểm portal graph."""
    all_ids = set(m['map_id'] for m in maps)
    by_id = {m['map_id']: m for m in maps}
    for m in maps:
        seen = set()
        for lk in m.get('portal_graph', []):
            to_map = lk.get('to_map')
            if to_map not in all_ids:
                return False
            if lk.get('from_map') != m['map_id']:
                return False
            if to_map == m['map_id']:
                return False
            if to_map in seen:
                return False
            seen.add(to_map)
            if lk.get('bidirectional'):
                back = by_id[to_map].get('portal_graph', [])
                if not any(b.get('to_map') == m['map_id'] for b in back):
                    return False
    return True


# ─── World connected ──────────────────────────────────────────────────────
def _world_connected(maps):
    """Strongly-connected check."""
    if not maps:
        return False
    fwd = {m['map_id']: [] for m in maps}
    rev = {m['map_id']: [] for m in maps}
    all_ids = set(fwd)
    for m in maps:
        for lk in m.get('portal_graph', []):
            to_map = lk.get('to_map')
            if to_map not in all_ids:
                return False
            fwd[m['map_id']].append(to_map)
            rev[to_map].append(m['map_id'])

    def _reach(adj, start):
        seen = {start}
        stack = [start]
        while stack:
            cur = stack.pop()
            for nxt in adj.get(cur, []):
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        return seen

    start = maps[0]['map_id']
    return (len(_reach(fwd, start)) == len(maps)
            and len(_reach(rev, start)) == len(maps))
