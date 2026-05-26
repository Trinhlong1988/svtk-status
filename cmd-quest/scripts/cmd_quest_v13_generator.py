#!/usr/bin/env python3
# ============================================================================
# HISTORICAL REFERENCE ONLY - DO NOT RE-EXECUTE
# ----------------------------------------------------------------------------
# Targets foundation/SVTK_FOUNDATION_v2.8.0.md (retired 2026-05-26 by LEAD #124).
# Current foundation: SVTK_FOUNDATION_v2.10.0.md
# sha256 cc194e6cad2225d197c4a5539352deb538c99cdd6a21845a8354260602287bbb
# Re-execute = FileNotFoundError. Kept for audit trail of shipped artifacts.
# ============================================================================
"""CMD QUEST v1.3 — 15-round audit fixes on top of v1.2.

Fix bug v1.2 audit:
- V11: chain length cap MAX_CHAIN_LEN=15 (quest_constants.chain_validator.max_dependency_depth=20)
- V13: preserve dialog_tree_ref khi convert legacy → spec
- V15+V20: cap reborn level_min=120 (R76 char level cap), use prerequisite chain
- V16: smart NPC giver lookup by name (Sư Vạn Hạnh template match)
- V17: reborn giver NOT NPC#1 (player template), pick valid can_give_quest NPC
- V19: per-era suffix list (g1 → Hà Nội/Sài Gòn, f1 → Hồng Lĩnh/Văn Lang, etc)
- V21: last era unlocks_next_era=False (no next era after nguyen)
"""
import os
import sys
import time
import json
import re
import hashlib
import logging
import uuid
from pathlib import Path

CMD_NAME = "cmd-quest"
CMD_VERSION = "1.3.0"
TARGET_QUEST = 3000

# R76 char level cap
LEVEL_CAP = 120

# V11: chain length cap (quest_constants.chain_validator)
MAX_CHAIN_LEN = 15
MIN_CHAIN_LEN = 2

ERAS = ['g1', 'f1', 'f2', 'f3', 'f4', 'f5', 'ly', 'tran', 'le', 'tay_son', 'nguyen']
ERA_DIACRITIC = {
    'g1': 'Globeway hiện đại',
    'f1': 'Hồng Bàng',
    'f2': 'Âu Lạc',
    'f3': 'Bắc thuộc',
    'f4': 'Ngô Đinh Lê',
    'f5': 'tiền Lý',
    'ly': 'Lý',
    'tran': 'Trần',
    'le': 'Lê',
    'tay_son': 'Tây Sơn',
    'nguyen': 'Nguyễn',
}

# V19: per-era location suffix (avoid anachronism)
ERA_SUFFIXES = {
    'g1': {  # modern 2026
        'kill': ['băng cướp ngoại thành Hà Nội', 'tội phạm khu Sài Gòn',
                 'nhóm buôn lậu Móng Cái', 'côn đồ chợ Đông Anh',
                 'mafia khu Đà Nẵng', 'bọn lừa đảo phố Hàng Bài',
                 'tin tặc khu công nghệ Cầu Giấy', 'kẻ trộm bảo tàng Hà Nội'],
        'collect': ['hiện vật bảo tàng Hà Nội', 'cổ vật triển lãm Văn Miếu',
                    'tài liệu thư viện Quốc gia', 'mẫu vật phòng lab Bách Khoa',
                    'sách quý phố sách Đinh Lễ', 'tranh cổ phố Hàng Bè',
                    'di vật khu di chỉ Hoàng Thành', 'gốm cổ chợ Đồng Xuân'],
        'deliver': ['hồ sơ cho viện nghiên cứu', 'tài liệu cho giáo sư',
                    'mẫu vật cho phòng lab', 'sách cho thư viện',
                    'thuốc cho bệnh viện Bạch Mai', 'tin báo cho công an',
                    'bản đồ cho đoàn khảo cổ', 'hợp đồng cho doanh nghiệp'],
        'escort': ['đoàn du khách quanh Hoàn Kiếm', 'giáo sư đến hội thảo',
                   'đoàn ngoại giao sân bay Nội Bài', 'sinh viên ra trường thi',
                   'bệnh nhân đến viện', 'gia đình về quê',
                   'đoàn thiện nguyện vùng cao', 'đoàn báo chí ra Bắc'],
        'talk': ['giáo sư bảo tàng', 'cán bộ phường', 'cụ bà nhà cổ phố Hàng Đào',
                 'nhà sử học già', 'sư trụ trì chùa Trấn Quốc',
                 'lái xe taxi cũ', 'chủ quán cà phê phố cổ',
                 'người gác cổng bảo tàng'],
        'explore': ['ngõ nhỏ phố cổ Hà Nội', 'tầng hầm bảo tàng',
                    'di tích Hoàng Thành Thăng Long', 'hang động Tràng An',
                    'khu sinh thái Bát Tràng', 'làng nghề Đồng Kỵ',
                    'bến tàu Hải Phòng', 'phố đêm Tạ Hiện'],
    },
    # Ancient era share similar list (already validated)
    '_default_ancient': {
        'kill': ['giặc cướp ở Thăng Long', 'thổ phỉ rừng Tam Đảo',
                 'quân xâm lược ở Cao Bằng', 'thú dữ vùng Sa Pa',
                 'hải tặc Vịnh Hạ Long', 'mãnh thú ải Chi Lăng',
                 'phản loạn ở Hoan Châu', 'bọn cướp đường Quan San'],
        'collect': ['thảo dược trên núi Yên Tử', 'cổ vật ở Cố Đô Huế',
                    'nguyên liệu rèn kiếm ở Bắc Ninh', 'tài liệu thư viện Văn Miếu',
                    'hương liệu chợ Vân Đồn', 'gỗ quý rừng Trường Sơn',
                    'ngọc trai Vịnh Bái Tử Long', 'tre già làng Đường Lâm'],
        'deliver': ['thư khẩn cho quan tướng', 'lương thực cho dân làng',
                    'tin báo cho Hoàng đế', 'gói hàng cho thương nhân',
                    'thuốc cho thầy lang', 'sắc chỉ cho trấn thủ',
                    'gạo cứu đói cho làng nghèo', 'sách cho học trò'],
        'escort': ['sứ giả về kinh', 'thương đoàn qua đèo',
                   'gia đình tị nạn', 'học giả lên kinh thi cử',
                   'người bệnh đến thầy thuốc', 'người già lễ chùa',
                   'cô dâu về nhà chồng', 'quan triều về nhậm chức'],
        'talk': ['vị trưởng làng', 'thầy đồ trong làng', 'phó tướng nơi biên ải',
                 'thầy thuốc già', 'nhà sư trụ trì', 'thương nhân buôn vải',
                 'cô lái đò bến sông', 'tướng quân già hồi hưu'],
        'explore': ['rừng sâu Mã Yên', 'hang động Tràng An',
                    'biển Đông sương mù', 'núi rừng Tây Bắc',
                    'đầm lầy Đồng Tháp Mười', 'thung lũng Mai Châu',
                    'đảo hoang Cát Bà', 'cao nguyên Mộc Châu'],
    },
}

OBJECTIVE_TYPES = ['kill', 'collect', 'deliver', 'escort', 'talk', 'explore']
TARGETS = {'main': 259, 'side': 142, 'lore': 88, 'event': 28,
           'raid': 50, 'reborn': 21}
