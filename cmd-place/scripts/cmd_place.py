#!/usr/bin/env python3
"""CMD_PLACE v2.4.0 — autonomous builder. 10102 map + 64 shard.

v2.4.0 (2026-05-26): thêm 100 map cõi đặc biệt + 2 map start cốt
truyện. 10000 map thường GIỮ NGUYÊN — realm + start sinh nhánh riêng.
- Tiên Giới 50 map (6 sub-realm) + Âm Phủ 50 map (6 sub-realm),
  era 'than_thoai', trường realm_group/map_role/realm_access.
- 2 map start: Bảo tàng Lịch sử VN (2026) -> Hoa Lư 968, is_start_map.
- portal realm: liên thông nội bộ theo realm_group (gate->hub->
  combat->boss), KHÔNG nối map thường.

v2.3.1 (2026-05-26): fix 4 bug ẩn từ 18-round audit:
- BugA: ensure_place_lib() race condition (Lock + unique tmp per thread/pid)
- BugB: self_validate CRASH khi data corrupt (defensive _world_connected/_portal_graph_valid)
- BugC: main_loop spam push branch khi restart (skip nếu output không đổi)
- BugD: CRLF cross-platform manifest drift (write text/jsonl LF newline=\\'\\')
"""
import os, sys, json, time, hashlib, subprocess, signal, re, uuid, logging, threading
from pathlib import Path

# BugA: lock cho ensure_place_lib — chống race khi concurrent thread cùng ghi
_PLACE_LIB_LOCK = threading.Lock()

def _write_text_lf(path, content):
    """BugD: ghi text với LF newline trên MỌI platform (chống CRLF Windows).
    .gitattributes repo svtk-status pin *.json/*.jsonl/*.py/*.sql/*.md eol=lf
    → file local phải LF mới khớp blob LF sau push. Else manifest hash lệch
    cross-platform + daemon Linux không bao giờ reuse cache.
    Dùng cho output text file (jsonl + json + sql + py + sha256 + meta)."""
    Path(path).write_bytes(content.encode('utf-8'))

CMD_NAME = "PLACE"
CMD_VERSION = "2.4.0"   # 1 nguồn — version đổi sửa ĐÚNG 1 chỗ này
# v2.4.0: thêm 100 map cõi đặc biệt (Tiên Giới 50 + Âm Phủ 50). 10000
# map thường giữ NGUYÊN — realm sinh nhánh riêng, map_id 10001-10100.
FOUNDATION_HASH = "cc194e6cad2225d197c4a5539352deb538c99cdd6a21845a8354260602287bbb"
FOUNDATION_FILE = "SVTK_FOUNDATION_v2.10.0.md"
# REPO_URL: ưu tiên env SVTK_REPO_URL (đổi infra/liveops không cần sửa
# code); fallback repo mặc định để chạy được ngay khi chưa set env.
REPO_URL = os.getenv("SVTK_REPO_URL",
                     "https://github.com/Trinhlong1988/svtk-status.git")
REPO_DIR = Path("/tmp/svtk-status")
DEFAULT_BRANCH = None       # dò runtime từ origin/HEAD
DEFAULT_BRANCH_TS = 0       # timestamp dò lần cuối
DEFAULT_BRANCH_TTL = 1800   # cache 30 phút rồi dò lại
OUTPUT_DIR = Path(f"/tmp/cmd-{CMD_NAME.lower()}-output")
MAX_PUSH_ATTEMPTS = 3
RETRY_DELAY_SEC = 5
SCORE_THRESHOLD = 0.95
LOOP_INTERVAL_SEC = 60

# CMD-specific constants — 10000 map, 10 era (g1 KHÔNG phải era), 22 biome
TARGET_MAP_COUNT = 10000        # map THƯỜNG (lịch sử trần gian) — KHÔNG đổi
TARGET_REGION_SHARDS = 64
# TOTAL_MAP_COUNT = map thường (10000) + map cõi (100) + map start (2)
# = 10102. Tính cuối khối START_* — REALM_MAP_COUNT/START_MAP_COUNT
# định nghĩa bên dưới.
# TOPOLOGY_VERSION — khóa CẤU TRÚC BẤT BIẾN (map_id, coord, shard,
# natural_key). Topology đã sinh thì KHÔNG đổi: NPC save / quest /
# portal / replay đều neo vào đây. CHỈ tăng version này khi buộc phải
# sinh lại toàn thế giới — và khi đó save cũ KHÔNG tương thích.
TOPOLOGY_VERSION = 1
# g1 KHÔNG phải thời kỳ — g1 là nhãn kiểm duyệt giấy phép phát hành.
ERAS = ['ly', 'tran', 'le', 'tay_son', 'nguyen', 'f1', 'f2', 'f3', 'f4', 'f5']
# Topology coord — config hóa, không hardcode rải rác
SHARD_GRID_WIDTH = 8     # số cột shard trên lưới
SHARD_CELL_SIZE = 1000   # kích thước 1 ô shard
MAP_GRID_WIDTH = 32      # số cột map trong 1 ô shard
MAP_CELL_SIZE = 30       # khoảng cách 2 map
# 22 BIOME — game sử Việt, chia 6 nhóm chức năng (verify từ làng nghề
# + địa lý + không gian sử Việt thật).
BIOMES = [
    # Farm/Train (6): bãi đánh quái, chia tầng
    'forest', 'mountain', 'river', 'plain', 'sea', 'swamp',
    # Văn hóa/Làng nghề (6)
    'craft_village', 'rice_field', 'fishing_village', 'salt_field',
    'plantation', 'wharf',
    # Đô thị (4)
    'capital', 'capital_inner', 'town', 'village',
    # Cốt truyện/Lịch sử (3)
    'citadel', 'frontier_pass', 'battlefield',
    # Hang động (1) — chia loại sau (mỏ/quest/thông)
    'cave',
    # Giải trí/Phong cảnh (2)
    'scenic', 'garden',
]
# Nhóm chức năng — map nào dùng việc gì
BIOME_GROUP = {
    'forest':'farm','mountain':'farm','river':'farm','plain':'farm',
    'sea':'farm','swamp':'farm',
    'craft_village':'culture','rice_field':'culture','fishing_village':'culture',
    'salt_field':'culture','plantation':'culture','wharf':'culture',
    'capital':'city','capital_inner':'city','town':'city','village':'city',
    'citadel':'history','frontier_pass':'history','battlefield':'history',
    'cave':'cave',
    'scenic':'leisure','garden':'leisure',
}
# Nhãn tiếng Việt
BIOME_LABEL_VI = {
    'forest':'Rừng','mountain':'Núi','river':'Sông','plain':'Đồng Bằng',
    'sea':'Biển','swamp':'Đầm Lầy',
    'craft_village':'Làng Nghề','rice_field':'Ruộng Đồng','fishing_village':'Làng Chài',
    'salt_field':'Bãi Muối','plantation':'Đồn Điền','wharf':'Bến Thuyền',
    'capital':'Kinh Đô','capital_inner':'Nội Thành','town':'Thị Trấn','village':'Làng Quê',
    'citadel':'Thành Lũy','frontier_pass':'Quan Ải','battlefield':'Chiến Trường',
    'cave':'Hang Động','scenic':'Danh Thắng','garden':'Vườn Cảnh',
}
# ── BẢNG PHÂN BỔ CHÍNH XÁC 22 BIOME (spec CMD_PLACE) ──
# 2500 map QUAN TRỌNG (25%) + 7500 map NỀN (75%). Kinh đô CỰC ÍT (30)
# vì sử Việt chỉ ~10 cố đô. Tổng verify = 10000.
BIOME_QUOTA = {
    # MAP QUAN TRỌNG (2500) — hub xã hội, lịch sử, văn hóa
    'capital': 30,          # kinh đô — hiếm nhất, hub cấp 1
    'capital_inner': 120,   # nội thành kinh đô
    'town': 260,            # thị trấn / phố cổ — hub cấp 3
    'citadel': 110,         # thành trì lớn — hub cấp 2
    'frontier_pass': 85,    # ải quan / đèo phòng thủ
    'craft_village': 175,   # làng nghề truyền thống
    'scenic': 235,          # danh thắng nổi tiếng
    'battlefield': 130,     # chiến trường lịch sử (chỉ chống ngoại xâm)
    'cave': 430,            # hang động / dungeon quest
    'wharf': 195,           # bến cảng / thương cảng
    'garden': 155,          # vườn cảnh / văn miếu / đền chùa
    'salt_field': 160,      # bãi muối — vùng tài nguyên
    'plantation': 150,      # đồn điền — vùng tài nguyên
    'fishing_village': 265, # làng chài
    # MAP NỀN (7500) — wilderness, farm, di chuyển
    'forest': 1800,         # rừng nhiệt đới — farm quái chủ lực
    'mountain': 1200,       # núi cao hiểm trở
    'rice_field': 1100,     # ruộng lúa / đồng bằng nông nghiệp
    'plain': 900,           # đồng bằng / đồng cỏ
    'river': 850,           # sông / hồ lớn
    'sea': 700,             # biển / đảo ven bờ
    'village': 500,         # làng quê thường
    'swamp': 450,           # đầm lầy / rừng ngập mặn
}
# 14 biome map quan trọng (để phân loại + verify tỉ lệ 25/75)
IMPORTANT_BIOMES = {'capital', 'capital_inner', 'town', 'citadel',
    'frontier_pass', 'craft_village', 'scenic', 'battlefield', 'cave',
    'wharf', 'garden', 'salt_field', 'plantation', 'fishing_village'}

# ── SPAWN POLICY — gợi ý vùng quái cho CMD_MAP ──
# CMD_PLACE chỉ KHAI BÁO map có cho spawn quái không + profile + mật độ
# gợi ý. KHÔNG sinh quái thật (monster_id/level/drop là việc CMD_NPC).
# CMD_MAP đọc cái này để vẽ spawn_zone, không phải tự đoán.
# Mỗi biome -> (allow, profile, density_hint, zone_count_hint).
SPAWN_PROFILE = {
    # đô thị / hub xã hội — KHÔNG quái
    'capital':        (False, 'none', 'none', 0),
    'capital_inner':  (False, 'none', 'none', 0),
    'town':           (False, 'none', 'none', 0),
    'village':        (False, 'none', 'none', 0),
    'craft_village':  (False, 'none', 'none', 0),
    'fishing_village':(False, 'none', 'none', 0),
    'wharf':          (False, 'none', 'none', 0),
    'scenic':         (False, 'none', 'none', 0),
    'garden':         (False, 'none', 'none', 0),
    'salt_field':     (False, 'none', 'none', 0),
    'plantation':     (False, 'none', 'none', 0),
    'rice_field':     (False, 'none', 'none', 0),
    'river':          (False, 'none', 'none', 0),
    # bãi farm ngoài trời — quái thường
    'forest':         (True, 'field_combat', 'medium', 3),
    'plain':          (True, 'field_combat', 'low', 3),
    'mountain':       (True, 'field_combat', 'medium', 4),
    'sea':            (True, 'field_combat', 'low', 3),
    'swamp':          (True, 'field_combat', 'medium', 3),
    # dungeon — quái dày
    'cave':           (True, 'dungeon_combat', 'high', 5),
    'frontier_pass':  (True, 'frontier_combat', 'high', 4),
    'battlefield':    (True, 'frontier_combat', 'high', 4),
    'citadel':        (True, 'frontier_combat', 'medium', 4),
}

# ── PURPOSE LAYER — công năng gameplay của mỗi biome ──
# CMD_PLACE chỉ KHAI BÁO "vào map làm gì", KHÔNG cài gameplay logic.
# CMD khác (ACTIVITY/RESOURCE/NPC/QUEST) bám purpose này để fill nội
# dung. 10 purpose chuẩn — KHÔNG thêm bừa, mỗi biome 1-4 purpose.
VALID_PURPOSES = {'combat', 'gathering', 'fishing', 'farming', 'crafting',
                  'trade', 'exploration', 'social', 'lore', 'archeology'}
BIOME_PURPOSE = {
    'forest':          ['combat', 'gathering', 'exploration'],
    'mountain':        ['combat', 'gathering', 'exploration', 'lore'],
    'river':           ['fishing', 'trade', 'social'],
    'plain':           ['farming', 'combat', 'social'],
    'sea':             ['fishing', 'exploration', 'combat'],
    'swamp':           ['combat', 'gathering'],
    'craft_village':   ['crafting', 'trade', 'social'],
    'rice_field':      ['farming', 'gathering'],
    'fishing_village': ['fishing', 'crafting', 'social'],
    'salt_field':      ['gathering', 'crafting'],
    'plantation':      ['farming', 'gathering'],
    'wharf':           ['trade', 'social', 'exploration'],
    'capital':         ['social', 'trade', 'lore', 'exploration'],
    'capital_inner':   ['social', 'lore', 'trade'],
    'town':            ['social', 'trade', 'crafting'],
    'village':         ['social', 'farming'],
    'citadel':         ['combat', 'lore', 'archeology'],
    'frontier_pass':   ['combat', 'lore', 'archeology'],
    'battlefield':     ['combat', 'lore', 'archeology'],
    'cave':            ['combat', 'archeology', 'exploration', 'gathering'],
    'scenic':          ['exploration', 'social', 'lore'],
    'garden':          ['social', 'exploration', 'lore'],
}

# ── ANCHOR REGISTRY — CMD_PLACE chỉ sinh CHỖ NEO, không spawn nội dung ──
# Mỗi map có các "anchor" = vị trí trống có ý nghĩa. CMD khác đọc anchor
# rồi tự fill: CMD_NPC fill npc/boss_anchor, CMD_RESOURCE fill
# resource_anchor, CMD_ACTIVITY fill activity_anchor, CMD_QUEST fill
# quest_anchor. CMD_PLACE KHÔNG hardcode tọa độ NPC/quái.
# Purpose nào -> sinh loại anchor nào:
PURPOSE_ANCHOR = {
    'combat':      'npc_anchor',
    'gathering':   'resource_anchor',
    'fishing':     'resource_anchor',
    'farming':     'resource_anchor',
    'crafting':    'activity_anchor',
    'trade':       'activity_anchor',
    'social':      'activity_anchor',
    'exploration': 'activity_anchor',
    'lore':        'quest_anchor',
    'archeology':  'quest_anchor',
}
# WORLD DENSITY LOCK — trần số anchor mỗi loại / 1 map. Khóa hiến pháp:
# thế giới không bị nhồi NPC/tài nguyên đặc kín nhìn giả. CMD khác fill
# KHÔNG được vượt trần này.
ANCHOR_CAP = {
    'npc_anchor': 12, 'resource_anchor': 8, 'activity_anchor': 5,
    'quest_anchor': 4, 'portal_anchor': 4, 'boss_anchor': 2,
}

# ── Ràng buộc địa danh theo zone (G1 + lịch sử) — module-level để vào
# BUILD_RULE_HASH. Kinh đô chỉ Bắc+Trung; ải quan Bắc+Trung; đồn điền
# không ở Bắc. Dùng list (không set) để JSON-hóa cho hash.
ZONE_FORBID = {
    'bac_bo':   ['plantation'],
    'trung_bo': [],
    'nam_bo':   ['capital', 'capital_inner', 'frontier_pass'],
}
# Biome sinh theo CỤM nhiều tầng (hang + farm dẫn vào) — (lo, hi) số map
# trong cụm. Module-level để vào BUILD_RULE_HASH (đổi cụm -> cache stale).
CLUSTER_BIOMES = {'cave': [4, 8], 'forest': [2, 5], 'mountain': [2, 4]}

