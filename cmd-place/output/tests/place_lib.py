# place_lib.py — 1 nguồn logic cultural lock (test + runtime dùng chung)
import re

# Chặn Hiragana + Katakana (chữ Nhật). KHÔNG chặn CJK toàn cục
# vì địa danh Hán-Việt lịch sử (bia đá, chữ cổ) hợp lệ.
JP_KANA_RE = re.compile(r'[\u3040-\u309F\u30A0-\u30FF]')
# Chặn nhân vật Tam Quốc (cả tiếng Việt lẫn chữ Hán tên riêng).
TAM_QUOC_RE = re.compile(
    r'(Tào Tháo|Lưu Bị|Quan Vũ|Trương Phi|Khổng Minh|Tam Quốc|曹操|劉備)')

# ── HISTORICAL INTEGRITY LOCK (hiến pháp nội dung — giảm rủi ro G1) ──
# Chặn nội dung lịch sử nhạy cảm chính trị hiện đại: nội chiến / chiến
# tranh chính trị hiện đại, chia rẽ vùng miền, địa danh-nhân vật hiện
# đại nhạy cảm. SVTK chỉ tái hiện sử PHONG KIẾN + chống ngoại xâm.
MODERN_SENSITIVE_RE = re.compile(
    r'(nội chiến|ngụy quân|ngụy quyền|cải cách ruộng đất|'
    r'chiến tranh biên giới|Khmer Đỏ|vượt biên|ly khai|'
    r'chia rẽ vùng miền|đảo chính|biểu tình|cách mạng văn hóa)',
    re.IGNORECASE)

def cultural_lock_ok(text):
    """True nếu text hợp lệ: không chữ Nhật, không tên Tam Quốc,
    không nội dung lịch sử nhạy cảm chính trị hiện đại."""
    return (not JP_KANA_RE.search(text)
            and not TAM_QUOC_RE.search(text)
            and not MODERN_SENSITIVE_RE.search(text))

# ERAS/BIOMES/TARGET — 1 nguồn cho test (runtime sinh với giá trị thật)
ERAS = ['ly', 'tran', 'le', 'tay_son', 'nguyen', 'f1', 'f2', 'f3', 'f4', 'f5']
BIOMES = ['forest', 'mountain', 'river', 'plain', 'sea', 'swamp', 'craft_village', 'rice_field', 'fishing_village', 'salt_field', 'plantation', 'wharf', 'capital', 'capital_inner', 'town', 'village', 'citadel', 'frontier_pass', 'battlefield', 'cave', 'scenic', 'garden']
TARGET_REGION_SHARDS = 64
TARGET_MAP_COUNT = 10000
SHARD_GRID_WIDTH = 8
SHARD_CELL_SIZE = 1000
MAP_GRID_WIDTH = 32
MAP_CELL_SIZE = 30