TOTAL_CATEGORIZED = sum(TARGETS.values())
TARGET_GENERATED = TARGET_QUEST - TOTAL_CATEGORIZED

CYCLE_START = time.time()
CYCLE_ID = time.strftime('%Y%m%d-%H%M%SZ', time.gmtime())

ROOT = Path(__file__).resolve().parents[2]
CMD_DIR = ROOT / 'cmd-quest'
OUTPUT_DIR = CMD_DIR / 'output'
LEAD_DIR = ROOT / 'cmd-lead'

log = logging.getLogger(CMD_NAME)
log.setLevel(logging.INFO)
_h = logging.StreamHandler()
_h.setFormatter(logging.Formatter('%(asctime)s [%(name)s] [%(levelname)s] %(message)s'))
log.addHandler(_h)


# ============================================================
# CULTURAL LOCK
# ============================================================
CULTURAL_LOCK_REGEX = re.compile(r'[一-鿿぀-ゟ゠-ヿ]')
TAM_QUOC_BAN_REGEX = re.compile(
    r'(Tào Tháo|Lưu Bị|Quan Vũ|Trương Phi|Khổng Minh|Cao Cao|Liu Bei|'
    r'Zhuge Liang|Guan Yu|Zhang Fei|Tam Quốc)', re.IGNORECASE)


def cultural_lock_check(text: str) -> bool:
    if CULTURAL_LOCK_REGEX.search(text):
        return False
    if TAM_QUOC_BAN_REGEX.search(text):
        return False
    return True


# ============================================================
# R72 REVERSE CHANNEL
# ============================================================
def _write_lead(sub: str, fname: str, payload: dict):
    d = LEAD_DIR / sub
    d.mkdir(parents=True, exist_ok=True)
    (d / fname).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')


def push_heartbeat_to_lead():
    ts = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    _write_lead('heartbeats', f'{CMD_NAME}_hb_{ts}.json', {
        'worker': CMD_NAME, 'timestamp': ts, 'alive': True,
        'cycle_id': CYCLE_ID, 'cmd_version': CMD_VERSION,
    })


def push_completion_to_lead(issue_id: str, result: str, evidence: dict):
    assert result in ('PASS', 'FAIL', 'PARTIAL'), f'Invalid result: {result}'
    ts = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    _write_lead('completions', f'{result}-{issue_id}-{ts}.json', {
        'issue_id': issue_id, 'completed_by': CMD_NAME,
        'result': result, 'evidence': evidence,
        'timestamp': ts, 'cycle_id': CYCLE_ID,
    })


def push_alert_to_lead(severity: str, issue_id: str, evidence: dict):
    ts = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    _write_lead('alerts', f'{severity}-{issue_id}-{ts}.json', {
        'severity': severity, 'issue_id': issue_id,
        'evidence': evidence, 'cmd_origin': CMD_NAME,
        'timestamp': ts, 'cycle_id': CYCLE_ID,
    })


# ============================================================
# SETUP
# ============================================================
def setup():
    for sub in ['registry', 'chains', 'schema', 'reports']:
        (OUTPUT_DIR / sub).mkdir(parents=True, exist_ok=True)
    (CMD_DIR / 'existing').mkdir(parents=True, exist_ok=True)
    push_heartbeat_to_lead()


# ============================================================
# R71 — LOAD EXISTING
# ============================================================
def r71_load_existing():
    candidates = [
        CMD_DIR / 'existing' / 'QUEST_588.jsonl',
        CMD_DIR / 'existing' / 'QUEST_150_scaffold.jsonl',
    ]
    for p in candidates:
        if p.exists():
            existing = []
            with p.open(encoding='utf-8') as f:
                for line in f:
                    if line.strip():
                        existing.append(json.loads(line))
            log.info(f'r71_load {len(existing)} entries from {p.name}')
            return existing, p.name
    log.warning('r71_load_no_existing')
    return [], None


def convert_legacy_quest(legacy: dict, new_id: int, legacy_id_map: dict) -> dict:
    legacy_qid = legacy.get('quest_id', '')
    objs = legacy.get('objectives') or [{}]
    obj_type_raw = objs[0].get('type', 'talk') if objs else 'talk'
    obj_norm = {
        'kill_count': 'kill', 'kill': 'kill',
        'gather': 'collect', 'collect': 'collect',
        'deliver': 'deliver', 'escort': 'escort',
        'talk': 'talk', 'meet': 'talk',
        'explore': 'explore', 'reach': 'explore',
    }.get(obj_type_raw, 'talk')

    rewards = legacy.get('rewards') or {}
    remapped_prereqs = []
    for pre in legacy.get('prerequisites') or []:
        if isinstance(pre, str) and pre in legacy_id_map:
            remapped_prereqs.append(legacy_id_map[pre])
        elif isinstance(pre, int):
            remapped_prereqs.append(pre)

    return {
        'quest_id': new_id,
        'quest_uid_legacy': legacy_qid,
        'category': legacy.get('category', 'main'),
        'title': legacy.get('name', legacy.get('title', '')),
        'description': legacy.get('description', legacy.get('name', '')),
        'era': legacy.get('era', 'g1'),
        'objective_type': obj_norm,
        'level_min': min(LEVEL_CAP, legacy.get('level_req', legacy.get('level_min', 1))),
        'giver_npc_id': legacy.get('giver_npc_id', 1),
        'reward_gold': rewards.get('gold', 0),
        'reward_exp': rewards.get('exp', 0),
        'reward_items': rewards.get('items', []),
        'reward_reputation': rewards.get('reputation', 10),
        'prerequisites': remapped_prereqs,
        'chain_id': legacy.get('chain_id'),
        'chain_position': legacy.get('chain_position'),
        'dialog_tree_ref': legacy.get('dialog_tree_ref'),  # V13 preserve
        'is_protagonist_arc': legacy.get('category') == 'main',
        '_source': 'legacy_scaffold',
    }


# ============================================================
# NPC REGISTRY
# ============================================================
def load_npc_registry():
    candidates = [
        ROOT / 'cmd-npc' / 'output' / 'registry' / 'npc_full.jsonl',
        ROOT / 'cmd-npc' / 'existing' / 'NPC_438.jsonl',
    ]
    for p in candidates:
        if p.exists():
            npcs = []
            with p.open(encoding='utf-8') as f:
                for line in f:
                    if line.strip():
                        npcs.append(json.loads(line))
            log.info(f'npc_loaded {len(npcs)} from {p.name}')
            return npcs
    return [{'_index': i, 'name': f'NPC-{i}', 'can_give_quest': False} for i in range(1, 500)]


# V16: Smart NPC lookup by name keyword
def find_npc_by_name(npcs, keyword: str, valid_giver_only=True):
    """Find first NPC matching keyword. Return _index or None."""
    for n in npcs:
        name = n.get('name', '')
        if keyword in name:
            if valid_giver_only and not n.get('can_give_quest'):
                continue
            return n['_index']
    # Fallback: first match even if not valid giver
    for n in npcs:
        if keyword in n.get('name', ''):
            return n['_index']
    return None


def get_valid_giver_pool(npcs):
    """V17: pool of NPCs with can_give_quest=True, EXCLUDING NPC#1 (player template)."""
    return [n for n in npcs
            if n.get('can_give_quest') and n.get('_index') != 1]