# ── TERRAIN PROFILE — đặc tính địa hình theo biome ──
# CMD_MAP / pathfinding / spawn dùng. elevation 0-100 (cao độ tương
# đối), water_ratio 0-100 (% mặt nước), roughness 0-100 (độ gồ ghề ->
# ảnh hưởng tốc độ di chuyển + chỗ spawn hợp lệ).
BIOME_TERRAIN = {
    'forest':          {'elevation': 35, 'water_ratio': 10, 'roughness': 55},
    'mountain':        {'elevation': 90, 'water_ratio': 5,  'roughness': 90},
    'river':           {'elevation': 15, 'water_ratio': 70, 'roughness': 25},
    'plain':           {'elevation': 20, 'water_ratio': 8,  'roughness': 15},
    'sea':             {'elevation': 0,  'water_ratio': 95, 'roughness': 30},
    'swamp':           {'elevation': 8,  'water_ratio': 55, 'roughness': 45},
    'craft_village':   {'elevation': 22, 'water_ratio': 10, 'roughness': 20},
    'rice_field':      {'elevation': 14, 'water_ratio': 35, 'roughness': 12},
    'fishing_village': {'elevation': 6,  'water_ratio': 45, 'roughness': 20},
    'salt_field':      {'elevation': 4,  'water_ratio': 40, 'roughness': 10},
    'plantation':      {'elevation': 40, 'water_ratio': 10, 'roughness': 30},
    'wharf':           {'elevation': 5,  'water_ratio': 50, 'roughness': 18},
    'capital':         {'elevation': 25, 'water_ratio': 12, 'roughness': 15},
    'capital_inner':   {'elevation': 26, 'water_ratio': 8,  'roughness': 10},
    'town':            {'elevation': 24, 'water_ratio': 10, 'roughness': 15},
    'village':         {'elevation': 20, 'water_ratio': 12, 'roughness': 18},
    'citadel':         {'elevation': 45, 'water_ratio': 10, 'roughness': 40},
    'frontier_pass':   {'elevation': 70, 'water_ratio': 5,  'roughness': 80},
    'battlefield':     {'elevation': 30, 'water_ratio': 12, 'roughness': 35},
    'cave':            {'elevation': 50, 'water_ratio': 15, 'roughness': 75},
    'scenic':          {'elevation': 55, 'water_ratio': 25, 'roughness': 50},
    'garden':          {'elevation': 22, 'water_ratio': 20, 'roughness': 12},
}

# UUID namespace cố định cho determinism (R68) — hex 32 ký tự, rõ ràng
UUID_NS = uuid.UUID('5d7e9a1c8b3f4e2a9c6da1b2c3d4e5f6')

ERA_LABEL = {'ly':'Lý','tran':'Trần','le':'Lê','tay_son':'Tây Sơn','nguyen':'Nguyễn',
             'f1':'Hồng Bàng','f2':'Âu Lạc','f3':'Bắc Thuộc','f4':'Ngô Đinh Tiền Lê',
             'f5':'Lê Sơ'}
# ── CULTURAL STYLE LOCK — khóa phong cách hình/âm/kiến trúc theo era ──
# Mỗi map mang style tag để CMD_ART / CMD_AUDIO bám vào. KHÓA HIẾN PHÁP:
# era cổ-phong kiến Việt -> KHÔNG cyberpunk, neon, sci-fi. Đây chỉ là
# KHAI BÁO ràng buộc; CMD_ART chịu trách nhiệm tuân thủ.
ERA_STYLE = {
    'f1': {'visual': 'co_dai_hong_bang', 'architecture': 'nha_san_dong_son',
           'audio': 'nhac_le_co'},
    'f2': {'visual': 'co_dai_au_lac', 'architecture': 'thanh_dat_co_loa',
           'audio': 'nhac_le_co'},
    'f3': {'visual': 'bac_thuoc', 'architecture': 'kien_truc_han_viet_so',
           'audio': 'nhac_le_co'},
    'f4': {'visual': 'ngo_dinh_tien_le', 'architecture': 'kien_truc_hoa_lu',
           'audio': 'nhac_cung_dinh_so'},
    'f5': {'visual': 'le_so', 'architecture': 'kien_truc_le_so',
           'audio': 'nha_nhac_so'},
    'ly': {'visual': 'thoi_ly', 'architecture': 'kien_truc_ly',
           'audio': 'nha_nhac_ly_tran'},
    'tran': {'visual': 'thoi_tran', 'architecture': 'kien_truc_tran',
             'audio': 'nha_nhac_ly_tran'},
    'le': {'visual': 'thoi_le', 'architecture': 'kien_truc_le',
           'audio': 'nha_nhac_le'},
    'tay_son': {'visual': 'thoi_tay_son', 'architecture': 'kien_truc_tay_son',
                'audio': 'nhac_tran_quan'},
    'nguyen': {'visual': 'thoi_nguyen', 'architecture': 'kien_truc_nguyen_hue',
               'audio': 'nha_nhac_cung_dinh_hue'},
}
# Phong cách BỊ CẤM với mọi era — chống lạc thời đại (anachronism).
FORBIDDEN_STYLE = {'cyberpunk', 'neon', 'sci_fi', 'futuristic', 'steampunk',
                   'modern', 'hien_dai'}
REGIONS = ['bac_bo', 'trung_bo', 'nam_bo']
# Địa danh trấn/phủ lịch sử Việt — thay tên generic "Trấn Bac Bo 00"
REGION_NAMES = [
    'Trấn Đông Kinh', 'Trấn Kinh Bắc', 'Trấn Sơn Nam', 'Trấn Hải Dương',
    'Trấn Sơn Tây', 'Trấn An Bang', 'Trấn Tuyên Quang', 'Trấn Hưng Hóa',
    'Trấn Lạng Sơn', 'Trấn Thái Nguyên', 'Phủ Thanh Hóa', 'Phủ Nghệ An',
    'Phủ Thuận Hóa', 'Phủ Quảng Nam', 'Phủ Quy Nhơn', 'Phủ Phú Yên',
    'Dinh Thái Khang', 'Dinh Bình Thuận', 'Trấn Biên Hòa', 'Trấn Phiên An',
    'Trấn Định Tường', 'Trấn Vĩnh Thanh', 'Trấn Hà Tiên', 'Lục Tỉnh Gia Định',
    'Phủ Hoài Nhơn', 'Trấn Quảng Yên', 'Trấn Cao Bằng', 'Phủ Trường An',
    'Phủ Thiên Trường', 'Lộ Quốc Oai', 'Lộ Bắc Giang', 'Lộ Tam Đái',
]

# ── Phân bổ zone/tier — module-level để vào BUILD_RULE_HASH (đổi mà
# quên bump version -> cache region/map cũ bị từ chối reuse). Các hằng
# này quyết định: zone của region, số map mỗi zone, tier từng shard.
# Zone: 24 Bắc + 22 Trung + 18 Nam = 64. shard 0..23 Bắc, 24..45
# Trung, 46..63 Nam.
ZONE_PLAN = ['bac_bo'] * 24 + ['trung_bo'] * 22 + ['nam_bo'] * 18
# Map mỗi zone (spec): Bắc 3910 / Trung 3460 / Nam 2630 = 10000.
ZONE_MAP_TOTAL = {'bac_bo': 3910, 'trung_bo': 3460, 'nam_bo': 2630}
ZONE_REGION_COUNT = {'bac_bo': 24, 'trung_bo': 22, 'nam_bo': 18}
# Tier độ khó: T1=8, T2=14, T3=20, T4=14, T5=8 region. Vùng khởi đầu
# (T1) đặt ở 8 region đầu Bắc Bộ — quanh ĐB sông Hồng (Cổ Loa, Thăng
# Long, Phong Châu, Hoa Lư) đúng cái nôi sử Việt.
TIER_PLAN = [1]*8 + [2]*14 + [3]*20 + [4]*14 + [5]*8

# ════════════════════════════════════════════════════════════════════
# ── KHỐI REALM — 100 MAP CÕI ĐẶC BIỆT (Tiên Giới 50 + Âm Phủ 50) ──
# Special realm: cõi thần thoại VIỆT phục vụ chuyển sinh / event mùa /
# boss / phó bản cao cấp / quest linh hồn. KHÔNG thay map lịch sử trần
# gian. Sinh NHÁNH RIÊNG: map_id 10001-10100, era 'than_thoai'.
# Bám thần thoại Việt (Ngọc Hoàng, Tản Viên Sơn Thánh, vua Thủy Tề,
# Quỷ Môn Quan, Cầu Nại Hà) — KHÔNG tiên hiệp Trung, KHÔNG copy TS.
#
# DNA TS Online (readability — học cảm giác, KHÔNG copy content):
# mỗi sub-realm có nhịp "cổng -> đường -> NPC -> quái -> boss". 12
# sub-realm chia theo map_role: hub/gate (an toàn, không quái),
# combat (vùng train), boss (cuối tuyến).
# ════════════════════════════════════════════════════════════════════
REALM_FIRST_MAP_ID = 10001          # map realm bắt đầu sau 10000 map thường
REALM_ERA = 'than_thoai'            # era riêng — tách 10 era lịch sử
REALM_ERA_LABEL = 'Thần Thoại'

# 12 biome cõi = 6 Tiên Giới + 6 Âm Phủ (mỗi cõi 6 sub-realm)
REALM_BIOMES = [
    # ── Tiên Giới (celestial) ──
    'thien_mon', 'coi_troi', 'dong_tien',
    'tan_vien_linh_son', 'long_cung', 'thien_dai',
    # ── Âm Phủ (underworld) ──
    'quy_mon_quan', 'hoang_tuyen', 'u_minh_lo',
    'dia_phu_dien', 'me_cung_u_minh', 'vong_hon_dai',
]
# realm_group — 2 nhóm cõi lớn
REALM_GROUP = {
    'thien_mon': 'celestial', 'coi_troi': 'celestial',
    'dong_tien': 'celestial', 'tan_vien_linh_son': 'celestial',
    'long_cung': 'celestial', 'thien_dai': 'celestial',
    'quy_mon_quan': 'underworld', 'hoang_tuyen': 'underworld',
    'u_minh_lo': 'underworld', 'dia_phu_dien': 'underworld',
    'me_cung_u_minh': 'underworld', 'vong_hon_dai': 'underworld',
}
# zone cõi — tien_gioi / am_phu
REALM_ZONE = {b: ('tien_gioi' if g == 'celestial' else 'am_phu')
              for b, g in REALM_GROUP.items()}
# Số map mỗi sub-realm — tổng 100 (Tiên Giới 50 + Âm Phủ 50)
REALM_QUOTA = {
    # Tiên Giới 50: cổng 5 / cõi trời 10 / động tiên 10 /
    #               tản viên 10 / long cung 10 / thiên đài 5
    'thien_mon': 5, 'coi_troi': 10, 'dong_tien': 10,
    'tan_vien_linh_son': 10, 'long_cung': 10, 'thien_dai': 5,
    # Âm Phủ 50: quỷ môn 5 / hoàng tuyền 10 / u minh lộ 10 /
    #            địa phủ điện 10 / mê cung 10 / vọng hồn đài 5
    'quy_mon_quan': 5, 'hoang_tuyen': 10, 'u_minh_lo': 10,
    'dia_phu_dien': 10, 'me_cung_u_minh': 10, 'vong_hon_dai': 5,
}
# Nhãn tiếng Việt 12 sub-realm
REALM_BIOME_LABEL_VI = {
    'thien_mon': 'Cổng Thiên Môn', 'coi_troi': 'Cõi Trời',
    'dong_tien': 'Động Tiên', 'tan_vien_linh_son': 'Tản Viên Linh Sơn',
    'long_cung': 'Long Cung', 'thien_dai': 'Thiên Đài',
    'quy_mon_quan': 'Quỷ Môn Quan', 'hoang_tuyen': 'Bến Hoàng Tuyền',
    'u_minh_lo': 'U Minh Lộ', 'dia_phu_dien': 'Địa Phủ Điện',
    'me_cung_u_minh': 'Mê Cung U Minh', 'vong_hon_dai': 'Vọng Hồn Đài',
}
# map_role — vai trò gameplay (DNA TS Online): hub/gate an toàn không
# quái, combat vùng train, boss cuối tuyến.
REALM_MAP_ROLE = {
    'thien_mon': 'gate',       'coi_troi': 'hub',
    'dong_tien': 'combat',     'tan_vien_linh_son': 'combat',
    'long_cung': 'combat',     'thien_dai': 'boss',
    'quy_mon_quan': 'gate',    'hoang_tuyen': 'combat',
    'u_minh_lo': 'combat',     'dia_phu_dien': 'hub',
    'me_cung_u_minh': 'dungeon', 'vong_hon_dai': 'boss',
}
# realm_access — điều kiện mở cõi (map thường = 'open'):
# reborn = chuyển sinh; event = event mùa; quest = quest linh hồn/tiên duyên.
VALID_REALM_ACCESS = {'open', 'reborn', 'event', 'quest'}
REALM_ACCESS = {
    'thien_mon': 'reborn', 'coi_troi': 'reborn', 'dong_tien': 'quest',
    'tan_vien_linh_son': 'quest', 'long_cung': 'event',
    'thien_dai': 'reborn',
    'quy_mon_quan': 'reborn', 'hoang_tuyen': 'reborn',
    'u_minh_lo': 'quest', 'dia_phu_dien': 'reborn',
    'me_cung_u_minh': 'event', 'vong_hon_dai': 'reborn',
}
# tier cõi — đều end-game. gate/hub thấp hơn (4), combat/boss cao (5).
REALM_TIER = {
    'thien_mon': 4, 'coi_troi': 4, 'dong_tien': 4,
    'tan_vien_linh_son': 5, 'long_cung': 5, 'thien_dai': 5,
    'quy_mon_quan': 4, 'hoang_tuyen': 4, 'u_minh_lo': 5,
    'dia_phu_dien': 4, 'me_cung_u_minh': 5, 'vong_hon_dai': 5,
}
# spawn_policy cõi — (allow, profile, density_hint, zone_count_hint).
# map_role gate/hub -> KHÔNG quái (an toàn, NPC chuyển sinh/event).
# combat/dungeon -> có quái. boss -> 1 vùng boss.
REALM_SPAWN_PROFILE = {
    # gate / hub — không quái
    'thien_mon':         (False, 'none', 'none', 0),
    'coi_troi':          (False, 'none', 'none', 0),
    'quy_mon_quan':      (False, 'none', 'none', 0),
    'dia_phu_dien':      (False, 'none', 'none', 0),
    # combat — vùng train cõi
    'dong_tien':         (True, 'celestial_spirit', 'medium', 3),
    'tan_vien_linh_son': (True, 'mountain_spirit', 'medium', 4),
    'long_cung':         (True, 'dragon_palace_guard', 'medium', 4),
    'hoang_tuyen':       (True, 'wandering_soul', 'low', 3),
    'u_minh_lo':         (True, 'underworld_spirit', 'medium', 4),
    # dungeon — quái dày
    'me_cung_u_minh':    (True, 'ghost_guard', 'high', 5),
    # boss — 1 vùng boss cuối tuyến
    'thien_dai':         (True, 'sacred_beast', 'low', 2),
    'vong_hon_dai':      (True, 'underworld_spirit', 'low', 2),
}
# purpose cõi — dùng VALID_PURPOSES có sẵn (combat/lore/exploration/social).
REALM_PURPOSE = {
    'thien_mon':         ['social', 'lore', 'exploration'],
    'coi_troi':          ['social', 'lore', 'exploration'],
    'dong_tien':         ['combat', 'lore', 'exploration'],
    'tan_vien_linh_son': ['combat', 'lore', 'exploration'],
    'long_cung':         ['combat', 'exploration', 'lore'],
    'thien_dai':         ['combat', 'lore'],
    'quy_mon_quan':      ['social', 'lore', 'exploration'],
    'hoang_tuyen':       ['combat', 'lore', 'exploration'],
    'u_minh_lo':         ['combat', 'lore'],
    'dia_phu_dien':      ['social', 'lore', 'exploration'],
    'me_cung_u_minh':    ['combat', 'exploration'],
    'vong_hon_dai':      ['combat', 'lore'],
}
# terrain cõi — elevation/water_ratio/roughness.
REALM_TERRAIN = {
    'thien_mon':         {'elevation': 80, 'water_ratio': 5,  'roughness': 20},
    'coi_troi':          {'elevation': 95, 'water_ratio': 5,  'roughness': 25},
    'dong_tien':         {'elevation': 70, 'water_ratio': 15, 'roughness': 55},
    'tan_vien_linh_son': {'elevation': 85, 'water_ratio': 10, 'roughness': 65},
    'long_cung':         {'elevation': 10, 'water_ratio': 90, 'roughness': 25},
    'thien_dai':         {'elevation': 90, 'water_ratio': 5,  'roughness': 30},
    'quy_mon_quan':      {'elevation': 35, 'water_ratio': 10, 'roughness': 50},
    'hoang_tuyen':       {'elevation': 20, 'water_ratio': 55, 'roughness': 45},
    'u_minh_lo':         {'elevation': 20, 'water_ratio': 30, 'roughness': 60},
    'dia_phu_dien':      {'elevation': 30, 'water_ratio': 10, 'roughness': 40},
    'me_cung_u_minh':    {'elevation': 15, 'water_ratio': 25, 'roughness': 70},
    'vong_hon_dai':      {'elevation': 45, 'water_ratio': 15, 'roughness': 50},
}
# style cõi — CMD_ART/AUDIO bám. 2 nhóm: Tiên Giới sáng / Âm Phủ tối.
REALM_STYLE_BY_GROUP = {
    'celestial': {'visual': 'tien_gioi_viet',
                  'architecture': 'kien_truc_tien_gioi_viet',
                  'audio': 'nhac_tien_gioi'},
    'underworld': {'visual': 'am_phu_viet',
                   'architecture': 'kien_truc_am_phu_viet',
                   'audio': 'nhac_am_phu'},
}
# Tổng map realm — verify khớp REALM_QUOTA
REALM_MAP_COUNT = sum(REALM_QUOTA.values())   # = 100