# ============================================================
# TEMPLATES
# ============================================================
# (giver_keyword cho smart NPC lookup khi build)
MAIN_QUEST_TEMPLATES = [
    {'title': 'Trần Long tỉnh giấc bên Hồ Hoàn Kiếm', 'era': 'g1',
     'objective_type': 'explore', 'level_min': 1,
     'description': 'Năm 2026, Trần Long thức dậy không nhớ gì sau cú ngã ở Bảo tàng Hà Nội',
     'giver_keyword': None},
    {'title': 'Tìm Sư Vạn Hạnh trên Yên Tử', 'era': 'g1',
     'objective_type': 'talk', 'level_min': 2,
     'description': 'Bóng cao tăng Sư Vạn Hạnh hiện ra trong giấc mộng dẫn lối',
     'giver_keyword': 'Vạn Hạnh'},
    {'title': 'Xuyên không về Hoa Lư 968', 'era': 'f4',
     'objective_type': 'explore', 'level_min': 3,
     'description': 'Trần Long bước qua cổng thời gian, đến cố đô Hoa Lư cuối thời Đinh',
     'giver_keyword': 'Vạn Hạnh'},
    {'title': 'Thề trung với Lê Hoàn', 'era': 'f4',
     'objective_type': 'talk', 'level_min': 5,
     'description': 'Gặp Thập Đạo Tướng Quân Lê Hoàn, nhận lệnh chống quân Tống',
     'giver_keyword': 'Lê Hoàn'},
    {'title': 'Trận Bạch Đằng năm 981', 'era': 'f4',
     'objective_type': 'kill', 'level_min': 10,
     'description': 'Cùng Lê Đại Hành đánh bại quân Tống ở cửa Bạch Đằng',
     'giver_keyword': 'Lê Hoàn'},
    {'title': 'Cứu nguy Lý Công Uẩn ở Cổ Pháp', 'era': 'ly',
     'objective_type': 'escort', 'level_min': 12,
     'description': 'Hộ tống Lý Công Uẩn về kinh khi loạn lạc cuối thời Lê Ngoạ Triều',
     'giver_keyword': 'Lý Công Uẩn'},
    {'title': 'Định đô Thăng Long', 'era': 'ly',
     'objective_type': 'talk', 'level_min': 15,
     'description': 'Bàn việc dời đô từ Hoa Lư về thành Đại La năm 1010',
     'giver_keyword': 'Lý Thái Tổ'},
    {'title': 'Trận Như Nguyệt phá Tống', 'era': 'ly',
     'objective_type': 'kill', 'level_min': 22,
     'description': 'Đánh tan quân Tống dưới chỉ huy Lý Thường Kiệt năm 1077',
     'giver_keyword': 'Lý Thường Kiệt'},
    {'title': 'Bài thơ Nam quốc sơn hà', 'era': 'ly',
     'objective_type': 'collect', 'level_min': 25,
     'description': 'Tìm bản gốc bài thơ thần để cổ vũ quân sĩ ở Như Nguyệt',
     'giver_keyword': 'Lý Thường Kiệt'},
    {'title': 'Hội thề Bình Than', 'era': 'tran',
     'objective_type': 'talk', 'level_min': 32,
     'description': 'Tham dự hội thề các vương hầu chống quân Nguyên Mông năm 1282',
     'giver_keyword': 'Trần Hưng Đạo'},
    {'title': 'Trận Hàm Tử Quan', 'era': 'tran',
     'objective_type': 'kill', 'level_min': 35,
     'description': 'Phục kích quân Toa Đô tại cửa Hàm Tử năm 1285',
     'giver_keyword': 'Trần Hưng Đạo'},
    {'title': 'Diệt giặc Nguyên Mông ở Bạch Đằng 1288', 'era': 'tran',
     'objective_type': 'kill', 'level_min': 40,
     'description': 'Đại phá thuỷ quân Ô Mã Nhi bằng cọc gỗ trên sông Bạch Đằng',
     'giver_keyword': 'Trần Hưng Đạo'},
    {'title': 'Hồi giáp Trần Hưng Đạo', 'era': 'tran',
     'objective_type': 'collect', 'level_min': 42,
     'description': 'Tìm lại bộ giáp gia truyền của Hưng Đạo Đại Vương',
     'giver_keyword': 'Trần Quốc Tuấn'},
    {'title': 'Hịch tướng sĩ Vạn Kiếp', 'era': 'tran',
     'objective_type': 'deliver', 'level_min': 38,
     'description': 'Trao bản Hịch tướng sĩ cho các đạo quân',
     'giver_keyword': 'Trần Hưng Đạo'},
    {'title': 'Khởi nghĩa Lam Sơn', 'era': 'le',
     'objective_type': 'kill', 'level_min': 50,
     'description': 'Phất cờ khởi nghĩa cùng Lê Lợi tại đất Thanh Hoá năm 1418',
     'giver_keyword': 'Lê Lợi'},
    {'title': 'Tìm Nguyễn Trãi nơi ẩn cư', 'era': 'le',
     'objective_type': 'talk', 'level_min': 48,
     'description': 'Mời quân sư Nguyễn Trãi xuống núi giúp việc nước',
     'giver_keyword': 'Lê Lợi'},
    {'title': 'Bình Ngô Đại Cáo', 'era': 'le',
     'objective_type': 'collect', 'level_min': 58,
     'description': 'Thu thập tư liệu để Nguyễn Trãi soạn bản tuyên ngôn',
     'giver_keyword': 'Nguyễn Trãi'},
    {'title': 'Trận Chi Lăng vây Liễu Thăng', 'era': 'le',
     'objective_type': 'kill', 'level_min': 55,
     'description': 'Phục kích quân Minh tại ải Chi Lăng năm 1427',
     'giver_keyword': 'Lê Lợi'},
    {'title': 'Hội thề Đông Quan', 'era': 'le',
     'objective_type': 'escort', 'level_min': 60,
     'description': 'Áp giải tướng Minh Vương Thông đầu hàng',
     'giver_keyword': 'Lê Lợi'},
    {'title': 'Hành quân thần tốc từ Phú Xuân ra Bắc', 'era': 'tay_son',
     'objective_type': 'escort', 'level_min': 68,
     'description': 'Theo Nguyễn Huệ ra Bắc đại phá quân Thanh năm 1789',
     'giver_keyword': 'Nguyễn Huệ'},
    {'title': 'Đánh đồn Ngọc Hồi - Đống Đa', 'era': 'tay_son',
     'objective_type': 'kill', 'level_min': 72,
     'description': 'Cùng Quang Trung thần tốc phá quân Thanh mùng 5 Tết Kỷ Dậu',
     'giver_keyword': 'Quang Trung'},
    {'title': 'Hiệp ước với Nguyễn Huệ', 'era': 'tay_son',
     'objective_type': 'talk', 'level_min': 70,
     'description': 'Bàn việc thiết lập triều đại Tây Sơn',
     'giver_keyword': 'Nguyễn Huệ'},
    {'title': 'Hạ thành Quy Nhơn', 'era': 'tay_son',
     'objective_type': 'kill', 'level_min': 65,
     'description': 'Đánh chiếm thành Quy Nhơn của chúa Nguyễn năm 1773',
     'giver_keyword': 'Nguyễn Nhạc'},
    {'title': 'Trận Rạch Gầm - Xoài Mút', 'era': 'tay_son',
     'objective_type': 'kill', 'level_min': 74,
     'description': 'Phục kích thuỷ quân Xiêm trên sông Tiền năm 1785',
     'giver_keyword': 'Nguyễn Huệ'},
    {'title': 'Gặp Nguyễn Ánh ở Gia Định', 'era': 'nguyen',
     'objective_type': 'talk', 'level_min': 80,
     'description': 'Tìm hiểu mưu đồ trung hưng của chúa Nguyễn Ánh',
     'giver_keyword': 'Nguyễn Ánh'},
    {'title': 'Xây thành Phú Xuân', 'era': 'nguyen',
     'objective_type': 'deliver', 'level_min': 82,
     'description': 'Vận chuyển vật liệu xây dựng kinh đô Phú Xuân năm 1802',
     'giver_keyword': 'Gia Long'},
    {'title': 'Bộ Hoàng Việt luật lệ', 'era': 'nguyen',
     'objective_type': 'collect', 'level_min': 85,
     'description': 'Tham gia biên soạn bộ luật triều Nguyễn dưới Gia Long',
     'giver_keyword': 'Gia Long'},
    {'title': 'Khai phá Nam Kỳ Lục Tỉnh', 'era': 'nguyen',
     'objective_type': 'explore', 'level_min': 88,
     'description': 'Mở mang vùng đất phía Nam dưới triều Minh Mạng',
     'giver_keyword': 'Minh Mạng'},
    {'title': 'Hội thề Hoành Sơn', 'era': 'nguyen',
     'objective_type': 'talk', 'level_min': 90,
     'description': 'Phân ranh giới Đàng Trong - Đàng Ngoài cuối thời Nguyễn',
     'giver_keyword': 'Minh Mạng'},
    {'title': 'Nghênh đón sứ Bồ Đào Nha', 'era': 'nguyen',
     'objective_type': 'talk', 'level_min': 92,
     'description': 'Tiếp sứ thần phương Tây tại cảng Hội An',
     'giver_keyword': 'Thiệu Trị'},
]


def _make_title(idx: int, qtype: str, era: str) -> str:
    """V19: per-era suffix list to avoid anachronism."""
    prefixes = {
        'kill': ['Tiêu diệt', 'Truy quét', 'Đánh tan', 'Hạ gục', 'Diệt'],
        'collect': ['Thu thập', 'Tìm kiếm', 'Gom góp', 'Thu nhặt', 'Mang về'],
        'deliver': ['Đưa tin', 'Vận chuyển', 'Trao tận tay', 'Gửi đến', 'Báo'],
        'escort': ['Hộ tống', 'Đưa đường', 'Bảo vệ', 'Dẫn lối', 'Tháp tùng'],
        'talk': ['Trò chuyện cùng', 'Tìm gặp', 'Hỏi thăm', 'Tham vấn', 'Báo cáo'],
        'explore': ['Thám hiểm', 'Tuần tra', 'Khám phá', 'Điều tra', 'Tìm hiểu'],
    }
    suffix_map = ERA_SUFFIXES.get(era, ERA_SUFFIXES['_default_ancient'])
    pre = prefixes[qtype][idx % len(prefixes[qtype])]
    suf = suffix_map[qtype][idx % len(suffix_map[qtype])]
    era_tag = ERA_DIACRITIC[era]
    if idx % 3 == 0:
        return f'{pre} {suf} thời {era_tag}'
    return f'{pre} {suf}'