# ════════════════════════════════════════════════════════════════════
# ── KHỐI MAP START — 2 MAP CỐT TRUYỆN MỞ ĐẦU ──
# Game xuyên không: player spawn ở Bảo tàng Lịch sử VN (2026) -> đi
# tới kệ sách cổ -> cổng dịch chuyển thời không -> Hoa Lư 968 gặp Sư
# Vạn Hạnh. 2 map đặc biệt, NHÁNH RIÊNG, map_id 10101-10102. KHÔNG
# đụng 10000 map thường + 100 map cõi.
# ════════════════════════════════════════════════════════════════════
START_FIRST_MAP_ID = TARGET_MAP_COUNT + REALM_MAP_COUNT + 1  # = 10101
START_MAP_COUNT = 2

# 2 era đặc biệt cho map start — tách khỏi 10 era thường + than_thoai.
# hien_dai = bối cảnh 2026 (bảo tàng); dinh = nhà Đinh, Hoa Lư 968.
START_ERAS = {
    'museum': 'hien_dai',     # Bảo tàng Lịch sử VN — năm 2026
    'hoa_lu': 'dinh',         # Hoa Lư — kinh đô nhà Đinh, 968
}
START_ERA_LABEL = {'hien_dai': 'Hiện Đại', 'dinh': 'Đinh'}

# 2 biome đặc biệt cho map start
START_BIOMES = ['bao_tang', 'co_do_hoa_lu']
START_BIOME_LABEL_VI = {
    'bao_tang': 'Bảo Tàng Lịch Sử',
    'co_do_hoa_lu': 'Cố Đô Hoa Lư',
}
# style 2 map start
START_STYLE = {
    'bao_tang': {'visual': 'bao_tang_hien_dai',
                 'architecture': 'kien_truc_bao_tang',
                 'audio': 'nhac_nen_tinh_lang'},
    'co_do_hoa_lu': {'visual': 'thoi_dinh',
                     'architecture': 'kien_truc_dinh_le',
                     'audio': 'nha_nhac_co'},
}
# TỔNG map toàn game = thường (10000) + cõi (100) + start (2) = 10102.
# Dùng cho load-check, SQL map_id range, test tổng.
TOTAL_MAP_COUNT = (TARGET_MAP_COUNT + REALM_MAP_COUNT
                   + START_MAP_COUNT)   # = 10102

log = logging.getLogger(CMD_NAME)
logging.basicConfig(level=logging.INFO, format='[%(name)s] %(message)s')

# Flag set bởi verify_foundation() — KHÔNG hardcode
FOUNDATION_VERIFIED = False

# ── seeded RNG (R68 — KHÔNG Math.random) ──
def seeded_int(seed_str, lo, hi):
    """Deterministic int từ seed string."""
    h = int(hashlib.sha256(seed_str.encode()).hexdigest(), 16)
    return lo + (h % (hi - lo + 1))

def seeded_pick(seed_str, options):
    return options[seeded_int(seed_str, 0, len(options) - 1)]

# ── G1 LOCK (kiểm duyệt cấp phép — KHÔNG phải era) ──
# g1 là nhãn kiểm duyệt để map "pass" cấp phép phát hành (Nghị định
# 147/2024/NĐ-CP). KHÔNG nhét g1 vào era. Hàm trả (g1_pass, g1_note).
# Logic đồng bộ với CMD_MAP — 1 chuẩn cho mọi CMD.
G1_CAM = [
    'tây sa', 'nam sa', 'tam sa', 'lưỡi bò', 'đường chín đoạn',
    'diệt chủng', 'tận diệt', 'thảm sát', 'tế sống', 'luyện cốt',
    'thiên linh', 'bùa hại', 'khỏa thân', 'dâm phụ', 'loạn luân',
    'ma túy', 'thuốc phiện', 'sòng bài', 'casino', 'poker',
    'man di', 'rợ hồ', 'quỷ vương', 'tà thần', 'chùa ma',
]
G1_IP = ['thiên long', 'võ lâm', 'kim dung', 'cổ long', 'pokemon', 'marvel']
# Địa danh nhạy cảm chủ quyền — dùng được nhưng PHẢI kèm ghi chú lore.
G1_NHAY_CAM = {
    'nam quan': 'Bối cảnh thời phong kiến, không phản ánh biên giới hiện hành.',
    'bản giốc': 'Danh thắng tự nhiên; không gắn yếu tố tranh chấp.',
    'hoàng sa': 'Quần đảo thuộc chủ quyền Việt Nam.',
    'trường sa': 'Quần đảo thuộc chủ quyền Việt Nam.',
}

def g1_check(text):
    """Kiểm tên map theo quy chuẩn G1. Trả (g1_pass: bool, g1_note: str)."""
    low = text.lower()
    for k in G1_CAM:
        if k in low:
            return False, f'CẤM: chứa từ vi phạm "{k}"'
    for k in G1_IP:
        if k in low:
            return False, f'CẤM: trùng IP bên thứ ba "{k}"'
    for k, note in G1_NHAY_CAM.items():
        if k in low:
            return True, note          # pass nhưng cần ghi chú lore
    return True, ''                    # an toàn

# ── cultural lock (R30) ──
# ── Cultural lock — place_lib.py là FILE THẬT, import trực tiếp ──
# Build ghi place_lib.py ra OUTPUT_DIR/tests/ NGAY đầu boot.
# Runtime + test cùng import từ file đó — 1 nguồn, IDE đọc được, không exec string.
PLACE_LIB_CONTENT = """# place_lib.py — 1 nguồn logic cultural lock (test + runtime dùng chung)
import re

# Chặn Hiragana + Katakana (chữ Nhật). KHÔNG chặn CJK toàn cục
# vì địa danh Hán-Việt lịch sử (bia đá, chữ cổ) hợp lệ.
JP_KANA_RE = re.compile(r'[\\u3040-\\u309F\\u30A0-\\u30FF]')
# Chặn nhân vật Tam Quốc (cả tiếng Việt lẫn chữ Hán tên riêng).
TAM_QUOC_RE = re.compile(
    r'(Tào Tháo|Lưu Bị|Quan Vũ|Trương Phi|Khổng Minh|Tam Quốc|\u66f9\u64cd|\u5289\u5099)')

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
    \"\"\"True nếu text hợp lệ: không chữ Nhật, không tên Tam Quốc,
    không nội dung lịch sử nhạy cảm chính trị hiện đại.\"\"\"
    return (not JP_KANA_RE.search(text)
            and not TAM_QUOC_RE.search(text)
            and not MODERN_SENSITIVE_RE.search(text))

# ERAS/BIOMES/TARGET — 1 nguồn cho test (runtime sinh với giá trị thật)
ERAS = __ERAS__
BIOMES = __BIOMES__
TARGET_REGION_SHARDS = __TARGET_SHARDS__
TARGET_MAP_COUNT = __TARGET_MAPS__
SHARD_GRID_WIDTH = __GRID_W__
SHARD_CELL_SIZE = __CELL__
MAP_GRID_WIDTH = __MAP_GW__
MAP_CELL_SIZE = __MAP_CELL__
"""

def ensure_place_lib():
    """Ghi place_lib.py ra đĩa rồi import — reload để daemon dài ngày không dùng cache cũ.
    BugA fix: Lock toàn bộ + tmp unique per (pid, thread) — chống WinError 32
    khi concurrent thread cùng ghi/replace cùng .tmp file."""
    import importlib
    with _PLACE_LIB_LOCK:
        lib_dir = OUTPUT_DIR / 'tests'
        lib_dir.mkdir(parents=True, exist_ok=True)
        lib_path = lib_dir / 'place_lib.py'
        # Nhúng ERAS/BIOMES thật vào place_lib — test đọc cùng 1 nguồn
        content = (PLACE_LIB_CONTENT
                   .replace('__ERAS__', repr(ERAS))
                   .replace('__BIOMES__', repr(BIOMES))
                   .replace('__TARGET_SHARDS__', repr(TARGET_REGION_SHARDS))
                   .replace('__TARGET_MAPS__', repr(TARGET_MAP_COUNT))
                   .replace('__GRID_W__', repr(SHARD_GRID_WIDTH))
                   .replace('__CELL__', repr(SHARD_CELL_SIZE))
                   .replace('__MAP_GW__', repr(MAP_GRID_WIDTH))
                   .replace('__MAP_CELL__', repr(MAP_CELL_SIZE)))
        # Chỉ ghi khi nội dung khác — tránh IO dư mỗi boot, giảm race
        new_hash = hashlib.sha256(content.encode()).hexdigest()
        old_hash = (hashlib.sha256(lib_path.read_bytes()).hexdigest()
                    if lib_path.exists() else None)
        if new_hash != old_hash:
            # Atomic write + tmp UNIQUE per (pid, thread_id) — chống race
            # Windows os.replace fail nếu 2 thread cùng dùng 1 tmp name.
            tmp = lib_path.with_suffix(f'.py.tmp.{os.getpid()}.{threading.get_ident()}')
            with open(tmp, 'wb') as f:   # BugD: 'wb' giữ LF nguyên (no Win CRLF translate)
                f.write(content.encode('utf-8'))
                f.flush(); os.fsync(f.fileno())
            os.replace(tmp, lib_path)
        if str(lib_dir) not in sys.path:
            sys.path.insert(0, str(lib_dir))
        importlib.invalidate_caches()
        if 'place_lib' in sys.modules:
            place_lib = importlib.reload(sys.modules['place_lib'])
        else:
            import place_lib
        return place_lib.cultural_lock_ok

# cultural_lock_ok gán khi boot (trong safe_main, sau OUTPUT_DIR sẵn sàng)
cultural_lock_ok = None

# ── Foundation verify (v2.10.0 + hash đúng) ──
def verify_foundation():
    if not REPO_DIR.exists():
        subprocess.run(['git', 'clone', '--depth=1', REPO_URL, str(REPO_DIR)],
                       check=True, timeout=120)
    fp = REPO_DIR / 'foundation' / FOUNDATION_FILE
    if not fp.exists():
        print(f"FOUNDATION_NOT_FOUND: {fp}"); sys.exit(99)
    actual = hashlib.sha256(fp.read_bytes()).hexdigest()
    if actual != FOUNDATION_HASH:
        print(f"FOUNDATION_HASH_MISMATCH actual={actual}"); sys.exit(99)
    global FOUNDATION_VERIFIED
    FOUNDATION_VERIFIED = True
    log.info("Foundation v2.10.0 verified")

def get_default_branch():
    """Dò default branch (main/master) từ origin/HEAD — không hardcode."""
    global DEFAULT_BRANCH, DEFAULT_BRANCH_TS
    # Cache có TTL — daemon sống dài, default branch đổi vẫn cập nhật
    if DEFAULT_BRANCH and (time.time() - DEFAULT_BRANCH_TS) < DEFAULT_BRANCH_TTL:
        return DEFAULT_BRANCH
    DEFAULT_BRANCH_TS = time.time()
    try:
        r = subprocess.run(['git','-C',str(REPO_DIR),'symbolic-ref',
                            'refs/remotes/origin/HEAD'], capture_output=True, text=True, timeout=15)
        if r.returncode == 0:
            DEFAULT_BRANCH = r.stdout.strip().split('/')[-1]
        else:
            DEFAULT_BRANCH = 'main'
    except Exception:
        DEFAULT_BRANCH = 'main'
    return DEFAULT_BRANCH

# ── R71: tận dụng region.jsonl — CHỈ khi schema + foundation + content hash khớp ──
SCHEMA_VERSION = f'place-v{CMD_VERSION}'  # tự khớp CMD_VERSION
# BUILD_RULE_HASH — hash các BẢNG LOGIC sinh dữ liệu. Nếu sửa
# BIOME_PURPOSE / PURPOSE_ANCHOR / ANCHOR_CAP / BIOME_TERRAIN /
# BIOME_QUOTA / ERA_STYLE mà QUÊN bump CMD_VERSION -> hash này đổi ->
# cache cũ bị từ chối reuse (chống reuse stale world data — bug ẩn
# nguy hiểm: build PASS nhưng map không theo logic mới).
def _compute_build_rule_hash():
    # Hash ĐỦ mọi hằng build_regions/build_maps/build_anchors phụ thuộc
    # (đã rà bằng ast — KHÔNG liệt kê theo trí nhớ). Gồm: bảng logic +
    # topology (grid/cell/version) + dataset (eras/biomes/region names)
    # + target. Bất kỳ hằng nào đổi mà quên bump version -> hash đổi ->
    # cache cũ bị từ chối reuse.
    import json as _json
    blob = _json.dumps({
        # bảng logic gameplay
        'biome_purpose': BIOME_PURPOSE,
        'purpose_anchor': PURPOSE_ANCHOR,
        'anchor_cap': ANCHOR_CAP,
        'biome_terrain': BIOME_TERRAIN,
        'biome_quota': BIOME_QUOTA,
        'era_style': ERA_STYLE,
        'cluster_biomes': CLUSTER_BIOMES,
        'zone_forbid': ZONE_FORBID,
        'biome_group': BIOME_GROUP,
        'biome_label_vi': BIOME_LABEL_VI,
        'era_label': ERA_LABEL,
        'important_biomes': sorted(IMPORTANT_BIOMES),
        'spawn_profile': {k: list(v) for k, v in SPAWN_PROFILE.items()},
        # topology — đổi grid/cell/version thì coord & shard đổi hết
        'topology_version': TOPOLOGY_VERSION,
        'shard_grid_width': SHARD_GRID_WIDTH,
        'shard_cell_size': SHARD_CELL_SIZE,
        'map_grid_width': MAP_GRID_WIDTH,
        'map_cell_size': MAP_CELL_SIZE,
        # dataset — đổi danh sách era/biome/region thì map khác hẳn
        'eras': ERAS,
        'biomes': BIOMES,
        'region_names': REGION_NAMES,
        'target_map_count': TARGET_MAP_COUNT,
        'target_region_shards': TARGET_REGION_SHARDS,
        'uuid_ns': str(UUID_NS),
        # ── REALM — 100 map cõi đặc biệt. Đổi bất kỳ bảng realm nào
        # mà quên bump version -> hash đổi -> cache cũ bị từ chối.
        'realm_biomes': REALM_BIOMES,
        'realm_group': REALM_GROUP,
        'realm_zone': REALM_ZONE,
        'realm_quota': REALM_QUOTA,
        'realm_biome_label_vi': REALM_BIOME_LABEL_VI,
        'realm_map_role': REALM_MAP_ROLE,
        'realm_access': REALM_ACCESS,
        'realm_tier': REALM_TIER,
        'realm_spawn_profile': {k: list(v)
            for k, v in REALM_SPAWN_PROFILE.items()},
        'realm_purpose': REALM_PURPOSE,
        'realm_terrain': REALM_TERRAIN,
        'realm_style_by_group': REALM_STYLE_BY_GROUP,
        'realm_era': REALM_ERA,
        'realm_first_map_id': REALM_FIRST_MAP_ID,
        # ── START — 2 map cốt truyện mở đầu ──
        'start_eras': START_ERAS,
        'start_era_label': START_ERA_LABEL,
        'start_biomes': START_BIOMES,
        'start_biome_label_vi': START_BIOME_LABEL_VI,
        'start_style': START_STYLE,
        'start_first_map_id': START_FIRST_MAP_ID,
        'start_map_count': START_MAP_COUNT,
        'total_map_count': TOTAL_MAP_COUNT,
        # phân bổ zone/tier — đổi thì zone/quota/tier của region đổi
        'zone_plan': ZONE_PLAN,
        'zone_map_total': ZONE_MAP_TOTAL,
        'zone_region_count': ZONE_REGION_COUNT,
        'tier_plan': TIER_PLAN,
        # G1 + cultural/style — đổi luật thì g1_pass/g1_note/name/style
        # cũ có thể sai -> cache phải invalidate
        'g1_cam': G1_CAM,
        'g1_ip': G1_IP,
        'g1_nhay_cam': G1_NHAY_CAM,
        'forbidden_style': sorted(FORBIDDEN_STYLE),
        'place_lib_sha': hashlib.sha256(PLACE_LIB_CONTENT.encode()).hexdigest(),
    }, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()
BUILD_RULE_HASH = _compute_build_rule_hash()
def load_existing_regions():
    fp = REPO_DIR / 'cmd-place' / 'output' / 'registry' / 'region.jsonl'
    sidecar = fp.with_suffix('.jsonl.meta')
    if not fp.exists() or not sidecar.exists():
        return None
    try:
        rows = [json.loads(l) for l in fp.read_text(encoding='utf-8').splitlines() if l.strip()]
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        log.warning(f"region.jsonl hỏng ({e}) → sinh mới"); return None
    if len(rows) != TARGET_REGION_SHARDS:
        return None
    # 3 lớp kiểm trước khi reuse — .meta hỏng cũng regenerate, không crash:
    try:
        meta = json.loads(sidecar.read_text())
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        log.warning(f"region.jsonl.meta hỏng ({e}) → sinh mới"); return None
    # (a) schema_version khớp
    if meta.get('schema_version') != SCHEMA_VERSION:
        log.info("Region schema lệch → sinh mới"); return None
    # (b) foundation_hash khớp (foundation đổi → region phải gen lại)
    if meta.get('foundation_hash') != FOUNDATION_HASH:
        log.info("Foundation đổi → region sinh mới"); return None
    # build rule (bảng logic + topology + dataset) đổi → sinh mới
    if meta.get('build_rule_hash') != BUILD_RULE_HASH:
        log.info("Build rule đổi → region sinh mới"); return None
    # topology_version đổi → cấu trúc bất biến đổi, sinh mới
    if meta.get('topology_version') != TOPOLOGY_VERSION:
        log.info("Topology version đổi → region sinh mới"); return None
    # (c) content_hash khớp (file bị sửa tay → từ chối reuse)
    actual_hash = hashlib.sha256(fp.read_bytes()).hexdigest()
    if meta.get('content_hash') != actual_hash:
        log.info("Region file bị sửa tay → sinh mới"); return None
    # (d) target không đổi (đổi 64→128 mà quên tăng schema_version → vẫn bắt được)
    if meta.get('target_region_shards') != TARGET_REGION_SHARDS:
        log.info("TARGET_REGION_SHARDS đổi → sinh mới"); return None
    if meta.get('target_map_count') != TARGET_MAP_COUNT:
        log.info("TARGET_MAP_COUNT đổi → sinh mới"); return None
    return rows

def load_existing_maps():
    """Reuse map_registry.jsonl nếu còn nguyên — incremental build.
    CHỈ reuse khi region cũng reuse được (region đổi -> map phải gen
    lại). Cùng 4 lớp kiểm như region: schema, foundation, content_hash,
    target. File bị sửa tay -> từ chối reuse."""
    fp = REPO_DIR / 'cmd-place' / 'output' / 'registry' / 'map_registry.jsonl'
    sidecar = fp.with_suffix('.jsonl.meta')
    if not fp.exists() or not sidecar.exists():
        return None
    try:
        rows = [json.loads(l) for l in fp.read_text(encoding='utf-8').splitlines() if l.strip()]
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        log.warning(f"map_registry.jsonl hỏng ({e}) → sinh mới"); return None
    if len(rows) != TOTAL_MAP_COUNT:
        return None
    try:
        meta = json.loads(sidecar.read_text())
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        log.warning(f"map_registry.jsonl.meta hỏng ({e}) → sinh mới"); return None
    if meta.get('schema_version') != SCHEMA_VERSION:
        log.info("Map schema lệch → sinh mới"); return None
    if meta.get('foundation_hash') != FOUNDATION_HASH:
        log.info("Foundation đổi → map sinh mới"); return None
    # build rule (bảng logic + topology + dataset) đổi → sinh mới
    if meta.get('build_rule_hash') != BUILD_RULE_HASH:
        log.info("Build rule đổi → map sinh mới"); return None
    # topology_version đổi → cấu trúc bất biến đổi, sinh mới
    if meta.get('topology_version') != TOPOLOGY_VERSION:
        log.info("Topology version đổi → map sinh mới"); return None
    actual_hash = hashlib.sha256(fp.read_bytes()).hexdigest()
    if meta.get('content_hash') != actual_hash:
        log.info("Map file bị sửa tay → sinh mới"); return None
    if meta.get('target_map_count') != TARGET_MAP_COUNT:
        log.info("TARGET_MAP_COUNT đổi → map sinh mới"); return None
    if meta.get('target_region_shards') != TARGET_REGION_SHARDS:
        log.info("TARGET_REGION_SHARDS đổi → map sinh mới"); return None
    return rows

def write_meta(fp):
    """Ghi sidecar .meta cho file jsonl — verify consistency lần sau."""
    meta = {'schema_version': SCHEMA_VERSION,
            'foundation_hash': FOUNDATION_HASH,
            'build_rule_hash': BUILD_RULE_HASH,
            'topology_version': TOPOLOGY_VERSION,
            'content_hash': hashlib.sha256(fp.read_bytes()).hexdigest(),
            'target_region_shards': TARGET_REGION_SHARDS,
            'target_map_count': TARGET_MAP_COUNT}
    # Atomic write — SIGTERM giữa chừng không để .meta dở.
    # BugD: newline='' giữ LF (.gitattributes pin .meta-like JSON eol=lf)
    meta_fp = fp.with_suffix('.jsonl.meta')
    tmp = fp.with_suffix('.jsonl.meta.tmp')
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        f.write(json.dumps(meta, indent=2))
        f.flush(); os.fsync(f.fileno())
    os.replace(tmp, meta_fp)

# ── BUILD: sinh 64 region + 10000 map THẬT ──
_region_was_reused = False
def build_regions(force_regen=False):
    """64 region shard. R71: dùng lại nếu đã có. force_regen=True ép sinh mới.
    Phân 24 Bắc Bộ / 22 Trung Bộ / 18 Nam Bộ; gán tier độ khó 1-5
    (T1 an toàn quanh ĐB sông Hồng -> T5 hiểm, biên giới xa)."""
    global _region_was_reused
    existing = None if force_regen else load_existing_regions()
    if existing:
        _region_was_reused = True
        log.info(f"R71 reuse: {len(existing)} region có sẵn")
        return existing
    _region_was_reused = False

    # ZONE_PLAN / ZONE_MAP_TOTAL / ZONE_REGION_COUNT / TIER_PLAN dùng
    # module-level (đã đưa ra ngoài để vào BUILD_RULE_HASH).
    regions = []
    for sid in range(TARGET_REGION_SHARDS):
        rg = ZONE_PLAN[sid]
        tier = TIER_PLAN[sid]
        era = ERAS[sid % len(ERAS)]
        biome = BIOMES[sid % len(BIOMES)]
        # quota map của region = chia đều map của zone cho số region zone đó,
        # cộng phần dư vào region đầu zone (deterministic).
        zmaps = ZONE_MAP_TOTAL[rg]
        zcount = ZONE_REGION_COUNT[rg]
        idx_in_zone = sid if rg == 'bac_bo' else (sid - 24 if rg == 'trung_bo' else sid - 46)
        quota = zmaps // zcount + (1 if idx_in_zone < zmaps % zcount else 0)
        regions.append({
            'shard_id': sid,
            'shard_code': f'SH{sid:02d}',
            'name': REGION_NAMES[sid % len(REGION_NAMES)] + (f' {sid // len(REGION_NAMES) + 1}' if sid >= len(REGION_NAMES) else ''),
            'zone': rg,                          # bac_bo / trung_bo / nam_bo
            'tier': tier,                        # 1 (an toàn) .. 5 (hiểm)
            'primary_era': era,
            'biome_focus': biome,
            'expected_map_count': quota,
            'actual_map_count': 0,
            'natural_key': f'svtk_region_{rg}_{sid:03d}',
            'schema_version': SCHEMA_VERSION,
        })
    return regions

def build_anchors(seed, biome, tier, map_id, purposes=None):
    """Sinh anchor registry cho 1 map — deterministic theo seed.
    CMD_PLACE chỉ sinh CHỖ NEO (id + tọa độ tương đối + loại), KHÔNG
    spawn nội dung. CMD khác đọc anchor rồi fill.
    Density theo TIER × BIOME × PURPOSE: loại anchor nào được nhiều
    purpose của biome dẫn về thì sinh nhiều hơn (vd capital có
    social+trade+exploration đều -> activity_anchor -> nhiều activity;
    battlefield combat-heavy -> nhiều npc_anchor). KHÔNG vượt ANCHOR_CAP.
    purposes: nếu truyền (map realm) -> dùng trực tiếp; None -> tra
    BIOME_PURPOSE theo biome (map thường)."""
    if purposes is None:
        purposes = BIOME_PURPOSE.get(biome, [])
    # đếm: mỗi loại anchor được BAO NHIÊU purpose của biome này dẫn về.
    # purpose_weight càng cao -> loại anchor đó là "đặc trưng" của biome.
    purpose_weight = {}
    for p in purposes:
        if p in PURPOSE_ANCHOR:
            at = PURPOSE_ANCHOR[p]
            purpose_weight[at] = purpose_weight.get(at, 0) + 1
    need = set(purpose_weight)
    need.add('portal_anchor')   # map nào cũng có lối đi
    if 'combat' in purposes and tier >= 3:
        need.add('boss_anchor')

    anchors = {}
    for atype in sorted(need):
        cap = ANCHOR_CAP[atype]
        # weight = số purpose dẫn về loại này (portal/boss = 1 mặc định).
        weight = purpose_weight.get(atype, 1)
        # density = hàm của tier VÀ weight; cap CHỈ làm trần. KHÔNG chia
        # cap (bug cũ: cap//4 với cap nhỏ = 0 -> density luôn = 1, cap
        # vô nghĩa). tier 1 -> nền thấp, tier cao -> dày hơn, weight cao
        # -> dày hơn; cuối cùng min với cap.
        lo = 1
        hi = max(1, min(cap, weight * (1 + tier)))
        n = seeded_int(seed + f':na:{atype}', lo, hi)
        items = []
        for i in range(n):
            items.append({
                # anchor_id GẮN map_id -> unique toàn cục (runtime tool
                # tương lai dùng anchor_id global không bị đụng).
                'anchor_id': f'm{map_id:05d}_{atype[:3]}_{i:02d}',
                'rel_x': seeded_int(seed + f':ax:{atype}:{i}', 0, 100),
                'rel_y': seeded_int(seed + f':ay:{atype}:{i}', 0, 100),
            })
        anchors[atype] = items
    return anchors

def build_maps(regions, build_stage=None):
    """10000 map theo BẢNG PHÂN BỔ spec: 2500 map quan trọng + 7500 nền.
    Mỗi region sinh ĐÚNG expected_map_count của nó. Biome chọn theo
    quota toàn cục (BIOME_QUOTA) — biome nào còn thiếu nhiều nhất so
    với quota thì ưu tiên. Hang động sinh theo CỤM nhiều tầng liền nhau.
    Ràng địa danh theo vùng: kinh đô/ải/thương cảng CHỈ ở đúng zone.
    build_stage: list [stage, progress] dùng chung heartbeat — cập nhật
    progress 'N/10000' để forensic theo dõi build cực lớn. None -> bỏ qua."""
    maps = []
    map_id = 1

    # ── Ràng buộc địa danh theo zone — dùng ZONE_FORBID module-level
    # (đã đưa ra ngoài để vào BUILD_RULE_HASH). set() để check nhanh.
    zone_forbid_set = {z: set(v) for z, v in ZONE_FORBID.items()}
    # Tổng map mỗi zone (để chia quota biome theo zone).
    zone_total = {'bac_bo': 0, 'trung_bo': 0, 'nam_bo': 0}
    for r in regions:
        zone_total[r['zone']] += r['expected_map_count']

    # ── PHÂN QUOTA BIOME THEO ZONE (thuật toán largest-remainder) ──
    # Lập ma trận quota_zone[zone][biome] sao cho: tổng mỗi zone = số
    # map zone đó; tổng mỗi biome = BIOME_QUOTA; ô biome cấm zone = 0.
    # Duyệt biome theo thứ tự BIOMES (deterministic), chia quota mỗi
    # biome cho các zone được phép theo tỉ lệ map zone CÒN LẠI, phần dư
    # phát cho zone có phân số lớn nhất.
    quota_zone = {z: {b: 0 for b in BIOME_QUOTA} for z in zone_total}
    _zone_remain = dict(zone_total)          # map còn cần mỗi zone
    for b in BIOMES:
        total = BIOME_QUOTA[b]
        allowed = [z for z in zone_total if b not in ZONE_FORBID[z]]
        base = sum(_zone_remain[z] for z in allowed)
        if base <= 0:
            quota_zone[allowed[0]][b] = total
            _zone_remain[allowed[0]] -= total
            continue
        raw = {z: total * _zone_remain[z] / base for z in allowed}
        floor = {z: int(raw[z]) for z in allowed}
        rem = total - sum(floor.values())
        order = sorted(allowed, key=lambda z: raw[z] - floor[z], reverse=True)
        for i in range(rem):
            floor[order[i]] += 1
        for z in allowed:
            quota_zone[z][b] = floor[z]
            _zone_remain[z] -= floor[z]
    # CLUSTER_BIOMES dùng module-level (đã đưa ra ngoài để vào
    # BUILD_RULE_HASH). Giá trị là [lo, hi] — dùng như tuple bên dưới.

    # quota_left giờ tách theo zone
    quota_left = {z: dict(quota_zone[z]) for z in quota_zone}

    for r in regions:
        sid = r['shard_id']
        zone = r['zone']
        era = r['primary_era']
        n = r['expected_map_count']
        cluster_run = 0
        cluster_biome = None

        for k in range(n):
            seed = f'place:map:{map_id}'

            if cluster_run > 0:
                # đang trong cụm → tiếp tục cùng biome
                biome = cluster_biome
                cluster_run -= 1
            else:
                # chọn biome trong quota CỦA ZONE NÀY. Biome cấm zone đã
                # có quota_zone = 0 nên tự động không xuất hiện trong avail.
                qz = quota_left[zone]
                avail = [b for b in BIOME_QUOTA if qz[b] > 0]
                # ưu tiên biome còn thiếu NHIỀU NHẤT so quota zone của nó
                biome = max(avail,
                            key=lambda b: (qz[b] / max(quota_zone[zone][b], 1),
                                           -BIOMES.index(b)))
                # nếu biome này sinh theo cụm → mở cụm
                if biome in CLUSTER_BIOMES:
                    lo, hi = CLUSTER_BIOMES[biome]
                    depth = seeded_int(seed + ':depth', lo, hi)
                    # không vượt quota còn lại của biome (trong zone),
                    # không vượt map còn lại của region
                    depth = min(depth, quota_left[zone][biome], n - k)
                    cluster_biome = biome
                    cluster_run = depth - 1

            quota_left[zone][biome] -= 1
            biome_vi = BIOME_LABEL_VI.get(biome, biome.title())
            name = f'{biome_vi} {ERA_LABEL[era]} (#{map_id:05d})'
            if not cultural_lock_ok(name):
                name = f'Vùng Đất {map_id:05d}'
            g1_pass, g1_note = g1_check(name)
            # safe_zone: hub xã hội LUÔN an toàn; biome combat-heavy
            # KHÔNG bao giờ an toàn; còn lại theo tier <= 2.
            _safe = (biome in ('capital', 'capital_inner', 'town', 'village')
                     or (r['tier'] <= 2
                         and biome not in ('battlefield', 'frontier_pass',
                                            'cave')))
            # spawn_policy: gợi ý vùng quái cho CMD_MAP. KHÓA — safe_zone
            # thì TUYỆT ĐỐI không quái (allow=False, profile=none, zone=0),
            # bất kể biome. CMD_NPC điền monster/level/drop sau.
            _sp = list(SPAWN_PROFILE.get(biome, (False, 'none', 'none', 0)))
            if _safe:
                _sp = [False, 'none', 'none', 0]
            _spawn_policy = dict(zip(
                ('allow_monster_spawn', 'spawn_profile',
                 'density_hint', 'zone_count_hint'), _sp))
            maps.append({
                'uuid': str(uuid.uuid5(UUID_NS, f'svtk_place_{era}_{biome}_{map_id:05d}')),
                'map_id': map_id,
                'natural_key': f'svtk_place_{era}_{biome}_{map_id:05d}',
                'topology_version': TOPOLOGY_VERSION,  # khóa cấu trúc bất biến
                'name': name,
                'era': era,                       # internal: ly/tran/.../f1-f5
                'era_label': ERA_LABEL[era],      # tên đẹp tiếng Việt
                # era_display: TRƯỜNG PLAYER-FACING. UI client CHỈ đọc
                # trường này — luôn là tên triều đại tiếng Việt, KHÔNG
                # bao giờ lộ mã f1-f5 ra giao diện người chơi.
                'era_display': ERA_LABEL[era],
                'biome': biome,
                'biome_label': biome_vi,
                'biome_group': BIOME_GROUP.get(biome, 'city'),
                'is_important': biome in IMPORTANT_BIOMES,  # map quan trọng?
                # purpose: công năng gameplay — CMD khác bám vào fill nội dung
                'purpose': list(BIOME_PURPOSE.get(biome, [])),
                # style: khóa phong cách hình/âm/kiến trúc — CMD_ART/AUDIO bám
                'style': dict(ERA_STYLE[era]),
                'zone': zone,
                'tier': r['tier'],                          # độ khó 1-5
                'shard_id': sid,
                'shard_code': r['shard_code'],
                'f_prefix': era if era in ('f1','f2','f3','f4','f5') else 'none',
                # g1: nhãn kiểm duyệt cấp phép — KHÔNG phải era
                'g1_pass': g1_pass,
                'g1_note': g1_note,
                'coord_x': (sid % SHARD_GRID_WIDTH) * SHARD_CELL_SIZE + (k % MAP_GRID_WIDTH) * MAP_CELL_SIZE,
                'coord_y': (sid // SHARD_GRID_WIDTH) * SHARD_CELL_SIZE + (k // MAP_GRID_WIDTH) * MAP_CELL_SIZE,
                # ── SPATIAL LAYER — chuẩn bị AOI / streaming / combat boundary ──
                # chunk: ô lưới lớn cho Area-Of-Interest streaming.
                # safe_zone: tier 1-2 = vùng an toàn (PvE nhẹ, không PK).
                # combat_zone: biome có purpose combat = vùng chiến đấu.
                # nav_region: khóa pathfinding theo shard (NPC không qua shard).
                'chunk_x': ((sid % SHARD_GRID_WIDTH) * MAP_GRID_WIDTH + (k % MAP_GRID_WIDTH)) // 8,
                'chunk_y': ((sid // SHARD_GRID_WIDTH) * MAP_GRID_WIDTH + (k // MAP_GRID_WIDTH)) // 8,
                # safe_zone: hub xã hội (kinh đô/thị trấn/làng) LUÔN an
                # toàn; biome combat-heavy (chiến trường/ải) KHÔNG bao
                # giờ an toàn dù tier thấp; còn lại theo tier <= 2.
                'safe_zone': _safe,
                'combat_zone': 'combat' in BIOME_PURPOSE.get(biome, []),
                # spawn_policy — gợi ý vùng quái cho CMD_MAP. CHỈ gợi ý,
                # KHÔNG sinh quái thật. safe_zone -> luôn không quái.
                'spawn_policy': _spawn_policy,
                'nav_region': f'nav_{sid:02d}',
                # terrain profile — CMD_MAP / pathfinding / spawn dùng
                'terrain': dict(BIOME_TERRAIN.get(biome,
                                {'elevation': 20, 'water_ratio': 10, 'roughness': 20})),
                # anchor registry — CMD_PLACE chỉ sinh CHỖ NEO, CMD khác fill
                'anchors': build_anchors(seed, biome, r['tier'], map_id),
                # tags dùng era_label (tên đẹp) — tag có thể bị UI render,
                # không để lộ mã f1-f5. Internal lọc theo 'era'/'f_prefix'.
                'tags': [ERA_LABEL[era], biome, BIOME_GROUP.get(biome, 'city'), zone, f'tier{r["tier"]}'],
                # tsonline_cross_ref: tham chiếu scene TS Online. Seed
                # theo ERA+BIOME (không phải map_id) -> map cùng era+
                # biome trỏ về cùng vùng TS, có ý nghĩa hơn random thuần.
                # TẠM: chưa có bảng mapping TS scene chính thức -> khi có
                # cần thay bằng bucket era/biome/purpose -> TS scene thật.
                'tsonline_cross_ref': seeded_int(f'ts:{era}:{biome}', 1, 7047),
                # realm_access: map thường LUÔN 'open' (vào tự do).
                # Chỉ map cõi đặc biệt mới reborn/event/quest.
                'realm_access': 'open',
                'is_start_map': False,   # map thường KHÔNG phải map spawn
                'realm_group': 'none',   # map thường không thuộc cõi
                'map_role': 'normal',    # map thường — vai trò chuẩn
            })
            map_id += 1
        r['actual_map_count'] = n
        # cập nhật progress cho heartbeat — sau mỗi region (đủ mịn cho
        # forensic, không ghi quá dày). map_id-1 = số map đã sinh.
        if build_stage is not None:
            build_stage[1] = f'{map_id - 1}/{TARGET_MAP_COUNT}'

    # ── PORTAL GRAPH — nối map liền kề trong cùng shard ──
    # portal_anchor là CHỖ NEO; portal_graph là LIÊN KẾT thật giữa map.
    # Mỗi cạnh bidirectional sinh CẢ 2 chiều (map A->B VÀ B->A) để
    # runtime portal/fast-travel/AI nav không lệch. Dùng index cache
    # O(n) thay chain.index() O(n²) — scale tới 100k+ map.
    by_shard = {}
    for mp in maps:
        by_shard.setdefault(mp['shard_id'], []).append(mp['map_id'])
    # map_id -> dict map (truy cập O(1)) + khởi tạo portal_graph rỗng
    by_id = {}
    for mp in maps:
        mp['portal_graph'] = []
        by_id[mp['map_id']] = mp

    def _add_edge(a, b):
        """Thêm cạnh bidirectional a<->b — sinh CẢ 2 chiều. Chống
        self-loop (a==b) và duplicate (cạnh đã có)."""
        if a == b:
            return                       # không self-loop
        ga, gb = by_id[a]['portal_graph'], by_id[b]['portal_graph']
        if any(lk['to_map'] == b for lk in ga):
            return                       # không duplicate
        ga.append({'from_map': a, 'to_map': b, 'bidirectional': True})
        gb.append({'from_map': b, 'to_map': a, 'bidirectional': True})

    for sid, chain in by_shard.items():
        # nối map liền kề trong shard
        for i in range(len(chain) - 1):
            _add_edge(chain[i], chain[i + 1])
        # map đầu shard nối sang map đầu shard kế -> liên thông toàn cục
        if sid + 1 in by_shard:
            _add_edge(chain[0], by_shard[sid + 1][0])
    return maps


# ── BUILD: sinh 100 MAP CÕI ĐẶC BIỆT (Tiên Giới 50 + Âm Phủ 50) ──
def build_realm_maps():
    """Sinh 100 map cõi đặc biệt — NHÁNH RIÊNG, map_id 10001-10100.
    KHÔNG đụng 10000 map thường. Mỗi map cõi có cấu trúc record GIỐNG
    map thường (đủ trường) + thêm 'realm_access'. era='than_thoai',
    zone='tien_gioi'/'am_phu', shard_id=0 (cõi không thuộc shard địa
    lý — gán 0 cho qua check shard_id_valid; portal cõi nối nội bộ
    theo biome, KHÔNG nối map thường). Deterministic theo seed."""
    realm_maps = []
    map_id = REALM_FIRST_MAP_ID
    # coord cõi: đặt vào KHE giữa cột map thường (offset +15, bội 30
    # của map thường nên +15 chắc chắn không trùng), vẫn trong range
    # [0, _coord_max]. Mỗi cõi 1 hàng riêng -> coord không trùng nhau.
    _cx_max = ((SHARD_GRID_WIDTH - 1) * SHARD_CELL_SIZE
               + (MAP_GRID_WIDTH - 1) * MAP_CELL_SIZE)
    for bi, biome in enumerate(REALM_BIOMES):
        n = REALM_QUOTA[biome]
        zone = REALM_ZONE[biome]
        group = REALM_GROUP[biome]            # celestial / underworld
        role = REALM_MAP_ROLE[biome]          # gate/hub/combat/dungeon/boss
        tier = REALM_TIER[biome]
        access = REALM_ACCESS[biome]
        biome_vi = REALM_BIOME_LABEL_VI[biome]
        purpose = list(REALM_PURPOSE[biome])
        _sp = list(REALM_SPAWN_PROFILE[biome])
        spawn_policy = dict(zip(
            ('allow_monster_spawn', 'spawn_profile',
             'density_hint', 'zone_count_hint'), _sp))
        terrain = dict(REALM_TERRAIN[biome])
        style = dict(REALM_STYLE_BY_GROUP[group])
        # safe_zone: gate/hub = an toàn (NPC chuyển sinh/event, không
        # quái). combat/dungeon/boss = không an toàn.
        is_safe = role in ('gate', 'hub')
        for k in range(n):
            seed = f'place:realm:{map_id}'
            name = f'{biome_vi} (#{map_id:05d})'
            if not cultural_lock_ok(name):
                name = f'Cõi {map_id:05d}'
            g1_pass, g1_note = g1_check(name)
            # coord: hàng theo biome index, cột theo k — +15 lệch khỏi
            # lưới map thường (bội 30). Clamp trong range hợp lệ.
            cx = min(15 + (k % MAP_GRID_WIDTH) * MAP_CELL_SIZE, _cx_max)
            cy = min(15 + bi * MAP_CELL_SIZE
                     + (k // MAP_GRID_WIDTH) * MAP_CELL_SIZE, _cx_max)
            realm_maps.append({
                'uuid': str(uuid.uuid5(
                    UUID_NS, f'svtk_realm_{biome}_{map_id:05d}')),
                'map_id': map_id,
                'natural_key': f'svtk_realm_{biome}_{map_id:05d}',
                'topology_version': TOPOLOGY_VERSION,
                'name': name,
                'era': REALM_ERA,
                'era_label': REALM_ERA_LABEL,
                'era_display': REALM_ERA_LABEL,
                'biome': biome,
                'biome_label': biome_vi,
                'biome_group': group,        # celestial / underworld
                'is_important': True,        # cõi đặc biệt = quan trọng
                'purpose': purpose,
                'style': style,
                'zone': zone,                # tien_gioi / am_phu
                'tier': tier,
                'shard_id': 0,               # cõi không thuộc shard địa lý
                'shard_code': 'SH00',
                'f_prefix': 'none',
                'g1_pass': g1_pass,
                'g1_note': g1_note,
                'coord_x': cx,
                'coord_y': cy,
                'chunk_x': cx // (MAP_CELL_SIZE * 8),
                'chunk_y': cy // (MAP_CELL_SIZE * 8),
                'safe_zone': is_safe,        # gate/hub an toàn
                'combat_zone': 'combat' in purpose,
                'spawn_policy': spawn_policy,
                'nav_region': f'nav_realm_{zone}',
                'terrain': terrain,
                'anchors': build_anchors(seed, biome, tier, map_id,
                                         purposes=purpose),
                'tags': [REALM_ERA_LABEL, biome, group, zone,
                         f'tier{tier}', access, role],
                'tsonline_cross_ref': seeded_int(
                    f'ts:realm:{biome}', 1, 7047),
                'realm_access': access,      # reborn/event/quest
                'is_start_map': False,       # map cõi KHÔNG phải map spawn
                'realm_group': group,        # celestial / underworld
                'map_role': role,            # gate/hub/combat/dungeon/boss
            })
            map_id += 1

    # ── PORTAL GRAPH cõi — 2 lớp:
    # (1) nội bộ từng sub-realm: nối các map cùng biome liền nhau.
    # (2) liên sub-realm theo realm_group: cổng -> hub -> combat ->
    #     boss, để mỗi nhóm cõi (celestial/underworld) LIÊN THÔNG.
    # Cõi KHÔNG nối map thường: vào bằng chuyển sinh/event/quest.
    by_biome = {}
    for mp in realm_maps:
        mp['portal_graph'] = []
        by_biome.setdefault(mp['biome'], []).append(mp['map_id'])
    by_id = {mp['map_id']: mp for mp in realm_maps}

    def _add_edge(a, b):
        if a == b:
            return
        ga, gb = by_id[a]['portal_graph'], by_id[b]['portal_graph']
        if any(lk['to_map'] == b for lk in ga):
            return
        ga.append({'from_map': a, 'to_map': b, 'bidirectional': True})
        gb.append({'from_map': b, 'to_map': a, 'bidirectional': True})

    # (1) nội bộ từng sub-realm — chain các map cùng biome
    for biome, chain in by_biome.items():
        for i in range(len(chain) - 1):
            _add_edge(chain[i], chain[i + 1])

    # (2) tuyến liên sub-realm — nối map ĐẦU sub-realm này sang map
    # ĐẦU sub-realm kia. Tuyến theo nhịp gameplay: cổng -> hub ->
    # combat -> boss. CHỈ nối trong cùng realm_group.
    REALM_LINKS = [
        # ── Tiên Giới (celestial) ──
        ('thien_mon', 'coi_troi'),
        ('coi_troi', 'dong_tien'),
        ('coi_troi', 'tan_vien_linh_son'),
        ('coi_troi', 'long_cung'),
        ('dong_tien', 'thien_dai'),
        ('tan_vien_linh_son', 'thien_dai'),
        ('long_cung', 'thien_dai'),
        # ── Âm Phủ (underworld) ──
        ('quy_mon_quan', 'hoang_tuyen'),
        ('hoang_tuyen', 'u_minh_lo'),
        ('u_minh_lo', 'dia_phu_dien'),
        ('dia_phu_dien', 'me_cung_u_minh'),
        ('me_cung_u_minh', 'vong_hon_dai'),
    ]
    for src, dst in REALM_LINKS:
        # an toàn: 2 đầu phải cùng realm_group (chống nối nhầm cõi)
        if REALM_GROUP[src] != REALM_GROUP[dst]:
            continue
        if by_biome.get(src) and by_biome.get(dst):
            _add_edge(by_biome[src][0], by_biome[dst][0])
    return realm_maps


# ── BUILD: 2 MAP START CỐT TRUYỆN (Bảo tàng 2026 -> Hoa Lư 968) ──
def build_start_maps():
    """Sinh 2 map mở đầu cốt truyện — map_id 10101-10102.
    10101 = Bảo tàng Lịch sử VN (2026): player spawn ở đây, is_start_map
            =True. Có kệ sách cổ = cổng dịch chuyển thời không.
    10102 = Cố Đô Hoa Lư (968): đến sau khi xuyên không, gặp Sư Vạn
            Hạnh (mentor). Nối ra map thường tier 1 để bắt đầu chơi.
    Cổng 10101->10102 là cổng XUYÊN KHÔNG (1 chiều, không quay lại
    bảo tàng). Cổng 10102->map thường để vào thế giới."""
    keys = ['museum', 'hoa_lu']
    biomes = START_BIOMES               # ['bao_tang','co_do_hoa_lu']
    rows = []
    for i, (key, biome) in enumerate(zip(keys, biomes)):
        map_id = START_FIRST_MAP_ID + i
        era = START_ERAS[key]
        era_label = START_ERA_LABEL[era]
        biome_vi = START_BIOME_LABEL_VI[biome]
        is_start = (key == 'museum')    # CHỈ bảo tàng là điểm spawn
        if key == 'museum':
            name = 'Bảo Tàng Lịch Sử Việt Nam'
            purpose = ['social', 'lore', 'exploration']
        else:
            name = 'Cố Đô Hoa Lư'
            purpose = ['lore', 'social', 'exploration']
        if not cultural_lock_ok(name):
            name = f'Map Khởi Đầu {map_id:05d}'
        g1_pass, g1_note = g1_check(name)
        seed = f'place:start:{map_id}'
        # coord start: đặt ở khe riêng (offset +7, lệch lưới map thường
        # bội 30 + map cõi offset 15). Clamp trong range hợp lệ.
        _cx_max = ((SHARD_GRID_WIDTH - 1) * SHARD_CELL_SIZE
                   + (MAP_GRID_WIDTH - 1) * MAP_CELL_SIZE)
        cx = min(7 + i * MAP_CELL_SIZE, _cx_max)
        cy = 7
        rows.append({
            'uuid': str(uuid.uuid5(UUID_NS, f'svtk_start_{key}_{map_id:05d}')),
            'map_id': map_id,
            'natural_key': f'svtk_start_{key}_{map_id:05d}',
            'topology_version': TOPOLOGY_VERSION,
            'name': name,
            'era': era,                  # hien_dai / dinh
            'era_label': era_label,
            'era_display': era_label,
            'biome': biome,
            'biome_label': biome_vi,
            'biome_group': 'start',
            'is_important': True,
            'purpose': purpose,
            'style': dict(START_STYLE[biome]),
            'zone': 'khoi_dau',          # zone riêng cho map cốt truyện
            'tier': 1,                   # map mở đầu — an toàn nhất
            'shard_id': 0,
            'shard_code': 'SH00',
            'f_prefix': 'none',
            'g1_pass': g1_pass,
            'g1_note': g1_note,
            'coord_x': cx,
            'coord_y': cy,
            'chunk_x': cx // (MAP_CELL_SIZE * 8),
            'chunk_y': cy // (MAP_CELL_SIZE * 8),
            'safe_zone': True,           # 2 map mở đầu LUÔN an toàn
            'combat_zone': False,
            'spawn_policy': {'allow_monster_spawn': False,
                             'spawn_profile': 'none',
                             'density_hint': 'none',
                             'zone_count_hint': 0},
            'nav_region': 'nav_start',
            'terrain': {'elevation': 20, 'water_ratio': 5, 'roughness': 10},
            'anchors': build_anchors(seed, biome, 1, map_id,
                                     purposes=purpose),
            'tags': [era_label, biome, 'start', 'khoi_dau', 'tier1'],
            'tsonline_cross_ref': seeded_int(f'ts:start:{key}', 1, 7047),
            'realm_access': 'open',      # map start vào tự do
            'is_start_map': is_start,    # TRƯỜNG MỚI — chỉ bảo tàng True
            'realm_group': 'none',       # map start không thuộc cõi
            'map_role': 'start',         # vai trò: map cốt truyện mở đầu
        })
    # ── PORTAL: Bảo tàng -> Hoa Lư (cổng xuyên không, 1 chiều).
    # KHÔNG bidirectional — xuyên không rồi không quay lại 2026 được.
    mid_museum = START_FIRST_MAP_ID
    mid_hoalu = START_FIRST_MAP_ID + 1
    rows[0]['portal_graph'] = [{
        'from_map': mid_museum, 'to_map': mid_hoalu,
        'bidirectional': False, 'portal_type': 'time_warp',
        'note': 'Kệ sách cổ — cổng dịch chuyển thời không 2026->968',
    }]
    # Hoa Lư: cổng xuyên không là 1 CHIỀU (rows[0] đã khai). Hoa Lư
    # nối ra map thường tier 1 (map_id 1) để player vào thế giới —
    # cũng 1 CHIỀU: KHÔNG bidirectional vì map thường (map 1) thuộc
    # 10000 map cũ, KHÔNG được thêm link ngược vào đó. Player quay
    # lại Hoa Lư bằng cơ chế khác (quest/teleport) — việc CMD_ENGINE.
    rows[1]['portal_graph'] = [
        {'from_map': mid_hoalu, 'to_map': 1,
         'bidirectional': False, 'portal_type': 'normal',
         'note': 'Hoa Lư -> thế giới (vùng tân thủ)'},
    ]
    return rows


# ── SCHEMA SQL: place_items 20 cột, CHECK 10000 map/10 era/22 biome ──
def _sql_columns(sql, table):
    """Trích tên cột của 1 table từ SQL CREATE TABLE.
    Tên cột bắt cả CHỮ SỐ (vd g1_pass) — [a-z_0-9]."""
    import re as _re
    body = sql.split(table, 1)[1].split(');', 1)[0]
    return set(_re.findall(r'\n\s+([a-z_0-9]+)\s+(?:INT|VARCHAR|TEXT|BOOLEAN)',
                           body))

def _db_contract_ok(maps):
    """True nếu SQL place_items phủ ĐỦ mọi field của map JSON — SQL là
    projection chính thức của map_registry, không mất field player-facing.
    'id' là cột SQL riêng (auto), không thuộc map JSON nên loại trừ."""
    if not maps:
        return True
    json_fields = set(maps[0].keys())
    sql_cols = _sql_columns(build_schema_sql(), 'place_items')
    return json_fields.issubset(sql_cols)

def build_schema_sql():
    """Sinh SQL động từ ERAS/BIOMES/TOTAL_MAP_COUNT — 1 nguồn, không hardcode.
    era/biome CHECK gồm CẢ realm (than_thoai + 8 biome cõi) — nếu không
    100 map cõi vi phạm constraint."""
    all_eras = list(ERAS) + [REALM_ERA] + list(START_ERA_LABEL.keys())
    all_biomes = list(BIOMES) + list(REALM_BIOMES) + list(START_BIOMES)
    era_list = ','.join(f"'{e}'" for e in all_eras)
    biome_list = ','.join(f"'{b}'" for b in all_biomes)
    return f"""-- CMD_PLACE v2.4.0 schema — auto từ ERAS/BIOMES/TARGET
CREATE TABLE IF NOT EXISTS place_items (
    id INT PRIMARY KEY,
    map_id INT NOT NULL,
    uuid VARCHAR(36) NOT NULL,
    natural_key VARCHAR(64) NOT NULL,
    topology_version INT NOT NULL,
    name VARCHAR(128) NOT NULL,
    era VARCHAR(32) NOT NULL,
    biome VARCHAR(32) NOT NULL,
    zone VARCHAR(32) NOT NULL,
    tier INT NOT NULL,
    is_important BOOLEAN NOT NULL,
    shard_id INT NOT NULL,
    f_prefix VARCHAR(8) NOT NULL,
    g1_pass BOOLEAN NOT NULL,
    g1_note VARCHAR(255) NOT NULL,
    coord_x INT NOT NULL,
    coord_y INT NOT NULL,
    purpose TEXT NOT NULL,        -- JSON array các purpose
    anchors TEXT NOT NULL,        -- JSON object anchor registry
    style TEXT NOT NULL,          -- JSON object visual/architecture/audio
    chunk_x INT NOT NULL,
    chunk_y INT NOT NULL,
    safe_zone BOOLEAN NOT NULL,
    combat_zone BOOLEAN NOT NULL,
    spawn_policy TEXT NOT NULL,    -- JSON: gợi ý vùng quái cho CMD_MAP
    nav_region VARCHAR(32) NOT NULL,
    terrain TEXT NOT NULL,        -- JSON object elevation/water_ratio/roughness
    portal_graph TEXT NOT NULL,   -- JSON array các liên kết portal
    era_label VARCHAR(32) NOT NULL,
    era_display VARCHAR(32) NOT NULL,
    biome_label VARCHAR(32) NOT NULL,
    biome_group VARCHAR(32) NOT NULL,
    shard_code VARCHAR(8) NOT NULL,
    tags TEXT NOT NULL,           -- JSON array tag
    tsonline_cross_ref INT NOT NULL,
    realm_access VARCHAR(16) NOT NULL DEFAULT 'open',  -- open/reborn/event/quest
    is_start_map BOOLEAN NOT NULL DEFAULT 0,          -- map spawn cốt truyện
    realm_group VARCHAR(16) NOT NULL DEFAULT 'none',  -- none/celestial/underworld
    map_role VARCHAR(16) NOT NULL DEFAULT 'normal',   -- normal/start/gate/hub/combat/dungeon/boss
    UNIQUE(map_id),
    UNIQUE(natural_key),
    UNIQUE(uuid),
    CHECK (map_id BETWEEN 1 AND {TOTAL_MAP_COUNT}),
    CHECK (era IN ({era_list})),
    CHECK (biome IN ({biome_list})),
    CHECK (tier BETWEEN 1 AND 5),
    CHECK (shard_id BETWEEN 0 AND {TARGET_REGION_SHARDS - 1})
);
CREATE INDEX idx_place_key ON place_items(natural_key);
CREATE INDEX idx_place_era ON place_items(era);
CREATE INDEX idx_place_biome ON place_items(biome);
CREATE INDEX idx_place_shard ON place_items(shard_id);
CREATE INDEX idx_place_zone ON place_items(zone);
CREATE INDEX idx_place_tier ON place_items(tier);
CREATE INDEX idx_place_biome_group ON place_items(biome_group);
CREATE INDEX idx_place_tsref ON place_items(tsonline_cross_ref);
CREATE INDEX idx_place_shard_code ON place_items(shard_code);

CREATE TABLE IF NOT EXISTS place_region (
    shard_id INT PRIMARY KEY,
    shard_code VARCHAR(8) NOT NULL,
    name VARCHAR(64) NOT NULL,
    zone VARCHAR(32) NOT NULL,
    tier INT NOT NULL,
    primary_era VARCHAR(32) NOT NULL,
    biome_focus VARCHAR(32) NOT NULL,
    expected_map_count INT NOT NULL,
    actual_map_count INT NOT NULL,
    natural_key VARCHAR(64) NOT NULL,
    UNIQUE(shard_code),
    UNIQUE(natural_key),
    CHECK (tier BETWEEN 1 AND 5),
    CHECK (shard_id BETWEEN 0 AND {TARGET_REGION_SHARDS - 1})
);
"""

def write_jsonl(path, rows):
    """Ghi atomic: temp + fsync + rename — SIGTERM giữa chừng không để file dở.
    BugD: newline='' giữ LF nguyên — .gitattributes pin *.jsonl eol=lf nên
    file local PHẢI LF mới khớp hash blob khi push (cross-platform deterministic)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)  # rename atomic — file luôn nguyên vẹn hoặc chưa có
    h = hashlib.sha256(path.read_bytes()).hexdigest()
    _write_text_lf(path.with_suffix(path.suffix + '.sha256'), f'{h}  {path.name}\n')

# Build lock — dùng os.mkdir (atomic trên MỌI OS: Linux/macOS/Windows).
# Heartbeat 20s: MMO runtime cần forensic nhạy — treo build phát hiện
# nhanh. Stale 180s = 9 nhịp heartbeat, vẫn dư an toàn cho build dài.
# Cho phép env override để liveops chỉnh không cần sửa code.
LOCK_HEARTBEAT_SEC = int(os.getenv('SVTK_HEARTBEAT_SEC', '20'))
LOCK_STALE_SEC = int(os.getenv('SVTK_LOCK_STALE_SEC', '180'))

def verify_determinism(mode='full', maps=None):
    """R68 — kiểm tính deterministic. 2 chế độ:
      'full'     : build 2 lần SHA khớp + persistence verify. Dùng cho
                   CI/CD và lần build verify đầu. Nặng (build ×2).
      'sampling' : build lại 1 lần, so SHA toàn bộ với maps đang có.
                   Nhẹ hơn (build ×1, không persistence). Dùng cho
                   runtime daemon chạy dài ngày — tránh phí CPU.
    maps: bộ map hiện có (bắt buộc cho mode 'sampling' để so SHA)."""
    global cultural_lock_ok
    if cultural_lock_ok is None:
        cultural_lock_ok = ensure_place_lib()

    def _sha_of(map_list):
        blob = '\n'.join(json.dumps(m, ensure_ascii=False, sort_keys=True)
                         for m in map_list)
        return hashlib.sha256(blob.encode()).hexdigest()

    def _build_sha():
        regions = build_regions(force_regen=True)
        ms = build_maps(regions)
        # realm + start: append — cùng nội dung như build thật, để SHA
        # so khớp với maps (đã gồm realm + start) ở caller.
        ms = ms + build_realm_maps() + build_start_maps()
        return _sha_of(ms), ms

    if mode == 'sampling':
        # build lại 1 lần, so SHA với maps đang có — phát hiện drift mà
        # không phải build ×2 + ghi/đọc file.
        if maps is None:
            return False
        sha_new, _ = _build_sha()
        return sha_new == _sha_of(maps)

    # mode == 'full'
    # (a) memory determinism — build 2 lần SHA khớp
    sha_a, maps_a = _build_sha()
    sha_b, _ = _build_sha()
    if sha_a != sha_b:
        return False
    # (b) persistence determinism — ghi ra jsonl rồi đọc lại
    import tempfile
    tmp = Path(tempfile.mkdtemp()) / 'det_check.jsonl'
    with open(tmp, 'w', encoding='utf-8') as f:
        for m in maps_a:
            f.write(json.dumps(m, ensure_ascii=False) + '\n')
    reloaded = [json.loads(l) for l in tmp.read_text(encoding='utf-8').splitlines() if l.strip()]
    sha_persist = _sha_of(reloaded)
    return sha_persist == sha_a

def _hb_path():
    """Đường dẫn file heartbeat — dùng chung giữa build và push, để
    pha push cũng ghi được stage cho forensic."""
    return OUTPUT_DIR / '.build.lock.d' / 'heartbeat'

def run_full_build():
    log.info(f"Build start ts={time.strftime('%Y%m%d-%H%M%S')}")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    # Build lock atomic (os.mkdir) + heartbeat — chạy mọi OS.
    # Stale TÍNH THEO heartbeat file, KHÔNG theo tuổi thư mục:
    # build dài >30 phút vẫn an toàn nếu worker còn ghi heartbeat.
    lock_dir = OUTPUT_DIR / '.build.lock.d'
    hb_file = _hb_path()
    if lock_dir.exists():
        try:
            last_hb = hb_file.stat().st_mtime if hb_file.exists() else lock_dir.stat().st_mtime
        except OSError:
            last_hb = 0
        if time.time() - last_hb > LOCK_STALE_SEC:
            log.warning(f"Lock không heartbeat {time.time()-last_hb:.0f}s — thu hồi")
            try:
                if hb_file.exists(): hb_file.unlink()
                lock_dir.rmdir()
            except OSError: pass
    try:
        lock_dir.mkdir()  # atomic — fail nếu đã tồn tại
    except FileExistsError:
        log.warning("Build khác đang chạy — bỏ qua lần này")
        return None, 0.0, ['build_locked']
    hb_file.write_text('stage=init')  # heartbeat + progress stage
    _hb_stop = threading.Event()  # BugA: threading imported top-level
    # _build_stage[0] = tên stage; _build_stage[1] = chuỗi progress
    # (vd '7823/10000'). Main thread cập nhật, heartbeat ghi ra file.
    _build_stage = ['init', '']
    def _heartbeat():
        # Ghi cả mtime LẪN stage+progress — process freeze thì 2 giá trị
        # đứng yên, daemon khác thấy không đổi quá lâu -> biết treo.
        # progress giúp build cực lớn (>100k map) vẫn theo dõi được.
        last = None
        while not _hb_stop.wait(LOCK_HEARTBEAT_SEC):
            try:
                cur = (_build_stage[0], _build_stage[1])
                if cur != last:
                    txt = f'stage={cur[0]}'
                    if cur[1]:
                        txt += f'\nprogress={cur[1]}'
                    hb_file.write_text(txt)
                    last = cur
                else:
                    os.utime(hb_file, None)
            except OSError: break
    _hb_thread = threading.Thread(target=_heartbeat, daemon=True)
    _hb_thread.start()
    try:
        return _run_full_build_inner(_build_stage)
    finally:
        _hb_stop.set()
        _hb_thread.join(timeout=1)  # chờ heartbeat thread dừng sạch
        try:
            if hb_file.exists(): hb_file.unlink()
            lock_dir.rmdir()
        except OSError: pass

def _run_full_build_inner(build_stage=None):
    # build_stage: list 1 phần tử dùng chung với heartbeat thread. Cập
    # nhật stage thật ở mỗi bước -> heartbeat ghi ra file, freeze
    # forensic biết chính xác build treo ở đâu. None khi gọi test độc lập.
    def _stage(name):
        if build_stage is not None:
            build_stage[0] = name
    t0 = time.time()
    for sub in ('registry', 'schema', 'tests'):
        (OUTPUT_DIR / sub).mkdir(parents=True, exist_ok=True)

    _stage('build_regions')
    regions = build_regions()
    _stage('build_maps')
    # Incremental: nếu region được reuse (không đổi) VÀ map registry cũ
    # còn nguyên vẹn -> reuse luôn map, khỏi build lại full 10000 map.
    # Region đổi -> map phải gen lại từ region mới.
    maps = None
    if _region_was_reused:
        maps = load_existing_maps()
        if maps is not None:
            # map cũ có thể đã gồm map cõi (era=than_thoai) + map start
            # (era hien_dai/dinh) — LỌC RA, chỉ giữ map thường để tính
            # actual_map_count đúng. Realm + start luôn sinh fresh.
            _special_eras = {REALM_ERA} | set(START_ERA_LABEL.keys())
            maps = [m for m in maps if m.get('era') not in _special_eras]
            log.info(f"Incremental: reuse {len(maps)} map thường có sẵn")
            from collections import Counter as _C
            _cnt = _C(m['shard_id'] for m in maps)
            for r in regions:
                r['actual_map_count'] = _cnt.get(r['shard_id'], 0)
    if maps is None:
        maps = build_maps(regions, build_stage)

    # ── REALM: luôn append 100 map cõi đặc biệt (sinh fresh, nhánh
    # riêng). map thường ở trên giữ NGUYÊN. Tổng = 10000 + 100 = 10100.
    _stage('build_realm')
    realm = build_realm_maps()
    maps = maps + realm
    log.info(f"Realm: +{len(realm)} map cõi -> tổng {len(maps)} map")

    # ── START: append 2 map cốt truyện mở đầu (Bảo tàng -> Hoa Lư).
    # Tổng cuối = 10000 + 100 + 2 = 10102.
    _stage('build_start')
    start = build_start_maps()
    maps = maps + start
    log.info(f"Start: +{len(start)} map cốt truyện -> tổng {len(maps)} map")

    _stage('write_files')
    region_fp = OUTPUT_DIR / 'registry' / 'region.jsonl'
    write_jsonl(region_fp, regions)
    write_meta(region_fp)
    map_fp = OUTPUT_DIR / 'registry' / 'map_registry.jsonl'
    write_jsonl(map_fp, maps)
    write_meta(map_fp)
    # BugD: _write_text_lf giữ LF cross-platform (gitattributes pin eol=lf)
    _write_text_lf(OUTPUT_DIR / 'registry' / 'shard_config.json',
        json.dumps({'total_shards': TARGET_REGION_SHARDS,
                    'total_maps': len(maps)}, indent=2, ensure_ascii=False))
    _write_text_lf(OUTPUT_DIR / 'schema' / 'place_table.sql', build_schema_sql())
    _write_text_lf(OUTPUT_DIR / 'tests' / 'place_tests.py', TEST_CODE)
    # place_lib.py đã ghi bởi ensure_place_lib() lúc boot — test import từ đó

    _stage('validate')
    # det_mode: env SVTK_DET_MODE = 'sampling' khi chạy daemon dài ngày
    # (build ×1, nhẹ CPU); mặc định 'full' cho CI/build verify lần đầu.
    det_mode = os.getenv('SVTK_DET_MODE', 'full')
    if det_mode not in ('full', 'sampling'):
        det_mode = 'full'
    score, gaps = self_validate(regions, maps, det_mode)
    build_ms = int((time.time() - t0) * 1000)

    # FIX1: BUILD_MANIFEST — forensic debug khi build lệch về sau
    git_commit = 'unknown'
    try:
        r = subprocess.run(['git','-C',str(REPO_DIR),'rev-parse','HEAD'],
                           capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            git_commit = r.stdout.strip()
    except Exception:
        pass
    manifest = {
        'cmd': CMD_NAME, 'cmd_version': CMD_VERSION,
        'foundation_hash': FOUNDATION_HASH,
        'schema_version': SCHEMA_VERSION,
        'git_commit': git_commit,
        'build_ts': time.strftime('%Y%m%d-%H%M%S'),
        'python_version': sys.version.split()[0],
        'target_map_count': TARGET_MAP_COUNT,
        'target_region_shards': TARGET_REGION_SHARDS,
        # FIX6: metric runtime — giá trị khi bot chạy dài ngày
        'metrics': {
            'build_ms': build_ms,
            'map_count': len(maps),
            'region_count': len(regions),
            'region_reuse_hit': _region_was_reused,
            'score': score,
        },
        # Output hash — forensic: 2 tháng sau so build lệch
        'output_sha256': {
            'map_registry': hashlib.sha256(
                (OUTPUT_DIR/'registry'/'map_registry.jsonl').read_bytes()).hexdigest(),
            'region': hashlib.sha256(
                (OUTPUT_DIR/'registry'/'region.jsonl').read_bytes()).hexdigest(),
            'schema': hashlib.sha256(
                (OUTPUT_DIR/'schema'/'place_table.sql').read_bytes()).hexdigest(),
        }
    }
    # BugD: _write_text_lf giữ LF — manifest output_sha256 cần consistent
    _write_text_lf(OUTPUT_DIR / 'build_manifest.json',
        json.dumps(manifest, indent=2, ensure_ascii=False))

    # build xong toàn bộ; pha 'push' chạy sau khi heartbeat đã đóng
    # (push nằm ngoài run_full_build) — đánh dấu để forensic phân biệt
    # "treo trong build" với "treo khi push".
    _stage('build_done')
    log.info(f"Build done score={score:.2f} gaps={len(gaps)} maps={len(maps)} build_ms={build_ms}")
    return OUTPUT_DIR, score, gaps

# ── SELF-VALIDATE: 17 check thật trên data vừa sinh ──
def self_validate(regions, maps, det_mode='full'):
    # det_mode: 'full' kiểm determinism build ×2 + persistence (CI/build
    # verify); 'sampling' build ×1 so SHA (runtime daemon, nhẹ CPU).
    map_ids = [m['map_id'] for m in maps]
    uuids = [m['uuid'] for m in maps]
    # ── tách map THƯỜNG vs map CÕI (realm) — check cũ áp world_maps,
    # check realm áp realm_maps. Phân biệt bằng era == REALM_ERA.
    # ── tách 3 nhóm map: THƯỜNG / CÕI (realm) / START (cốt truyện).
    # check cũ áp world_maps; check realm áp realm_maps; check start
    # áp start_maps. Phân biệt bằng era.
    _start_eras = set(START_ERA_LABEL.keys())   # {hien_dai, dinh}
    realm_maps = [m for m in maps if m.get('era') == REALM_ERA]
    start_maps = [m for m in maps if m.get('era') in _start_eras]
    world_maps = [m for m in maps
                  if m.get('era') != REALM_ERA
                  and m.get('era') not in _start_eras]
    # ── đếm phân bổ thực tế để verify quota (bug ẩn: chỉ kiểm "đủ mặt"
    # biome thì forest=1/mountain=9000 vẫn lọt) ──
    from collections import Counter as _Counter
    biome_cnt = _Counter(m['biome'] for m in maps)
    zone_cnt = _Counter(m.get('zone') for m in maps)
    era_cnt = _Counter(m['era'] for m in maps)
    # phân bổ zone kỳ vọng = tổng expected_map_count theo zone của region
    zone_expect = {}
    for r in regions:
        zone_expect[r.get('zone')] = zone_expect.get(r.get('zone'), 0) + r['expected_map_count']
    # ── coord range THẬT — đúng công thức build_maps (KHÔNG nới rộng).
    # coord = (sid % GW)*SCELL + (k % MGW)*MCELL. Map cuối shard cuối:
    # sid tối đa (TARGET_SHARDS-1), k tối đa MGW*MGW-1.
    _coord_max_x = ((SHARD_GRID_WIDTH - 1) * SHARD_CELL_SIZE
                    + (MAP_GRID_WIDTH - 1) * MAP_CELL_SIZE)
    _shard_rows = (TARGET_REGION_SHARDS + SHARD_GRID_WIDTH - 1) // SHARD_GRID_WIDTH
    _coord_max_y = ((_shard_rows - 1) * SHARD_CELL_SIZE
                    + (MAP_GRID_WIDTH - 1) * MAP_CELL_SIZE)
    # BugB: checks DÙNG LAMBDA → lazy eval → exception 1 check KHÔNG crash list.
    # _safe() bắt exception → FAIL gap thay vì crash toàn bộ self_validate.
    checks = [
        ('foundation_verified', lambda: FOUNDATION_VERIFIED),
        ('map_count_total', lambda: len(maps) == TOTAL_MAP_COUNT),
        ('region_count_64', lambda: len(regions) == TARGET_REGION_SHARDS),
        ('map_id_unique', lambda: len(map_ids) == len(set(map_ids))),
        ('map_id_range_full', lambda: bool(map_ids)
            and min(map_ids) == 1 and max(map_ids) == TOTAL_MAP_COUNT),
        ('uuid_unique', lambda: len(uuids) == len(set(uuids))),
        ('all_era_valid', lambda: all(
            m['era'] in ERAS or m['era'] == REALM_ERA
            or m['era'] in _start_eras for m in maps)),
        ('all_biome_valid', lambda: all(
            m['biome'] in BIOMES or m['biome'] in REALM_BIOMES
            or m['biome'] in START_BIOMES for m in maps)),
        ('era_10_covered', lambda: len(set(m['era']
            for m in world_maps)) == len(ERAS)),
        ('all_22_biomes_covered', lambda: len(set(m['biome']
            for m in world_maps)) == len(BIOMES)),
        # ── realm checks — 100 map cõi đặc biệt (12 sub-realm) ──
        ('realm_count_100', lambda: len(realm_maps) == REALM_MAP_COUNT),
        ('realm_12_subrealms_covered', lambda: len(set(m['biome']
            for m in realm_maps)) == len(REALM_BIOMES)),
        ('realm_quota_exact', lambda: all(
            sum(1 for m in realm_maps if m['biome'] == b) == q
            for b, q in REALM_QUOTA.items())),
        ('realm_tien_gioi_50', lambda: sum(
            1 for m in realm_maps
            if m.get('realm_group') == 'celestial') == 50),
        ('realm_am_phu_50', lambda: sum(
            1 for m in realm_maps
            if m.get('realm_group') == 'underworld') == 50),
        ('realm_group_valid', lambda: all(
            m.get('realm_group') in ('none', 'celestial', 'underworld')
            for m in maps)),
        ('realm_map_role_valid', lambda: all(
            m.get('map_role') in ('normal', 'start', 'gate', 'hub',
                                  'combat', 'dungeon', 'boss')
            for m in maps)),
        ('realm_gate_hub_no_spawn', lambda: all(
            not m['spawn_policy']['allow_monster_spawn']
            for m in realm_maps
            if m.get('map_role') in ('gate', 'hub'))),
        ('realm_access_valid', lambda: all(
            m.get('realm_access') in VALID_REALM_ACCESS for m in maps)),
        ('world_maps_open_access', lambda: all(
            m.get('realm_access') == 'open' for m in world_maps)),
        ('world_count_unchanged', lambda:
            len(world_maps) == TARGET_MAP_COUNT),
        # ── start map checks — 2 map cốt truyện mở đầu ──
        ('start_count_2', lambda: len(start_maps) == START_MAP_COUNT),
        ('start_has_one_spawn', lambda: sum(
            1 for m in start_maps if m.get('is_start_map')) == 1),
        ('start_is_safe', lambda: all(
            m.get('safe_zone') for m in start_maps)),
        ('is_start_map_field_present', lambda: all(
            'is_start_map' in m for m in maps)),
        ('only_museum_is_start', lambda: all(
            not m.get('is_start_map') for m in maps
            if m.get('biome') != 'bao_tang')),
        ('cultural_lock_pass', lambda: all(cultural_lock_ok(m['name']) for m in maps)),
        ('natural_key_unique', lambda: len(set(m['natural_key'] for m in maps)) == len(maps)),
        ('shard_id_valid', lambda: all(0 <= m['shard_id'] < 64 for m in maps)),
        ('region_map_count_sum', lambda: sum(r['actual_map_count'] for r in regions) == len(world_maps)),
        ('github_url_correct', lambda:
         REPO_URL.startswith('https://github.com/')
         and REPO_URL.endswith('/svtk-status.git')),
        ('deterministic_rebuild', lambda: verify_determinism(det_mode, maps)),
        ('coord_unique', lambda: len(set((m['coord_x'],m['coord_y']) for m in maps)) == len(maps)),
        ('coord_in_range', lambda: all(
            0 <= m['coord_x'] <= _coord_max_x
            and 0 <= m['coord_y'] <= _coord_max_y
            for m in maps)),
        # ── constitution lock checks ──
        ('all_have_purpose', lambda: all(m.get('purpose') for m in maps)),
        ('purpose_valid', lambda: all(p in VALID_PURPOSES
                              for m in maps for p in m.get('purpose', []))),
        ('all_have_anchors', lambda: all(m.get('anchors') for m in maps)),
        ('anchor_density_ok', lambda: all(
            len(items) <= ANCHOR_CAP.get(at, 0)
            for m in maps for at, items in m.get('anchors', {}).items())),
        ('topology_version_set', lambda: all(
            m.get('topology_version') == TOPOLOGY_VERSION for m in maps)),
        ('all_have_g1_flag', lambda: all('g1_pass' in m and 'g1_note' in m
                                 for m in maps)),
        ('all_have_style', lambda: all(m.get('style') for m in maps)),
        ('no_gameplay_logic', lambda: not any(
            k in m for m in maps
            for k in ('damage', 'skill', 'drop_rate', 'combat_formula',
                      'ai_behavior', 'quest_condition'))),
        # ── distribution checks (bug ẩn: "đủ mặt" không = "đúng quota") ──
        ('biome_quota_ok', lambda: all(
            biome_cnt.get(b, 0) == q for b, q in BIOME_QUOTA.items())),
        ('zone_distribution_ok', lambda: all(
            zone_cnt.get(z, 0) == exp for z, exp in zone_expect.items())),
        ('era_all_present', lambda: all(era_cnt.get(e, 0) > 0 for e in ERAS)),
        ('purpose_anchor_match', lambda: all(
            _anchor_matches_purpose(m) for m in maps)),
        # ── spatial / terrain / portal checks ──
        ('all_have_spatial', lambda: all(
            'chunk_x' in m and 'safe_zone' in m and 'nav_region' in m
            for m in maps)),
        ('all_have_terrain', lambda: all(m.get('terrain') for m in maps)),
        ('portal_graph_valid', lambda: _portal_graph_valid(maps)),
        ('world_connected', lambda: _world_connected(world_maps)),
        ('realm_portal_intra_group', lambda:
            _realm_portal_intra_group(realm_maps)),
        ('g1_recomputed_ok', lambda: all(
            (m.get('g1_pass'), m.get('g1_note')) == g1_check(m.get('name', ''))
            for m in maps)),
        ('style_forbidden_ok', lambda: all(
            _style_forbidden_ok(m) for m in maps)),
        ('db_contract_fields_present', lambda: _db_contract_ok(maps)),
        ('spawn_policy_ok', lambda: all(_spawn_policy_ok(m) for m in maps)),
        ('safe_zone_no_spawn', lambda: all(
            not (m['safe_zone'] and m['spawn_policy']['allow_monster_spawn'])
            for m in maps)),
    ]
    def _safe(fn):
        try: return bool(fn())
        except Exception: return False
    results = [(n, _safe(fn)) for n, fn in checks]
    passed = sum(1 for _, ok in results if ok)
    return passed / len(results), [n for n, ok in results if not ok]

def _portal_graph_valid(maps):
    """Kiểm portal graph chặt: (a) to_map có thật, (b) from_map đúng map
    hiện tại, (c) không self-loop, (d) không duplicate edge, (e)
    bidirectional thật — link A->B thì B->A phải tồn tại."""
    all_ids = set(m['map_id'] for m in maps)
    by_id = {m['map_id']: m for m in maps}
    for m in maps:
        seen = set()
        for lk in m.get('portal_graph', []):
            to_map = lk.get('to_map')
            # (a) to_map có thật
            if to_map not in all_ids:
                return False
            # (b) from_map đúng
            if lk.get('from_map') != m['map_id']:
                return False
            # (c) không self-loop
            if to_map == m['map_id']:
                return False
            # (d) không duplicate edge
            if to_map in seen:
                return False
            seen.add(to_map)
            # (e) bidirectional thật — phía kia phải có link ngược
            if lk.get('bidirectional'):
                back = by_id[to_map].get('portal_graph', [])
                if not any(b.get('to_map') == m['map_id'] for b in back):
                    return False
    return True

def _world_connected(maps):
    """Kiểm thế giới STRONGLY-CONNECTED: từ map đầu, BFS theo cạnh XUÔI
    phải tới đủ mọi map, VÀ BFS theo cạnh NGƯỢC cũng phải tới đủ. Đảm
    bảo mọi map vừa đi-tới-được vừa quay-về-được (không cụm 1 chiều).
    BugB: defensive — portal trỏ tới map_id không có trong list (data
    corrupt) thì return False thay vì KeyError CRASH self_validate."""
    if not maps:
        return False
    fwd = {m['map_id']: [] for m in maps}
    rev = {m['map_id']: [] for m in maps}
    all_ids = set(fwd)
    for m in maps:
        for lk in m.get('portal_graph', []):
            to_map = lk.get('to_map')
            if to_map not in all_ids:
                return False                # portal dangling → not connected
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


def _realm_portal_intra_group(realm_maps):
    """Map cõi: portal CHỈ nối map cõi CÙNG realm_group (celestial nối
    celestial, underworld nối underworld — KHÔNG nối chéo cõi, KHÔNG
    nối ra map thường), VÀ mỗi realm_group phải LIÊN THÔNG nội bộ
    (từ 1 map đi tới được mọi map cùng group). Rỗng -> True."""
    if not realm_maps:
        return True
    by_id = {m['map_id']: m for m in realm_maps}
    by_group = {}
    for m in realm_maps:
        by_group.setdefault(m.get('realm_group'), []).append(m['map_id'])
    # (a) mọi cạnh portal chỉ nối map cõi cùng realm_group
    for m in realm_maps:
        for lk in m.get('portal_graph', []):
            to_map = lk.get('to_map')
            if to_map not in by_id:          # trỏ ra ngoài realm
                return False
            if by_id[to_map].get('realm_group') != m.get('realm_group'):
                return False                 # nối chéo cõi
    # (b) mỗi realm_group liên thông nội bộ (BFS theo cạnh xuôi)
    for group, ids in by_group.items():
        if not ids:
            continue
        adj = {i: [] for i in ids}
        for i in ids:
            for lk in by_id[i].get('portal_graph', []):
                adj[i].append(lk['to_map'])
        seen = {ids[0]}
        stack = [ids[0]]
        while stack:
            cur = stack.pop()
            for nxt in adj.get(cur, []):
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        if len(seen) != len(ids):
            return False
    return True

def _spawn_policy_ok(m):
    """spawn_policy hợp lệ: đủ 4 trường gợi ý, KHÔNG chứa gameplay
    (monster_id/level/drop là việc CMD_NPC). allow=False thì
    zone_count_hint = 0; allow=True thì zone_count_hint > 0."""
    sp = m.get('spawn_policy')
    if not isinstance(sp, dict):
        return False
    need = {'allow_monster_spawn', 'spawn_profile',
            'density_hint', 'zone_count_hint'}
    if set(sp.keys()) != need:
        return False
    if any(k in sp for k in ('monster_id', 'level', 'drop', 'exp',
                             'respawn_time', 'ai_behavior', 'skill')):
        return False
    if not sp['allow_monster_spawn'] and sp['zone_count_hint'] != 0:
        return False
    if sp['allow_monster_spawn'] and sp['zone_count_hint'] <= 0:
        return False
    return True


def _style_forbidden_ok(m):
    """True nếu style của map KHÔNG chứa token phong cách bị cấm
    (cyberpunk/neon/sci-fi...) — chống lạc thời đại.
    NGOẠI LỆ: map start Bảo tàng (era hien_dai) CỐ Ý là bối cảnh 2026
    — điểm xuất phát truyện xuyên không, được duyệt. Miễn trừ check
    này cho map start, KHÔNG nới lỏng cho map thường."""
    if m.get('era') in START_ERA_LABEL:        # hien_dai / dinh
        return True
    blob = json.dumps(m.get('style', {}), ensure_ascii=False).lower()
    return not any(tok in blob for tok in FORBIDDEN_STYLE)

def _anchor_matches_purpose(m):
    """True nếu mọi loại anchor của map khớp purpose của biome.
    Loại anchor hợp lệ = {anchor mà purpose của biome dẫn về} +
    portal_anchor (luôn) + boss_anchor (nếu biome có combat)."""
    purposes = m.get('purpose', [])
    allowed = {'portal_anchor'}
    for p in purposes:
        if p in PURPOSE_ANCHOR:
            allowed.add(PURPOSE_ANCHOR[p])
    if 'combat' in purposes:
        allowed.add('boss_anchor')
    return all(at in allowed for at in m.get('anchors', {}))

TEST_CODE = '''# CMD_PLACE v2.4.0 — 28 tests (determinism kiểm trong self_validate)
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
                assert any(b.get('to_map') == m['map_id'] for b in back), \
                    f"bidirectional giả: {m['map_id']}->{to_map}"
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
            assert sp['zone_count_hint'] > 0, \
                f"allow=True nhưng zone=0: map {m['map_id']}"
        else:
            assert sp['zone_count_hint'] == 0, \
                f"allow=False nhưng zone>0: map {m['map_id']}"
def test_28_safe_zone_no_spawn():
    # safe_zone TUYỆT ĐỐI không quái
    for m in _maps():
        if m['safe_zone']:
            assert not m['spawn_policy']['allow_monster_spawn'], \
                f"safe_zone vẫn có quái: map {m['map_id']}"

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
'''

def push_to_github(output_dir, score, gaps, is_retry=False):
    # is_retry=True khi gọi từ _retry_dead_letters — KHÔNG tạo
    # dead-letter mới nếu fail (chống dead-letter tự nhân bản vô hạn
    # khi Git hỏng dài hạn). Bản dead-letter cũ giữ nguyên, retry_count
    # của NÓ tăng; quá ngưỡng -> failed_push.
    ts = time.strftime('%Y%m%d-%H%M%S')
    # Ghi stage 'push' vào heartbeat (nếu file còn) — forensic phân biệt
    # treo khi build với treo khi push. Lỗi ghi không được làm hỏng push.
    try:
        hbp = _hb_path()
        if hbp.parent.exists():
            hbp.write_text('stage=push')
    except OSError:
        pass
    for attempt in range(MAX_PUSH_ATTEMPTS):
        # Mỗi attempt 1 branch RIÊNG — rebase conflict thì attempt sau branch mới sạch
        branch = f"staging-{CMD_NAME.lower()}-{ts}" + (f"-r{attempt}" if attempt else "")
        try:
            subprocess.run(['git','-C',str(REPO_DIR),'fetch','origin'], check=True, timeout=30)
            # switch -C: tạo mới HOẶC reset nếu branch đã tồn tại — retry an toàn
            subprocess.run(['git','-C',str(REPO_DIR),'switch','-C',branch], check=True)
            target = REPO_DIR / f'cmd-{CMD_NAME.lower()}' / 'output'
            target.mkdir(parents=True, exist_ok=True)
            # shutil.copytree thay cp -r — chạy mọi OS, không phụ thuộc shell
            import shutil
            shutil.copytree(str(output_dir), str(target), dirs_exist_ok=True)
            # BugC: SKIP push khi DATA THẬT (registry/schema/tests) không đổi vs main —
            # chống spam staging branch mỗi lần daemon restart. KHÔNG compare
            # build_manifest.json vì có build_ts/build_ms timestamp luôn đổi mà
            # KHÔNG phải data đổi. Status file cũng bỏ qua (chỉ add khi quyết push).
            data_dirs = [f'cmd-{CMD_NAME.lower()}/output/registry',
                         f'cmd-{CMD_NAME.lower()}/output/schema',
                         f'cmd-{CMD_NAME.lower()}/output/tests']
            subprocess.run(['git','-C',str(REPO_DIR),'add'] + data_dirs, check=True)
            output_changed = subprocess.run(
                ['git','-C',str(REPO_DIR),'diff','--cached','--quiet'] + data_dirs).returncode != 0
            if not output_changed:
                log.info(f"Output không đổi vs main — SKIP push (chống spam staging)")
                # cleanup: về default branch, xóa branch staging vừa tạo local
                try:
                    db = get_default_branch()
                    subprocess.run(['git','-C',str(REPO_DIR),'switch',db,'--quiet'],
                                   check=False)
                    subprocess.run(['git','-C',str(REPO_DIR),'branch','-D',branch,'--quiet'],
                                   check=False)
                except Exception:
                    pass
                return True
            status = {'cmd': CMD_NAME, 'version': CMD_VERSION, 'timestamp': ts,
                      'validation_score': score, 'honest_gaps': gaps,
                      'exit_code': 0 if score >= SCORE_THRESHOLD else 1}
            sp = REPO_DIR / f'cmd-{CMD_NAME.lower()}' / 'status' / f'status-{ts}.json'
            sp.parent.mkdir(parents=True, exist_ok=True)
            _write_text_lf(sp, json.dumps(status, indent=2, ensure_ascii=False))
            # Git identity: lấy từ env (production bot không gắn email cá
            # nhân vào code). Fallback email bot trung tính nếu chưa set.
            git_email = os.getenv("GIT_EMAIL", f"cmd-{CMD_NAME.lower()}-bot@svtk.local")
            git_name = os.getenv("GIT_NAME", f"CMD_{CMD_NAME}_BOT")
            subprocess.run(['git','-C',str(REPO_DIR),'config','user.email',git_email])
            subprocess.run(['git','-C',str(REPO_DIR),'config','user.name',git_name])
            subprocess.run(['git','-C',str(REPO_DIR),'add','.'], check=True)
            subprocess.run(['git','-C',str(REPO_DIR),'commit','-m',
                            f"CMD_{CMD_NAME} v{CMD_VERSION} ts={ts} score={score:.2f}"], check=True)
            subprocess.run(['git','-C',str(REPO_DIR),'push','origin',branch], check=True, timeout=60)
            log.info(f"Pushed: {branch}")
            return True
        except subprocess.CalledProcessError as e:
            log.warning(f"Push attempt {attempt+1} fail: {e}")
            # KHÔNG rebase (dễ conflict loop). Attempt sau tự dùng branch -r{n} mới,
            # branch mới không có lịch sử remote → switch -C sạch, không non-fast-fwd.
            time.sleep(RETRY_DELAY_SEC)
    # Push fail hết MAX_PUSH_ATTEMPTS lần — KHÔNG vứt output. Lưu vào
    # dead-letter queue local để daemon retry sau / vận hành xử lý tay.
    # NHƯNG nếu đây ĐÃ là retry của 1 dead-letter cũ -> KHÔNG tạo
    # dead-letter mới (tránh nhân bản vô hạn khi Git hỏng dài hạn).
    if not is_retry:
        _save_dead_letter(output_dir, score, gaps, ts)
    return False

def _save_dead_letter(output_dir, score, gaps, ts):
    """Lưu output push fail vào dead-letter queue local.
    Cấu trúc: OUTPUT_DIR/dead_push/<ts>/  gồm bản sao output + meta.json.
    Lỗi lưu dead-letter không được làm crash bot."""
    try:
        import shutil
        dlq = OUTPUT_DIR / 'dead_push' / ts
        dlq.mkdir(parents=True, exist_ok=True)
        # bản sao output để retry sau không phụ thuộc build lại
        if output_dir and Path(output_dir).exists():
            shutil.copytree(str(output_dir), str(dlq / 'output'),
                            dirs_exist_ok=True)
        meta = {
            'cmd': CMD_NAME, 'cmd_version': CMD_VERSION, 'timestamp': ts,
            'validation_score': score, 'honest_gaps': gaps,
            'reason': f'push fail sau {MAX_PUSH_ATTEMPTS} lần thử',
            'repo_url': REPO_URL, 'status': 'pending_retry',
            'retry_count': 0,
            # hash để retry kiểm artifact CŨ có còn hợp lệ không —
            # nếu schema/foundation/build-rule/topology đổi từ lúc lưu
            # thì artifact đã stale, KHÔNG được push lên repo.
            'foundation_hash': FOUNDATION_HASH,
            'schema_version': SCHEMA_VERSION,
            'build_rule_hash': BUILD_RULE_HASH,
            'topology_version': TOPOLOGY_VERSION,
            'target_map_count': TARGET_MAP_COUNT,
            'target_region_shards': TARGET_REGION_SHARDS,
        }
        _write_text_lf(dlq / 'meta.json',
            json.dumps(meta, indent=2, ensure_ascii=False))
        log.warning(f"Push fail — lưu dead-letter: {dlq}")
    except OSError as e:
        # dead-letter lỗi cũng không được làm chết bot
        log.error(f"Không lưu được dead-letter: {e}")

def _retry_dead_letters():
    """Quét dead-letter queue, thử push lại các bản pending. Gọi đầu
    main_loop — infra hồi phục thì output cũ tự được đẩy lên, không mất.
    Bản retry quá nhiều lần -> đánh dấu failed_push (cần xử lý tay)."""
    dlq_root = OUTPUT_DIR / 'dead_push'
    if not dlq_root.exists():
        return
    MAX_DLQ_RETRY = int(os.getenv('SVTK_DLQ_MAX_RETRY', '5'))
    for entry in sorted(dlq_root.iterdir()):
        meta_fp = entry / 'meta.json'
        if not entry.is_dir() or not meta_fp.exists():
            continue
        try:
            meta = json.loads(meta_fp.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError):
            continue
        if meta.get('status') != 'pending_retry':
            continue
        # OBSOLETE GUARD — artifact cũ chỉ hợp lệ nếu schema/foundation/
        # build-rule/topology/target KHÔNG đổi từ lúc lưu. Nếu đổi ->
        # artifact đã stale, KHÔNG push lên repo (đánh dấu obsolete).
        stale = (meta.get('foundation_hash') != FOUNDATION_HASH
                 or meta.get('schema_version') != SCHEMA_VERSION
                 or meta.get('build_rule_hash') != BUILD_RULE_HASH
                 or meta.get('topology_version') != TOPOLOGY_VERSION
                 or meta.get('target_map_count') != TARGET_MAP_COUNT
                 or meta.get('target_region_shards') != TARGET_REGION_SHARDS)
        if stale:
            meta['status'] = 'obsolete'
            meta['obsolete_reason'] = 'schema/foundation/build-rule/topology đổi'
            _write_text_lf(meta_fp,
                json.dumps(meta, indent=2, ensure_ascii=False))
            log.warning(f"Dead-letter {entry.name} OBSOLETE — schema đổi, "
                        f"không push artifact cũ")
            continue
        out = entry / 'output'
        if not out.exists():
            continue
        log.info(f"Dead-letter retry: {entry.name} (lần {meta.get('retry_count',0)+1})")
        ok = push_to_github(str(out), meta.get('validation_score', 0),
                            meta.get('honest_gaps', []), is_retry=True)
        meta['retry_count'] = meta.get('retry_count', 0) + 1
        if ok:
            meta['status'] = 'pushed'
            log.info(f"Dead-letter {entry.name} đã push thành công")
        elif meta['retry_count'] >= MAX_DLQ_RETRY:
            # retry quá ngưỡng -> chuyển failed_push, cần người xử lý
            meta['status'] = 'failed_push'
            log.error(f"Dead-letter {entry.name} fail {meta['retry_count']} lần "
                      f"-> failed_push, cần xử lý tay")
        try:
            _write_text_lf(meta_fp, json.dumps(meta, indent=2, ensure_ascii=False))
        except OSError:
            pass

def main_loop():
    # Trước khi build mới — thử đẩy lại các output push fail lần trước
    # (infra có thể đã hồi phục). Output cũ không bị mất.
    _retry_dead_letters()
    output_dir, score, gaps = run_full_build()
    if output_dir is not None:
        push_to_github(output_dir, score, gaps)
    else:
        log.info("Build bị khóa/bỏ qua — không push")
    inbox = REPO_DIR / f'cmd-{CMD_NAME.lower()}' / 'inbox'
    while True:
        try:
            # về default branch rồi reset — KHÔNG phá staging, KHÔNG hardcode 'main'
            db = get_default_branch()
            subprocess.run(['git','-C',str(REPO_DIR),'fetch','origin','--quiet'], timeout=30)
            subprocess.run(['git','-C',str(REPO_DIR),'checkout',db,'--quiet'], timeout=30)
            subprocess.run(['git','-C',str(REPO_DIR),'reset','--hard',f'origin/{db}','--quiet'], timeout=30)
            if inbox.exists():
                tasks = sorted(inbox.glob('*.json'))
                if tasks:
                    for tf in tasks:
                        task = json.loads(tf.read_text())
                        log.info(f"Fix: {task.get('issue_id')}")
                        processed = inbox.parent / 'processed' / tf.name
                        processed.parent.mkdir(parents=True, exist_ok=True)
                        tf.rename(processed)
                    output_dir, score, gaps = run_full_build()
                    if output_dir is not None:
                        push_to_github(output_dir, score, gaps)
                    else:
                        log.info("Build bị khóa/bỏ qua — không push")
        except Exception as e:
            log.error(f"loop_err: {e}")
        time.sleep(LOOP_INTERVAL_SEC)

def safe_main():
    def handle_sigterm(s, f):
        print('[SHUTDOWN] SIGTERM'); sys.exit(0)
    signal.signal(signal.SIGTERM, handle_sigterm)
    try:
        verify_foundation()
        global cultural_lock_ok
        cultural_lock_ok = ensure_place_lib()
        main_loop()
    except KeyboardInterrupt:
        print('[SHUTDOWN] Ctrl+C'); sys.exit(0)
    except Exception as e:
        print(f'[FATAL] {e}'); sys.exit(2)

if __name__ == '__main__':
    safe_main()