# ============================================================
# BUILD REGISTRY
# ============================================================
def build_quest_registry(npcs):
    quests = []
    seen_ids = set()
    seen_legacy_uid = set()
    giver_pool = get_valid_giver_pool(npcs)
    if not giver_pool:
        log.warning('no_valid_givers — fallback to first 500 NPCs')
        giver_pool = npcs[:500] if len(npcs) >= 500 else npcs[:]

    def _pick_giver(i):
        return giver_pool[i % len(giver_pool)].get('_index', 1)

    existing, source = r71_load_existing()
    next_id = 1
    legacy_quests = []
    if existing:
        legacy_id_map = {}
        sequential_id = next_id
        for legacy in existing:
            lqid = legacy.get('quest_id', '')
            if lqid and lqid not in legacy_id_map:
                legacy_id_map[lqid] = sequential_id
                sequential_id += 1
        for legacy in existing:
            lqid = legacy.get('quest_id', '')
            if lqid in seen_legacy_uid:
                continue
            seen_legacy_uid.add(lqid)
            new_id = legacy_id_map[lqid]
            cv = convert_legacy_quest(legacy, new_id, legacy_id_map)
            if not (cultural_lock_check(cv['title']) and cultural_lock_check(cv['description'])):
                push_alert_to_lead('LOW', 'legacy_quest_cultural_lock_fail',
                                   {'legacy_uid': lqid})
                continue
            legacy_quests.append(cv)
            seen_ids.add(new_id)
        next_id = sequential_id
        log.info(f'r71_legacy_converted {len(legacy_quests)} entries from {source}')
        quests.extend(legacy_quests)

    # Protagonist arc templates (V16: smart NPC giver lookup)
    for tpl in MAIN_QUEST_TEMPLATES:
        qid = next_id
        seen_ids.add(qid)
        # V16: smart NPC lookup; fallback to pool
        giver_id = None
        if tpl.get('giver_keyword'):
            giver_id = find_npc_by_name(npcs, tpl['giver_keyword'], valid_giver_only=True)
            if giver_id is None:
                # Try without valid filter
                giver_id = find_npc_by_name(npcs, tpl['giver_keyword'], valid_giver_only=False)
                if giver_id is not None:
                    push_alert_to_lead('LOW', 'historical_npc_cannot_give_quest',
                                       {'keyword': tpl['giver_keyword'], 'npc_id': giver_id})
        if giver_id is None:
            giver_id = _pick_giver(qid)
        quests.append({
            'quest_id': qid,
            'category': 'main',
            'title': tpl['title'],
            'description': tpl['description'],
            'era': tpl['era'],
            'objective_type': tpl['objective_type'],
            'level_min': min(LEVEL_CAP, tpl['level_min']),
            'giver_npc_id': giver_id,
            'reward_gold': 100 + qid * 5,
            'reward_exp': 200 + qid * 10,
            'reward_items': [],
            'reward_reputation': 20,
            'prerequisites': [qid - 1] if qid > 1 and quests else [],
            'chain_id': None,
            'chain_position': None,
            'dialog_tree_ref': None,
            'is_protagonist_arc': True,
            '_source': 'template',
        })
        next_id += 1

    by_cat_count = {}
    for q in quests:
        by_cat_count[q['category']] = by_cat_count.get(q['category'], 0) + 1

    # Find a non-NPC#1 reborn ritualist (use Sư Vạn Hạnh if available)
    reborn_master_id = find_npc_by_name(npcs, 'Vạn Hạnh', valid_giver_only=False)
    if reborn_master_id is None or reborn_master_id == 1:
        # Pick first valid giver that's not #1
        for n in npcs:
            if n.get('_index') != 1 and n.get('can_give_quest'):
                reborn_master_id = n['_index']
                break
    if reborn_master_id is None or reborn_master_id == 1:
        reborn_master_id = 2  # fallback

    for cat, target in TARGETS.items():
        current = by_cat_count.get(cat, 0)
        needed = max(0, target - current)
        prev_reborn_id = None  # for V20 reborn prereq chain
        for k in range(needed):
            qid = next_id
            seen_ids.add(qid)
            era = ERAS[k % len(ERAS)]
            qtype = OBJECTIVE_TYPES[k % len(OBJECTIVE_TYPES)]
            quest = {
                'quest_id': qid,
                'category': cat,
                'title': _make_title(k, qtype, era),
                'description': f'Nhiệm vụ {cat} thời {ERA_DIACRITIC[era]}',
                'era': era,
                'objective_type': qtype,
                'level_min': min(LEVEL_CAP, max(1, 1 + (k % 100))),
                'giver_npc_id': _pick_giver(qid),
                'reward_gold': 10 + (k % 100) * 5,
                'reward_exp': 30 + (k % 100) * 10,
                'reward_items': [],
                'reward_reputation': 1 + (k % 20),
                'prerequisites': [],
                'chain_id': None,
                'chain_position': None,
                'dialog_tree_ref': None,
                'is_protagonist_arc': False,
                '_source': 'generated',
            }

            if cat == 'main':
                quest['is_protagonist_arc'] = True
                quest['reward_gold'] = 100 + k * 30
                quest['reward_exp'] = 200 + k * 60
                quest['reward_reputation'] = 10 + k * 3
            elif cat == 'side':
                quest['reward_gold'] = 50 + k * 10
                quest['reward_reputation'] = 5 + k
            elif cat == 'lore':
                quest['objective_type'] = 'talk'
                quest['title'] = _make_title(k + 2000, 'talk', era)
                quest['reward_gold'] = 0
                quest['reward_exp'] = 500
                quest['reward_reputation'] = 20
                quest['unlocks_codex'] = True
            elif cat == 'event':
                quest['reward_gold'] = 1000 + k * 100
                quest['reward_exp'] = 2000
                quest['reward_items'] = ['event_token']
                quest['reward_reputation'] = 50
                quest['event_window_days'] = 7
            elif cat == 'raid':
                quest['objective_type'] = 'kill'
                quest['level_min'] = min(LEVEL_CAP, 60 + k)
                quest['reward_gold'] = 5000 + k * 500
                quest['reward_exp'] = 10000
                quest['reward_items'] = ['raid_loot_chest']
                quest['reward_reputation'] = 100
                quest['min_party_size'] = 5
                raid_bosses = [
                    'Bạch Hổ Sơn Vương', 'Hắc Long Đầm Lầy', 'Cửu Vĩ Hồ Tinh',
                    'Mãng Xà Tinh Hang Tối', 'Thiên Lôi Tà Thần', 'Sài Lang Vương',
                    'Tà Tăng Núi Yên', 'Thuồng Luồng Bạch Đằng', 'Ma Cây Cổ Thụ',
                    'Quỷ Đầu Trâu', 'Quỷ Mặt Ngựa', 'Cương Thi Thiên Niên',
                ]
                boss = raid_bosses[k % len(raid_bosses)]
                quest['title'] = f'Tử chiến {boss} thời {ERA_DIACRITIC[era]}'
                quest['description'] = f'Đánh boss {boss} 5 người cùng tổ đội'
            elif cat == 'reborn':
                # V15+V17+V20 fix
                quest['objective_type'] = 'explore'
                quest['level_min'] = LEVEL_CAP  # cap 120
                quest['reward_gold'] = 0
                quest['reward_exp'] = 0
                quest['reward_items'] = ['reborn_token']
                quest['reward_reputation'] = 0
                quest['resets_stats'] = True
                quest['title'] = f'Chuyển sinh lần {k+1} sang thời {ERA_DIACRITIC[era]}'
                quest['description'] = f'Trần Long chuyển sinh sang thời {ERA_DIACRITIC[era]}, cấp {LEVEL_CAP}'
                quest['giver_npc_id'] = reborn_master_id  # V17 NOT player
                if prev_reborn_id is not None:
                    quest['prerequisites'] = [prev_reborn_id]
                prev_reborn_id = qid

            quests.append(quest)
            next_id += 1

    while len(quests) < TARGET_QUEST:
        qid = next_id
        seen_ids.add(qid)
        i = len(quests) - TOTAL_CATEGORIZED
        era = ERAS[i % len(ERAS)]
        qtype = OBJECTIVE_TYPES[i % len(OBJECTIVE_TYPES)]
        quests.append({
            'quest_id': qid,
            'category': 'generated',
            'title': _make_title(i + 3000, qtype, era),
            'description': f'Nhiệm vụ thường nhật thời {ERA_DIACRITIC[era]}',
            'era': era,
            'objective_type': qtype,
            'level_min': min(LEVEL_CAP, max(1, 1 + (i % 100))),
            'giver_npc_id': _pick_giver(qid),
            'reward_gold': 10 + (i % 100) * 5,
            'reward_exp': 30 + (i % 100) * 10,
            'reward_items': [],
            'reward_reputation': 1 + (i % 20),
            'prerequisites': [],
            'chain_id': None,
            'chain_position': None,
            'dialog_tree_ref': None,
            'is_protagonist_arc': False,
            '_source': 'generated',
        })
        next_id += 1

    return quests, len(legacy_quests)


# ============================================================
# BUILD CHAINS (V11: cap MAX_CHAIN_LEN, V21: last era unlocks=False)
# ============================================================
def build_chains(quests):
    chains = []
    main_quests = [q for q in quests if q['category'] == 'main']
    lore_quests = [q for q in quests if q['category'] == 'lore']

    last_era = ERAS[-1]  # 'nguyen'

    # Build era chains, splitting if too long
    for era in ERAS:
        era_mains = [q for q in main_quests if q['era'] == era]
        if not era_mains:
            continue
        # V11: split into chunks of MAX_CHAIN_LEN
        n_chunks = (len(era_mains) + MAX_CHAIN_LEN - 1) // MAX_CHAIN_LEN
        for chunk_idx in range(n_chunks):
            start = chunk_idx * MAX_CHAIN_LEN
            end = min(start + MAX_CHAIN_LEN, len(era_mains))
            cqs = era_mains[start:end]
            if len(cqs) < MIN_CHAIN_LEN:
                continue
            chain_id = f'SVTK_CHAIN_{era.upper()}_{chunk_idx+1}'
            is_last_chunk = chunk_idx == n_chunks - 1
            is_last_era = era == last_era
            chains.append({
                'chain_id': chain_id,
                'name': f'Chuỗi sử thời {ERA_DIACRITIC[era]} - phần {chunk_idx+1}',
                'era': era,
                'quest_ids': [q['quest_id'] for q in cqs],
                # V21: last era last chunk unlocks=False (no next era)
                'unlocks_next_era': is_last_chunk and not is_last_era,
            })
            for pos, q in enumerate(cqs):
                q['chain_id'] = chain_id
                q['chain_position'] = pos
                if pos > 0:
                    prev_qid = cqs[pos - 1]['quest_id']
                    if prev_qid not in q['prerequisites']:
                        q['prerequisites'].append(prev_qid)

    # Ensure >=34 chains: add lore specials
    i = 0
    while len(chains) < 34 and i * 4 < len(lore_quests):
        cqs = lore_quests[i * 4:(i + 1) * 4]
        if len(cqs) < MIN_CHAIN_LEN:
            break
        chain_id = f'SVTK_CHAIN_LORE_{i+1}'
        chains.append({
            'chain_id': chain_id,
            'name': f'Chuỗi lore đặc biệt {i+1}',
            'era': cqs[0]['era'],
            'quest_ids': [q['quest_id'] for q in cqs],
            'unlocks_next_era': False,
        })
        for pos, q in enumerate(cqs):
            q['chain_id'] = chain_id
            q['chain_position'] = pos
            if pos > 0:
                prev_qid = cqs[pos - 1]['quest_id']
                if prev_qid not in q['prerequisites']:
                    q['prerequisites'].append(prev_qid)
        i += 1

    return chains


# ============================================================
# WRITE OUTPUTS
# ============================================================
def write_outputs(quests, chains):
    by_category = {}
    for q in quests:
        by_category.setdefault(q['category'], []).append(q)
    for cat, lst in by_category.items():
        path = OUTPUT_DIR / 'registry' / f'quest_{cat}.jsonl'
        with path.open('w', encoding='utf-8') as f:
            for q in lst:
                f.write(json.dumps(q, ensure_ascii=False) + '\n')
    with (OUTPUT_DIR / 'registry' / 'quest_full.jsonl').open('w', encoding='utf-8') as f:
        for q in quests:
            f.write(json.dumps(q, ensure_ascii=False) + '\n')
    (OUTPUT_DIR / 'chains' / 'quest_chains.json').write_text(
        json.dumps(chains, indent=2, ensure_ascii=False), encoding='utf-8')

    sql = '''-- Quest schema — CMD_QUEST v1.3 / SVTK Foundation v2.8.0
CREATE TABLE IF NOT EXISTS quests (
    quest_id            INTEGER PRIMARY KEY,
    quest_uid_legacy    VARCHAR(64),
    category            VARCHAR(16) NOT NULL,
    title               VARCHAR(256) NOT NULL,
    description         TEXT,
    era                 VARCHAR(32) NOT NULL,
    objective_type      VARCHAR(16) NOT NULL,
    level_min           INTEGER NOT NULL DEFAULT 1,
    giver_npc_id        INTEGER NOT NULL REFERENCES npcs(npc_id),
    reward_gold         INTEGER DEFAULT 0,
    reward_exp          INTEGER DEFAULT 0,
    reward_items        JSONB DEFAULT '[]'::jsonb,
    reward_reputation   INTEGER DEFAULT 0,
    prerequisites       INTEGER[] DEFAULT '{}',
    chain_id            VARCHAR(64),
    chain_position      INTEGER,
    dialog_tree_ref     VARCHAR(128),
    is_protagonist_arc  BOOLEAN DEFAULT FALSE,
    event_window_days   INTEGER,
    min_party_size      INTEGER DEFAULT 1,
    resets_stats        BOOLEAN DEFAULT FALSE,
    unlocks_codex       BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    CHECK (category IN ('main','side','lore','event','raid','reborn','generated')),
    CHECK (objective_type IN ('kill','collect','deliver','escort','talk','explore')),
    CHECK (era IN ('g1','f1','f2','f3','f4','f5','ly','tran','le','tay_son','nguyen')),
    CHECK (level_min >= 1 AND level_min <= 120),
    CHECK (reward_gold >= 0),
    CHECK (reward_exp >= 0),
    UNIQUE (quest_id)
);
CREATE INDEX IF NOT EXISTS idx_quests_era ON quests(era);
CREATE INDEX IF NOT EXISTS idx_quests_giver ON quests(giver_npc_id);
CREATE INDEX IF NOT EXISTS idx_quests_category ON quests(category);
CREATE INDEX IF NOT EXISTS idx_quests_chain ON quests(chain_id) WHERE chain_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS quest_chains (
    chain_id            VARCHAR(64) PRIMARY KEY,
    name                VARCHAR(256) NOT NULL,
    era                 VARCHAR(32) NOT NULL,
    quest_ids           INTEGER[] NOT NULL,
    unlocks_next_era    BOOLEAN DEFAULT FALSE,
    CHECK (era IN ('g1','f1','f2','f3','f4','f5','ly','tran','le','tay_son','nguyen')),
    UNIQUE (chain_id)
);

CREATE TABLE IF NOT EXISTS quest_instances (
    instance_uuid       UUID PRIMARY KEY,
    quest_id            INTEGER NOT NULL REFERENCES quests(quest_id),
    player_id           UUID NOT NULL,
    status              VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    progress            INTEGER NOT NULL DEFAULT 0,
    reward_claimed      BOOLEAN NOT NULL DEFAULT FALSE,
    accepted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    CHECK (status IN ('ACTIVE','COMPLETED','FAILED','ABANDONED')),
    CHECK (progress >= 0 AND progress <= 100),
    UNIQUE (quest_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_quest_instances_player ON quest_instances(player_id);

CREATE TABLE IF NOT EXISTS quest_transaction_log (
    txn_uuid            UUID PRIMARY KEY,
    actor_uuid          UUID NOT NULL,
    action              VARCHAR(32) NOT NULL,
    player_id           UUID,
    metadata            JSONB DEFAULT '{}'::jsonb,
    ts                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (action IN ('quest_accept','quest_complete','quest_abandon',
                      'quest_rollback','reward_grant','progress_update'))
);

CREATE TABLE IF NOT EXISTS reward_uuid_log (
    reward_uuid         UUID PRIMARY KEY,
    quest_id            INTEGER REFERENCES quests(quest_id),
    quest_instance_uuid UUID REFERENCES quest_instances(instance_uuid),
    player_id           UUID NOT NULL,
    reward_type         VARCHAR(16) NOT NULL,
    amount              INTEGER,
    item_template_id    INTEGER,
    granted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (reward_type IN ('gold','exp','item','reputation')),
    UNIQUE (reward_uuid)
);
'''
    (OUTPUT_DIR / 'schema' / 'quest_table.sql').write_text(sql, encoding='utf-8')


# ============================================================
# VALIDATOR + SELF TESTS
# ============================================================
def detect_bugs(quests, chains):
    bugs = []
    if len(quests) < TARGET_QUEST:
        bugs.append({'code': 'quest_count_short',
                     'detail': {'found': len(quests), 'target': TARGET_QUEST}})

    eras_used = {q['era'] for q in quests}
    missing = [e for e in ERAS if e not in eras_used]
    if missing:
        bugs.append({'code': 'era_missing', 'detail': {'missing': missing}})

    if len(chains) < 34:
        bugs.append({'code': 'chain_count_short',
                     'detail': {'found': len(chains)}})

    # V11: chain length cap
    for c in chains:
        if len(c['quest_ids']) > MAX_CHAIN_LEN:
            bugs.append({'code': 'chain_length_over_cap',
                         'detail': {'chain_id': c['chain_id'],
                                    'length': len(c['quest_ids']),
                                    'cap': MAX_CHAIN_LEN}})

    # V20: reborn level cap
    for q in quests:
        if q['level_min'] > LEVEL_CAP:
            bugs.append({'code': 'level_min_over_cap',
                         'detail': {'quest_id': q['quest_id'],
                                    'level_min': q['level_min'],
                                    'cap': LEVEL_CAP}})
            break

    # V21: last era unlocks should be False
    last_era_chains = [c for c in chains if c['era'] == ERAS[-1]]
    for c in last_era_chains:
        if c.get('unlocks_next_era'):
            bugs.append({'code': 'last_era_unlocks_violation',
                         'detail': {'chain_id': c['chain_id'], 'era': c['era']}})

    return bugs


def validator(quests, chains):
    checks = []
    checks.append(('quest_count', len(quests) >= TARGET_QUEST,
                   {'found': len(quests), 'target': TARGET_QUEST}))
    by_cat = {}
    for q in quests:
        by_cat[q['category']] = by_cat.get(q['category'], 0) + 1
    for cat, target in TARGETS.items():
        checks.append((f'category_{cat}', by_cat.get(cat, 0) >= target,
                       {'found': by_cat.get(cat, 0), 'target': target}))
    ids = [q['quest_id'] for q in quests]
    checks.append(('unique_quest_id', len(ids) == len(set(ids)), {}))
    obj_used = {q['objective_type'] for q in quests}
    checks.append(('objective_6_types',
                   set(OBJECTIVE_TYPES).issubset(obj_used), {}))
    eras_used = {q['era'] for q in quests}
    checks.append(('era_11_covered', set(ERAS).issubset(eras_used), {}))
    has_giver = all(q.get('giver_npc_id') for q in quests)
    checks.append(('all_have_giver', has_giver, {}))
    checks.append(('chains_34', len(chains) >= 34, {'found': len(chains)}))
    checks.append(('schema_exists',
                   (OUTPUT_DIR / 'schema' / 'quest_table.sql').exists(), {}))
    bad = [q for q in quests if not cultural_lock_check(q.get('title', ''))]
    checks.append(('cultural_lock_title', len(bad) == 0, {'violations': len(bad)}))
    proto = sum(1 for q in quests if q.get('is_protagonist_arc'))
    checks.append(('protagonist_arc_count', proto >= 50, {'found': proto}))
    checks.append(('r50_prerequisites_field',
                   all('prerequisites' in q for q in quests), {}))
    checks.append(('r50_chain_id_field',
                   all('chain_id' in q for q in quests), {}))
    # V11 cap
    checks.append(('chain_length_under_cap',
                   all(len(c['quest_ids']) <= MAX_CHAIN_LEN for c in chains), {}))
    # V20 cap
    checks.append(('level_min_under_cap',
                   all(q['level_min'] <= LEVEL_CAP for q in quests), {}))
    # V21 last era unlocks=False
    checks.append(('last_era_no_unlocks',
                   not any(c.get('unlocks_next_era') for c in chains if c['era'] == ERAS[-1]),
                   {}))
    # V17 NPC#1 not used as giver (except player default OK pose)
    bad_giver_1 = [q for q in quests if q['giver_npc_id'] == 1]
    checks.append(('no_npc_1_as_giver',
                   len(bad_giver_1) == 0, {'count': len(bad_giver_1)}))
    # V13 dialog_tree_ref preserved for legacy
    legacy_with_dlg = [q for q in quests
                       if q.get('_source') == 'legacy_scaffold' and q.get('dialog_tree_ref')]
    legacy_total = sum(1 for q in quests if q.get('_source') == 'legacy_scaffold')
    checks.append(('legacy_dialog_tree_preserved',
                   legacy_total == 0 or legacy_with_dlg,
                   {'preserved': len(legacy_with_dlg), 'total_legacy': legacy_total}))

    passed = sum(1 for _, ok, _ in checks if ok)
    total = len(checks)
    errors = [{'code': n, **d} for n, ok, d in checks if not ok]
    report = {'passed': passed, 'total': total,
              'pass_rate': passed / total, 'errors': errors,
              'checks': [{'code': n, 'pass': ok, **d} for n, ok, d in checks]}
    (OUTPUT_DIR / 'reports' / 'validation.json').write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    return report


def chain_integrity_report(quests, chains):
    qid_set = {q['quest_id'] for q in quests}
    ok = []
    bad = []
    for c in chains:
        missing = [qid for qid in c['quest_ids'] if qid not in qid_set]
        if missing:
            bad.append({'chain_id': c['chain_id'], 'missing': missing})
        else:
            ok.append(c['chain_id'])
    report = {'total_chains': len(chains),
              'ok_chains': len(ok), 'bad_chains': len(bad), 'bad_details': bad}
    (OUTPUT_DIR / 'reports' / 'chain_integrity.json').write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    return report


def self_tests(quests, chains, npcs):
    results = []

    def t(name, fn):
        try:
            fn()
            results.append({'test': name, 'pass': True})
        except AssertionError as e:
            results.append({'test': name, 'pass': False, 'error': str(e)})

    t('count_ge_3000', lambda: (_ for _ in ()).throw(AssertionError(f'{len(quests)}')) if len(quests) < TARGET_QUEST else None)

    def _has_key(k):
        def inner():
            bad = [q for q in quests if k not in q]
            assert not bad, f'{len(bad)} missing {k}'
        return inner

    t('schema_prerequisites', _has_key('prerequisites'))
    t('schema_chain_id', _has_key('chain_id'))
    t('schema_chain_position', _has_key('chain_position'))
    t('schema_dialog_tree_ref', _has_key('dialog_tree_ref'))

    def _era11():
        eras = {q['era'] for q in quests}
        miss = [e for e in ERAS if e not in eras]
        assert not miss, miss
    t('era_11_covered', _era11)

    def _culture():
        bad = [q for q in quests if not cultural_lock_check(q.get('title', ''))]
        assert not bad
        bad = [q for q in quests if not cultural_lock_check(q.get('description', ''))]
        assert not bad
    t('cultural_lock', _culture)

    def _objs():
        used = {q['objective_type'] for q in quests}
        assert used == set(OBJECTIVE_TYPES)
    t('obj_6_types', _objs)

    npc_ids = {n['_index'] for n in npcs}
    def _giver_valid():
        bad = [q for q in quests if q['giver_npc_id'] not in npc_ids]
        assert not bad, f'{len(bad)} orphan giver'
    t('giver_npc_valid', _giver_valid)

    def _chain_refs():
        qs = {q['quest_id'] for q in quests}
        bad = [c for c in chains if any(qid not in qs for qid in c['quest_ids'])]
        assert not bad
    t('chain_refs_valid', _chain_refs)

    def _uniq():
        ids = [q['quest_id'] for q in quests]
        assert len(ids) == len(set(ids))
    t('unique_quest_id', _uniq)

    def _uniq_chain():
        cids = [c['chain_id'] for c in chains]
        assert len(cids) == len(set(cids))
    t('unique_chain_id', _uniq_chain)

    def _prereq_valid():
        qs = {q['quest_id'] for q in quests}
        bad = []
        for q in quests:
            for p in q.get('prerequisites', []):
                if p not in qs:
                    bad.append((q['quest_id'], p))
        assert not bad, f'{len(bad)} broken prereq'
    t('prereq_refs_valid', _prereq_valid)

    def _raid():
        raids = [q for q in quests if q['category'] == 'raid']
        assert all(q.get('reward_gold', 0) >= 5000 for q in raids)
    t('raid_scaled', _raid)

    def _chain34():
        assert len(chains) >= 34
    t('chain_count_34', _chain34)

    # V11 chain length
    def _chain_len():
        big = [c for c in chains if len(c['quest_ids']) > MAX_CHAIN_LEN]
        assert not big, f'{len(big)} chains over cap {MAX_CHAIN_LEN}'
    t('v11_chain_length_cap', _chain_len)

    # V20 level cap
    def _lvl_cap():
        over = [q for q in quests if q['level_min'] > LEVEL_CAP]
        assert not over, f'{len(over)} over level cap'
    t('v20_level_cap', _lvl_cap)

    # V21 last era unlocks
    def _last_unlocks():
        last_chains = [c for c in chains if c['era'] == ERAS[-1]]
        assert not any(c.get('unlocks_next_era') for c in last_chains)
    t('v21_last_era_no_unlocks', _last_unlocks)

    # V17 NPC#1 not giver
    def _no_npc1():
        bad = [q for q in quests if q['giver_npc_id'] == 1]
        assert not bad, f'{len(bad)} use NPC#1'
    t('v17_no_npc_1', _no_npc1)

    # V13 dialog preserved
    def _dlg_preserved():
        legacy = [q for q in quests if q.get('_source') == 'legacy_scaffold']
        if legacy:
            with_dlg = sum(1 for q in legacy if q.get('dialog_tree_ref'))
            assert with_dlg == len(legacy), f'{len(legacy)-with_dlg} legacy lost dialog'
    t('v13_legacy_dialog_preserved', _dlg_preserved)

    # R83 protagonist
    def _r83():
        proto = [q for q in quests if q.get('is_protagonist_arc')]
        eras = {q['era'] for q in proto}
        assert 'g1' in eras
        assert any(e.startswith('f') for e in eras)
        assert all(e in eras for e in ['ly', 'tran', 'le', 'tay_son', 'nguyen'])
    t('r83_protagonist_eras', _r83)

    passed = sum(1 for r in results if r['pass'])
    summary = {'total_tests': len(results), 'passed': passed,
               'failed': len(results) - passed, 'details': results}
    (OUTPUT_DIR / 'reports' / 'self_tests.json').write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding='utf-8')
    return summary


def write_honest_gaps(legacy_count):
    fp = ROOT / 'foundation' / 'SVTK_FOUNDATION_v2.8.0.md'
    actual_hash = hashlib.sha256(fp.read_bytes()).hexdigest() if fp.exists() else 'missing'
    gaps = {
        'cmd_version': CMD_VERSION,
        'foundation_hash_actual': actual_hash,
        'legacy_seed_count': legacy_count,
        'level_cap': LEVEL_CAP,
        'max_chain_len': MAX_CHAIN_LEN,
        'gaps_admitted': [
            {'severity': 'LOW',
             'item': 'cmd-item registry chưa ship → reward_items placeholder',
             'reason': 'cmd-item/output/legacy/ chỉ có TS source, chưa có ITEM JSONL registry. '
                       'event_token/raid_loot_chest/reborn_token vẫn là logical name.',
             'mitigation': 'CMD ITEM ship JSONL → re-run CMD QUEST rebuild reward link'},
            {'severity': 'LOW',
             'item': 'Pre-existing TS tests dùng legacy schema',
             'reason': 'cmd-quest/tests/{zod_validate,reward_distribution,npc_ref}.test.ts '
                       'expect 150 entries string-ID schema, hardcoded path C:/.../SVTK_UPLOAD_WORK/. '
                       'Run sẽ FAIL. Tests stale với v1.3 spec.',
             'mitigation': 'Add v1.3 schema TS tests beside legacy, hoặc deprecate legacy'},
            {'severity': 'LOW',
             'item': 'Generated quest template lặp',
             'reason': f'~{TARGET_GENERATED} quest generated theo template prefix+suffix '
                       'Vietnamese rotation. Cultural lock pass, nhưng không deep narrative.',
             'mitigation': 'CMD DIALOG enrich qua dialog tree'},
            {'severity': 'LOW',
             'item': 'NPC#1 Trần Long player template — không thể là giver',
             'reason': 'NPC#1 metadata era=tran (mismatch R83 origin g1), '
                       'can_give_quest=False. Reborn quest dùng giver alt (Sư Vạn Hạnh hoặc '
                       'NPC giver pool đầu tiên).',
             'mitigation': 'CMD NPC fix metadata Trần Long: era=g1 + can_give_quest=False '
                          '(player); add NPC mới làm reborn ritualist (Tiên Ông Yên Tử etc.)'},
        ],
    }
    (OUTPUT_DIR / 'reports' / 'honest_gaps.json').write_text(
        json.dumps(gaps, indent=2, ensure_ascii=False), encoding='utf-8')


# ============================================================
# MAIN
# ============================================================
def main():
    try:
        setup()
        log.info(f'cycle_id={CYCLE_ID} cmd_version={CMD_VERSION}')
        npcs = load_npc_registry()
        quests, legacy_count = build_quest_registry(npcs)
        chains = build_chains(quests)
        bugs = detect_bugs(quests, chains)
        log.info(f'detect_bugs found={len(bugs)}')
        if bugs:
            for b in bugs[:10]:
                log.warning(f'  bug: {b["code"]} {b["detail"]}')
        write_outputs(quests, chains)
        result = validator(quests, chains)
        chain_report = chain_integrity_report(quests, chains)
        tests = self_tests(quests, chains, npcs)
        write_honest_gaps(legacy_count)
        log.info(f'validator pass_rate={result["pass_rate"]:.3f} '
                 f'passed={result["passed"]}/{result["total"]}')
        log.info(f'chain_integrity ok={chain_report["ok_chains"]} '
                 f'bad={chain_report["bad_chains"]}')
        log.info(f'self_tests passed={tests["passed"]}/{tests["total_tests"]}')

        if result['pass_rate'] >= 0.99 and tests['failed'] == 0 and not bugs:
            status = 'PASS'
        elif result['pass_rate'] >= 0.95:
            status = 'PARTIAL'
        else:
            status = 'FAIL'

        summary = {
            'cmd_id': 'QUEST',
            'cmd_version': CMD_VERSION,
            'cycle_id': CYCLE_ID,
            'status': status,
            'pass_rate': result['pass_rate'],
            'quest_count': len(quests),
            'chain_count': len(chains),
            'legacy_seed_count': legacy_count,
            'self_tests_passed': f'{tests["passed"]}/{tests["total_tests"]}',
            'bugs_detected': len(bugs),
            'duration_sec': round(time.time() - CYCLE_START, 2),
        }
        (OUTPUT_DIR / 'reports' / 'final_summary.json').write_text(
            json.dumps(summary, indent=2, ensure_ascii=False), encoding='utf-8')
        push_completion_to_lead(f'cmd_quest_cycle_{CYCLE_ID}', status, summary)
        push_heartbeat_to_lead()
        print(json.dumps(summary, indent=2, ensure_ascii=False))
        return {'PASS': 0, 'PARTIAL': 1, 'FAIL': 2}.get(status, 2)
    except Exception as e:
        log.critical(f'cmd_unhandled {e}', exc_info=True)
        push_alert_to_lead('HIGH', 'cmd_quest_unhandled_exception', {'error': str(e)})
        return 10


if __name__ == '__main__':
    sys.exit(main())
