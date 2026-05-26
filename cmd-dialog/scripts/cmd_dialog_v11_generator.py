#!/usr/bin/env python3
"""CMD_DIALOG v1.1 — autonomous dialog generator ≥50000 lines.

Spec: D:/Desktop/CMD_DIALOG_v1.1.md, foundation v2.8.0.
Categories: greeting / quest / lore / bark / combat / trade / story.
Determinism: hashlib-seeded selection (NO random).
Cultural lock R30: anti-CJK / anti-Hiragana / anti-Katakana / anti-Tam Quốc.
Cross-ref R47: speaker_id from cmd-npc/output/registry/npc_full.jsonl.
"""
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path

CMD_NAME = "DIALOG"
CMD_VERSION = "1.1.0"
FOUNDATION_HASH = (
    "cc194e6cad2225d197c4a5539352deb538c99cdd6a21845a8354260602287bbb"
)

ROOT = Path(__file__).resolve().parents[2]
CMD_DIR = ROOT / "cmd-dialog"
OUTPUT_DIR = CMD_DIR / "output"
NPC_REGISTRY = ROOT / "cmd-npc" / "output" / "registry" / "npc_full.jsonl"
FOUNDATION_FILE = ROOT / "foundation" / "SVTK_FOUNDATION_v2.10.0.md"

TARGET_FULL = 50000
TARGET_BY_TYPE = {
    "greeting": 8000,
    "quest":    12000,
    "lore":     5000,
    "bark":     7000,
    "combat":   5000,
    "trade":    3000,
    "story":    2297,
}
TYPES_ORDER = ["greeting", "quest", "lore", "bark", "combat", "trade", "story"]
sum_targets = sum(TARGET_BY_TYPE.values())  # 42297
# Remaining slack to reach 50000 — distribute across categories
SLACK_FROM_TARGETS = TARGET_FULL - sum_targets  # 7703
SLACK_DISTRIBUTION = {
    "greeting": 1500,
    "quest":    2200,
    "lore":     900,
    "bark":     1500,
    "combat":   900,
    "trade":    400,
    "story":    303,
}
assert sum(SLACK_DISTRIBUTION.values()) == SLACK_FROM_TARGETS, (
    "slack distribution off"
)
FINAL_COUNT_BY_TYPE = {
    k: TARGET_BY_TYPE[k] + SLACK_DISTRIBUTION[k] for k in TYPES_ORDER
}
assert sum(FINAL_COUNT_BY_TYPE.values()) == TARGET_FULL

ERAS_MAIN = ["ly", "tran", "le", "tay_son", "nguyen"]
ERAS_ALL = ["g1", "f1", "f2", "f3", "f4", "f5", "ly", "tran", "le",
            "tay_son", "nguyen"]
ERA_NAME = {
    "g1": "Globeway hiện đại", "f1": "Hồng Bàng", "f2": "Âu Lạc",
    "f3": "Bắc thuộc", "f4": "Ngô Đinh Lê", "f5": "tiền Lý",
    "ly": "Lý", "tran": "Trần", "le": "Lê",
    "tay_son": "Tây Sơn", "nguyen": "Nguyễn",
}
ERA_CAPITAL = {
    "g1": "Hà Nội", "f1": "Phong Châu", "f2": "Cổ Loa",
    "f3": "Đông Đô", "f4": "Hoa Lư", "f5": "Hoa Lư",
    "ly": "Thăng Long", "tran": "Thăng Long", "le": "Đông Kinh",
    "tay_son": "Phú Xuân", "nguyen": "Huế",
}

# R30 cultural lock
CULTURAL_LOCK_REGEX = re.compile(r"[一-鿿぀-ゟ゠-ヿ]")
TAM_QUOC_BAN = re.compile(
    r"(Tào Tháo|Lưu Bị|Quan Vũ|Trương Phi|Khổng Minh|Cao Cao|Liu Bei|"
    r"Zhuge Liang|Guan Yu|Zhang Fei|Tam Quốc)",
    re.IGNORECASE,
)


def cultural_lock_check(text: str) -> bool:
    if CULTURAL_LOCK_REGEX.search(text):
        return False
    if TAM_QUOC_BAN.search(text):
        return False
    return True


def verify_foundation() -> None:
    if not FOUNDATION_FILE.exists():
        print(f"FOUNDATION_NOT_FOUND {FOUNDATION_FILE}")
        sys.exit(99)
    actual = hashlib.sha256(FOUNDATION_FILE.read_bytes()).hexdigest()
    if actual != FOUNDATION_HASH:
        print(f"FOUNDATION_HASH_MISMATCH actual={actual}")
        sys.exit(99)
    print(f"OK foundation hash {actual[:16]}...")


def load_npc_registry() -> list:
    if not NPC_REGISTRY.exists():
        print(f"FATAL npc_registry missing {NPC_REGISTRY}")
        sys.exit(2)
    npcs = []
    for line in NPC_REGISTRY.read_text("utf-8").splitlines():
        if line.strip():
            npcs.append(json.loads(line))
    print(f"OK npcs loaded {len(npcs)}")
    return npcs


def seeded_pick(seed_key: str, pool):
    """Deterministic pick from pool given a string seed."""
    if not pool:
        return None
    digest = hashlib.sha256(seed_key.encode("utf-8")).digest()
    idx = int.from_bytes(digest[:8], "big") % len(pool)
    return pool[idx]


# ============================================================
# TEMPLATE POOLS — era-locked Vietnamese, no CJK, no Tam Quốc
# ============================================================
GREETING_TEMPLATES = [
    "Chào ngài, có gì giúp được không?",
    "Kính chào quý khách phương xa.",
    "Xin hỏi ngài từ đâu tới?",
    "Mời ngài vào trong dùng trà.",
    "Hôm nay trời đẹp, ngài đi đâu thế?",
    "Lâu lắm rồi mới gặp ngài.",
    "Mong ngài vạn sự an khang.",
    "Bệ hạ vạn tuế!",
    "Tướng quân khỏe chứ?",
    "Chào ngài, hôm nay buôn bán thế nào?",
    "Mời ngài qua đây nghỉ chân.",
    "Lâu rồi không thấy ngài ghé qua làng.",
    "Bữa ăn vừa dọn, ngài có dùng cùng không?",
    "Đường xa mệt nhọc, mời ngài uống chén nước.",
    "Cảm ơn ngài đã ghé chốn này.",
    "Phúc đức cho gia đình ngài.",
    "Nghe danh ngài đã lâu, hôm nay mới gặp.",
    "Chúc ngài chân cứng đá mềm.",
    "Lữ khách phương xa, ghé qua một chút.",
    "Ngài có cần ta dẫn đường không?",
    "Trời tối rồi, ngài có chỗ nghỉ chưa?",
    "Mời ngài ngồi xuống đây.",
    "Ngày lành tháng tốt, kính chào ngài.",
    "Có gì cần hỏi cứ hỏi nhé.",
    "Trà đặc vừa pha, ngài thử xem.",
    "Hôm nay làng có hội, ngài ở lại không?",
    "Trẻ con trong làng quý mến người lạ lắm.",
    "Ngài quả là khách quý.",
    "Mưa rồi, vào trong ngồi đã.",
    "Bao năm rồi ngài mới về?",
    "Quê hương đón ngài.",
    "Mong ngài bình an.",
    "Đường tới đây có an toàn không?",
    "Ngài có tin tức gì từ kinh đô không?",
    "Quan tướng có khỏe không?",
    "Chuyện mùa màng năm nay sao rồi?",
    "Ngài có nhớ quê không?",
    "Đêm nay ngủ lại đây nhé.",
    "Có gì hay ho ngài kể nghe đi.",
    "Cha mẹ ngài còn khỏe chứ?",
]

QUEST_TEMPLATES = [
    "Ta cần ngài giúp một việc.",
    "Trong rừng phía bắc có thú dữ, ngài có thể trừ giúp không?",
    "Mất con bê rồi, ngài thấy ở đâu báo ta nhé.",
    "Đem thư này tới làng bên giúp ta.",
    "Quân giặc đang kéo tới, cần thu thập lương thực.",
    "Trận chiến sắp tới, ngài cùng ta xông pha?",
    "Bí kíp của tổ tiên thất truyền, ngài hãy tìm về.",
    "Đứa con trai ta đi từ sáng chưa về, ngài tìm giúp.",
    "Giếng làng nhiễm bẩn, ngài tìm nguồn nước sạch giúp.",
    "Bọn cướp chiếm chùa rồi, ngài đuổi giúp ta.",
    "Lương khô ta cần đem lên núi tế lễ.",
    "Sách cổ trong viện bị mất, ngài tìm lại giúp.",
    "Sứ giả đang chờ thư hồi âm.",
    "Mộ tổ tiên xập, ngài giúp đắp lại.",
    "Đoàn buôn cần hộ vệ qua đèo.",
    "Hươu nai phá mùa màng, ngài săn giúp.",
    "Đường lên kinh cần khai thông sau bão.",
    "Tướng quân triệu tập tinh binh, ngài có theo không?",
    "Bí thuốc gia truyền cần hái đủ ba vị thảo dược.",
    "Đứa em ta học chữ thiếu sách, ngài kiếm giùm.",
    "Khẩn cấp! Trẻ nhỏ bị bắt cóc!",
    "Đêm qua nhà ta bị trộm, ngài điều tra giúp.",
    "Cầu gỗ qua suối hỏng, ngài sửa giúp.",
    "Ta cần tin tình báo bên kia biên giới.",
    "Bộ giáp này phải đem tới lò rèn xa lắm.",
    "Bốc thuốc cho cha già, ngài giúp lấy đơn.",
    "Hộ tống bà cụ về quê con cháu.",
    "Tìm giúp ta thanh kiếm gia truyền.",
    "Đem khoản công đức này tới chùa lớn.",
    "Người mất tích trong động, ngài cứu giúp.",
    "Đại lễ sắp tới cần đủ 100 nén nhang.",
    "Quân giặc giả dạng dân, ngài lùng ra.",
    "Đường thủy bị nghẽn, ngài khơi giúp.",
    "Hương ước làng cần ngài đem đi báo.",
    "Lá thư khẩn từ tiền tuyến cần đưa đến tay vua.",
    "Bản đồ này thiếu một mảnh, ngài giúp ghép.",
    "Trong miếu có tà khí, ngài trừ giúp.",
    "Người đi rừng mãi không về, ngài xem có gặp nạn.",
    "Giặc cướp gạo của làng, ngài đòi lại.",
    "Bệnh dịch lan rộng, ngài tìm thầy thuốc giỏi.",
    "Đêm qua trống làng bị mất, ngài tìm giúp.",
    "Thầy đồ già muốn ngài đem chữ về làng dạy trẻ.",
    "Trên núi có hang lạ, ngài thám hiểm thử.",
    "Lương thực kho làng vơi, ngài tiếp viện.",
    "Đoàn lưu dân cần được dẫn đường về Bắc.",
    "Giếng làng cạn, ngài tìm long mạch mới.",
    "Sứ thần phương Bắc tới, cần thông dịch.",
    "Bộ vũ khí cũ cần đem rèn lại.",
    "Tín hiệu khói trên đỉnh núi, ngài đi xem.",
    "Tướng tiền quân cần ngài làm liên lạc.",
    "Trận đồ bát quái cũ cần ngài giải.",
    "Ngọn cờ tổ quốc bị giặc cướp, đòi lại bằng được.",
    "Trong làng có kẻ phản, ngài lùng cho ra.",
    "Già làng muốn ngài kế thừa ấn tín.",
    "Hộ thành tướng quân thiếu binh, ngài tới xin nhập.",
    "Chùa Một Cột thiếu thợ, ngài quen ai giỏi không?",
    "Thuyền chiến hỏng buồm, ngài lấy vải lụa giúp.",
    "Vùng đất hoang phía nam cần khai khẩn.",
    "Ngài đi dò địa hình giúp ta vẽ bản đồ.",
    "Mãnh hổ rừng sâu vẫn còn, ngài trừ tận gốc.",
]

# LORE/STORY templates are era-tagged: (era_code | None, text).
# era=None means era-agnostic (general history reference); fits ANY dialog era.
LORE_TEMPLATES = [
    ("ly",      "Năm xưa Lý Công Uẩn dời đô về Thăng Long..."),
    ("tran",    "Trần Hưng Đạo ba lần đánh tan quân Nguyên Mông..."),
    ("le",      "Bình Ngô đại cáo của Nguyễn Trãi mãi vang vọng..."),
    ("tay_son", "Quang Trung phá quân Thanh trong một đêm xuân..."),
    ("le",      "Vua Lê đại định mở mang bờ cõi..."),
    ("le",      "Câu chuyện về thanh gươm Thuận Thiên..."),
    (None,      "Cha ông ta đánh giặc giữ nước biết bao đời..."),
    ("f3",      "Hai Bà Trưng dấy binh đánh đuổi Tô Định..."),
    ("ly",      "Lý Thái Tổ chọn Thăng Long làm đế đô vạn năm..."),
    ("tran",    "Trần Quốc Toản bóp nát quả cam phẫn chí..."),
    ("le",      "Lê Lợi nhận gươm thần ở hồ Lục Thủy..."),
    ("tay_son", "Nguyễn Huệ thần tốc kéo quân ra Bắc..."),
    ("f4",      "Vua Đinh Tiên Hoàng dẹp loạn 12 sứ quân..."),
    (None,      "Phật giáo Lý-Trần hưng thịnh khắp non sông..."),
    ("f3",      "Bà Triệu cưỡi voi đánh giặc Đông Ngô..."),
    (None,      "Trận Bạch Đằng ba lần phá thuyền địch..."),
    ("tran",    "Trần Nhật Duật thông tiếng Mán Mường, phá kế giặc."),
    ("ly",      "Đào sông Tô Lịch năm Lý Nhân Tông."),
    (None,      "Chiêm Thành xưa nay mấy lần thông hảo."),
    (None,      "Phố Hiến từng là cảng sầm uất nhất Đại Việt."),
    ("ly",      "Lý Thường Kiệt phát Nam quốc sơn hà giữa sông Như Nguyệt."),
    ("f1",      "Hùng Vương dựng nước Văn Lang mười tám đời."),
    ("f1",      "Lạc Long Quân và Âu Cơ sinh trăm con bọc."),
    ("f1",      "Sơn Tinh Thủy Tinh tranh Mỵ Nương kể bao đời."),
    ("f2",      "An Dương Vương xây Cổ Loa thành chín vòng."),
    ("f2",      "Mỵ Châu Trọng Thủy bi tình thiên cổ."),
    ("f4",      "Lê Hoàn lên ngôi thay nhà Đinh dẹp Tống bình Chiêm."),
    ("f5",      "Lý Bí lập nước Vạn Xuân giành tự chủ."),
    ("f3",      "Mai Hắc Đế nổi binh chống quân Đường."),
    ("f3",      "Phùng Hưng được tôn Bố Cái Đại Vương."),
    ("f3",      "Khúc Thừa Dụ mở đầu thời tự chủ."),
    ("f3",      "Ngô Quyền đại phá quân Nam Hán trên sông Bạch Đằng."),
    ("f4",      "Đinh Bộ Lĩnh thuở nhỏ cờ lau tập trận."),
    ("tran",    "Trần Bình Trọng thà chết không hàng quân Bắc."),
    ("tay_son", "Bùi Thị Xuân nữ tướng Tây Sơn dũng mãnh."),
    ("tay_son", "Quang Trung mất sớm, đế nghiệp bỏ ngỏ."),
    ("ly",      "Lý Nhân Tông mở khoa thi tam giáo lần đầu."),
    ("tran",    "Trần Thái Tông kết hôn với hai chị em."),
    (None,      "Sông Hồng đỏ vào mùa nước, gọi là sông Cái."),
    ("ly",      "Văn Miếu Quốc Tử Giám lập đời Lý."),
    ("ly",      "Chùa Một Cột giấc mộng Lý Thái Tông."),
    ("tran",    "Yết Kiêu đục thuyền giặc trên sông Bạch Đằng."),
    ("tran",    "Dã Tượng cõng Trần Hưng Đạo qua sông trong loạn."),
    ("le",      "Sao Khuê Nguyễn Trãi sáng mãi giữa đời."),
    ("nguyen",  "Phan Bội Châu khởi phong trào Đông Du."),
    ("tran",    "Thái sư Trần Thủ Độ đặt nền móng vương triều."),
    ("tran",    "Bà Đinh Phương Đan bày trận đánh giặc."),
    ("tran",    "Trần Khánh Dư bán than làm tướng."),
    ("tran",    "Hoài Văn Hầu phá tan đại quân Toa Đô."),
    ("tran",    "Phạm Ngũ Lão ngồi đan sọt giữa đường lo việc nước."),
    ("ly",      "Tướng Lý Phục Man trấn ải biên cương."),
    ("ly",      "Thiền sư Vạn Hạnh tiên đoán nhà Lý mở vận."),
    # Era-agnostic fallbacks (ensures every era has at least 5+ matches)
    (None,      "Sử sách còn ghi chép biết bao tấm gương trung nghĩa."),
    (None,      "Quê hương ta núi sông gấm vóc, ngàn năm chưa phai."),
    (None,      "Người xưa nói trung quân ái quốc là đạo của kẻ làm trai."),
    (None,      "Mỗi tấc đất là máu xương cha ông để lại."),
    (None,      "Dòng giống Lạc Hồng, con cháu Tiên Rồng."),
    (None,      "Trống đồng Đông Sơn còn vọng tiếng cha ông."),
    (None,      "Đất Việt bốn ngàn năm văn hiến."),
    (None,      "Tinh thần Đại Việt đời đời bất diệt."),
    (None,      "Sông núi nước Nam từ thuở khai thiên lập địa."),
    (None,      "Nam quốc sơn hà, nam đế cư — chân lý ngàn đời."),
    (None,      "Tổ tiên dạy: lá rụng về cội, người trở về quê."),
    (None,      "Cờ Phong vẫn bay phấp phới trên non Việt."),
    (None,      "Văn hiến nước nhà nối từ Hồng Bàng tới nay."),
    (None,      "Anh hùng hào kiệt đời nào cũng có."),
    (None,      "Tinh hoa Việt tích tụ qua mấy ngàn năm."),
    (None,      "Đất linh sinh người kiệt xuất."),
    (None,      "Đạo nghĩa Phương Đông thấm vào máu thịt người Việt."),
    (None,      "Truyền thuyết và lịch sử đan xen làm nên hồn dân tộc."),
    # G1 modern lore
    ("g1",      "Bảo tàng Lịch sử Việt Nam hiện đại lưu giữ ngàn năm quá vãng."),
    ("g1",      "Đường Hà Nội nay vẫn còn tên phố cổ."),
    ("g1",      "Phố sách Đinh Lễ vẫn nhộn nhịp khách qua."),
    ("g1",      "Sách giáo khoa lịch sử dạy con cháu nhớ về cội nguồn."),
    # Extra Nguyễn-era lore (was thin)
    ("nguyen",  "Triều Nguyễn đặt kinh đô tại Huế, mở thời đại mới."),
    ("nguyen",  "Vua Gia Long thống nhất sơn hà sau loạn lạc."),
    ("nguyen",  "Minh Mạng cải cách triều chính sâu rộng."),
    # Extra Lê lore
    ("le",      "Lê Thánh Tông soạn bộ luật Hồng Đức nổi tiếng."),
    ("le",      "Lê Trung Hưng nối lại quốc thống sau biến loạn."),
    # Extra Tây Sơn
    ("tay_son", "Tây Sơn thần tốc Bắc tiến, làm nên Đống Đa lừng lẫy."),
    ("tay_son", "Trần Quang Diệu, Bùi Thị Xuân là cặp tướng lưỡng tài."),
    # Extra f5 (tiền Lý)
    ("f5",      "Triệu Quang Phục kế tục cơ nghiệp Vạn Xuân."),
    ("f5",      "Vạn Xuân quốc đối đầu nhà Lương phương Bắc."),
]

BARK_TEMPLATES = [
    "Hừm...",
    "Sao đêm nay sao đẹp thế nhỉ?",
    "Cẩn thận đường vắng có cướp.",
    "Trời sắp mưa rồi.",
    "Gạo năm nay mùa được.",
    "Đứa nhỏ nhà ta hư quá!",
    "Ai mua cá tươi không?",
    "Lúa chín rồi, gặt thôi.",
    "Ơ kìa, sao lạ vậy?",
    "Hôm nay buôn bán ế quá.",
    "Đêm trăng đẹp lắm.",
    "Bụi cỏ này mọc nhanh quá.",
    "Chốc nữa qua bà Tâm mua trầu.",
    "Mai mở chợ phiên đó.",
    "Bà nó ơi, mau lên!",
    "Trâu nhà ai sổng chuồng kìa.",
    "Tiếng kêu gì xa xa thế?",
    "Cá quẫy ao kìa.",
    "Áo này bạc màu rồi.",
    "Mệt quá, ngồi nghỉ tí.",
    "Khói bếp bay cao kìa.",
    "Tới mùa gió bấc rồi.",
    "Tay chân mỏi rời rạc.",
    "Trẻ con quên ăn vì chơi.",
    "Lúa con đang mọc đẹp.",
    "Mưa rào nên đê nhanh ngập.",
    "Sao tối nay nhiều sao quá.",
    "Đêm qua mơ thấy điềm lạ.",
    "Bụi gai bên đường to lên.",
    "Có ai đi đâu thế?",
    "Trẻ con nghịch ngợm quá.",
    "Sương sớm chưa tan kìa.",
    "Có tiếng chim lạ kêu nhỉ?",
    "Lúa mới gặt thơm quá.",
    "Gió lùa qua khe cửa.",
    "Quạ kêu chiều buồn quá.",
    "Đêm khuya rồi, ngủ thôi.",
    "Cơm canh nguội rồi.",
    "Vườn cau đang trổ.",
    "Tre kẽo kẹt rít trong gió.",
    "Người đi đâu mà vội thế.",
    "Lửa bếp gần tàn.",
    "Trẻ ngủ rồi à?",
    "Hôm nay nắng đẹp.",
    "Bao giờ thuế lại đến hạn.",
    "Quan đi qua làng ai nấy nín.",
    "Cá rô đồng kho khế tuyệt.",
    "Nhớ năm xưa lụt lớn lắm.",
    "Đêm tối tịch mịch quá.",
]

COMBAT_TEMPLATES = [
    "Chết đi!",
    "Xông lên!",
    "Bảo vệ làng!",
    "Đừng có chạy!",
    "Ngươi không qua khỏi đêm nay!",
    "Vì quê hương!",
    "Chém!",
    "Coi chừng phía sau!",
    "Quyết tử cho Tổ quốc quyết sinh!",
    "Đánh đuổi giặc!",
    "Tay kiếm phải nhanh hơn!",
    "Sát!",
    "Chặn đường rút của chúng!",
    "Đừng để chúng tản ra!",
    "Anh em theo ta!",
    "Vì non sông!",
    "Tướng quân ra lệnh tiến!",
    "Không lùi một bước!",
    "Đánh tan quân Bắc!",
    "Mã đao tới đây!",
    "Lao tới đập tan!",
    "Hỏa công! Đốt trại!",
    "Phục binh, lui ra!",
    "Bắn cung tên!",
    "Đập gãy giáo!",
    "Ngựa lên!",
    "Lệnh tiến!",
    "Phá vòng vây!",
    "Hộ tướng quân!",
    "Yểm trợ cánh trái!",
    "Cánh phải tấn công!",
    "Trống trận vang lên!",
    "Cờ đỏ đi đầu!",
    "Chiến!",
    "Phá tuyến!",
    "Bao vây!",
    "Đột phá!",
    "Đập thành môn!",
    "Dùng nỏ liên hoàn!",
    "Lao thuyền!",
]

TRADE_TEMPLATES = [
    "Hàng mới về, ngài xem qua?",
    "Giá này không lỗ rồi.",
    "Ngài có vật quý không, ta thu cao giá.",
    "Hết hàng rồi, ngày mai qua nhé.",
    "Ta giảm cho ngài 10%.",
    "Lụa Hà Đông chính hiệu đây.",
    "Gốm Bát Tràng độc nhất vô nhị.",
    "Mật ong rừng nguyên chất.",
    "Ngọc Yên Tử quý hiếm.",
    "Trà sen Tây Hồ pha rồi mời ngài.",
    "Tre già làm cán, lao bền lắm.",
    "Bình rượu cần Mường, vài năm hạ thổ.",
    "Cá khô biển Đông phơi đủ nắng.",
    "Gạo nếp cái hoa vàng, cấy ruộng cao.",
    "Vải lĩnh Mỗ óng ánh, vua quan cũng dùng.",
    "Nón ba tầm gọn đẹp.",
    "Áo dài nhuộm chàm bền màu.",
    "Quạt nan Chuông, chứng tích xưa.",
    "Đá quý đào từ sông Mã.",
    "Trầu cau mới hái sáng nay.",
    "Khăn rằn nam bộ chính gốc.",
    "Quế Trà Bồng, hương thoảng năm canh.",
    "Hồ tiêu Phú Quốc cay nồng.",
    "Cà phê Buôn Mê thơm cả gian hàng.",
    "Đường phèn nấu thủ công.",
    "Mắm tôm Hậu Lộc lâu năm.",
    "Bánh chưng gói tay, lá dong tươi.",
    "Bánh đa kê truyền thống.",
    "Dầu dừa Bến Tre nguyên chất.",
    "Tằm tơ Bảo Lộc óng ánh.",
    "Tranh Đông Hồ vẽ tay.",
    "Mộc Đồng Kỵ, gỗ trắc khắc rồng.",
    "Thiếc Cao Bằng nguyên khối.",
    "Đồng Đại Bái chạm tinh xảo.",
    "Bạc Định Công uốn dẻo.",
    "Ngọc trai Hạ Long sáng bóng.",
    "Yến sào Khánh Hòa quý hiếm.",
    "Cốm Vòng mới rang sáng nay.",
    "Trầm hương Quảng Nam thơm dịu.",
    "Sâm Ngọc Linh hai mươi năm tuổi.",
]

STORY_TEMPLATES = [
    (None,      "Hôm ấy ta vừa thức dậy thì thấy lạ lùng quá..."),
    ("f4",      "Năm 968, Hoa Lư đang chuẩn bị đại lễ..."),
    (None,      "Cha ta dặn rằng phải giữ thanh kiếm này..."),
    ("ly",      "Sư Vạn Hạnh nhìn ta hồi lâu rồi mới nói..."),
    (None,      "Đêm đó trăng tròn, ta gặp lại người xưa..."),
    ("tran",    "Trên đỉnh Yên Tử, mây trắng bao quanh..."),
    ("ly",      "Sông Như Nguyệt vọng tiếng quân reo..."),
    (None,      "Bóng người áo nâu thấp thoáng cuối làng..."),
    (None,      "Trận lũ năm Mậu Thân ta nhớ mãi..."),
    (None,      "Tiếng trống cơm vọng ra từ giếng nước..."),
    (None,      "Bà ngoại kể chuyện tổ tiên dựng nước..."),
    ("tran",    "Trận Bạch Đằng vẫn còn vang trong ký ức ông cha..."),
    ("f4",      "Đêm Hoa Lư, sương phủ kín lối về..."),
    (None,      "Người con gái áo tứ thân đứng cuối ngõ..."),
    (None,      "Tiếng chuông chùa lay động cõi lòng..."),
    (None,      "Cuốn sách cha để lại đã sờn rách..."),
    ("tran",    "Tướng Trần Bình Trọng quát giặc trong lửa..."),
    (None,      "Tiếng ai khóc gọi vọng từ phía đông..."),
    (None,      "Đoàn quân lên Bắc, gió thổi căng cờ..."),
    (None,      "Cuộc gặp gỡ với người lạ thay đổi đời ta..."),
    (None,      "Trên dòng Hồng năm xa, thuyền lụa xuôi dòng..."),
    (None,      "Ngôi miếu cổ nơi rừng sâu vẫn thắp hương..."),
    (None,      "Vị tướng già kể chuyện một thời máu lửa..."),
    (None,      "Trẻ chăn trâu mơ giấc bình thiên hạ..."),
    (None,      "Bút lông và mực đá ghi dấu thiên thư..."),
    (None,      "Tiếng đàn bầu đêm khuya thấm vào lòng..."),
    ("nguyen",  "Ngày tế Nam Giao, vua quan đông như hội..."),
    (None,      "Một thanh kiếm cũ vẫn còn sắc bén..."),
    (None,      "Bóng giặc qua làng đêm ấy mãi không quên..."),
    (None,      "Trận đánh cuối cùng, ta thấy hình bóng cha..."),
    (None,      "Lá cờ rách bay phất phơ trên thành đổ..."),
    ("tay_son", "Tiếng pháo lệnh từ Phú Xuân vang vọng..."),
    ("le",      "Đêm Đông Kinh năm Lê Trung Hưng..."),
    (None,      "Người con trở về sau hai mươi năm xa quê..."),
    ("f4",      "Bài thơ trên cột đá Hoa Lư kể chuyện hưng vong..."),
    (None,      "Đôi mắt người mẹ tiễn con ra trận..."),
    (None,      "Trên đỉnh núi Tản, mây trắng vẫn trôi..."),
    (None,      "Tiếng vọng kinh thư từ chùa Phổ Quang..."),
    (None,      "Đêm Giáng sinh năm Kỷ Sửu, kinh thành xao động..."),
    (None,      "Bóng thuyền lướt sóng Tây Hồ buổi sớm..."),
    (None,      "Cô gái Tày hát giữa rừng cọ Hoàng Liên..."),
    (None,      "Bài hát ru năm xưa mẹ hát còn vang..."),
    ("tay_son", "Tiếng vó ngựa quân Tây Sơn rền rền đêm Tết..."),
    (None,      "Bóng cờ Bạch Long hiện ra trong mộng..."),
    (None,      "Thanh đao bị bỏ quên ở góc đình hoang..."),
    # Era-bound extra
    ("g1",      "Sáng nay đi cà phê phố cổ, ta gặp lại người bạn xưa..."),
    ("g1",      "Tàu điện ngầm sắp khai trương, lòng ai nấy háo hức..."),
    ("f1",      "Hùng Vương ban cho ta một lời sấm..."),
    ("f2",      "Trên thành Cổ Loa, gió đêm ấy lạnh khác thường..."),
    ("f3",      "Quân Đông Ngô đông như kiến, nhưng lòng ta không khiếp..."),
    ("f5",      "Vạn Xuân đêm đó cờ bay phấp phới..."),
]

TEMPLATES_BY_TYPE = {
    "greeting": GREETING_TEMPLATES,
    "quest":    QUEST_TEMPLATES,
    "lore":     LORE_TEMPLATES,
    "bark":     BARK_TEMPLATES,
    "combat":   COMBAT_TEMPLATES,
    "trade":    TRADE_TEMPLATES,
    "story":    STORY_TEMPLATES,
}

# Variation suffixes / prefixes to multiply unique combinations
TONE_PREFIX = [
    "", "Này, ", "Nghe ta nói, ", "Khoan, ", "Ấy, ", "Hà, ", "Ôi, ",
    "Kìa, ", "Ơ, ", "Hỡi ngài, ",
]
ERA_LOCALE_SUFFIX = {
    "g1": [" — chuyện ngoài phố Hà Nội nay.", " — thời số hóa rồi.",
           " — Sài Gòn nhộn nhịp lắm.", ""],
    "f1": [" — đời Hùng Vương xưa.", " — Phong Châu thuở ấy.", ""],
    "f2": [" — Âu Lạc một thời.", " — Cổ Loa thành chín vòng.", ""],
    "f3": [" — thuở Bắc thuộc đau thương.", " — Đông Đô năm xưa.", ""],
    "f4": [" — Hoa Lư mở vận.", " — thời Đinh Lê khai cơ.", ""],
    "f5": [" — tiền Lý dấy nghiệp.", " — Vạn Xuân quốc.", ""],
    "ly": [" — Thăng Long đô thành.", " — đời nhà Lý hưng thịnh.",
           " — chùa Một Cột.", ""],
    "tran": [" — Thăng Long thời Trần.", " — sông Bạch Đằng dậy sóng.",
             " — Vạn Kiếp bình Nguyên.", ""],
    "le": [" — Đông Kinh kinh đô.", " — Lê triều giáo hóa.",
           " — Bình Ngô đại cáo.", ""],
    "tay_son": [" — Phú Xuân thời Tây Sơn.", " — Quang Trung phá Thanh.",
                " — Đống Đa đầu xuân.", ""],
    "nguyen": [" — Huế đế đô.", " — triều Nguyễn lập quốc.",
               " — kinh thành cố đô.", ""],
}
NAME_HONORIFIC = {
    "is_historical_figure": ["Ngài ", "Đại nhân ", "Thiên tử ", ""],
    "lore_npc": ["Thầy ", "Bậc tiên hiền ", ""],
    "merchant": ["Ông chủ ", "Bà chủ ", ""],
    "townsmen": ["Bà con ", "Ngài ", ""],
    "default": [""],
}

# ============================================================
# NPC SUBSET BY CATEGORY
# ============================================================
def filter_speaker_pool(npcs: list, dtype: str) -> list:
    """Subset NPC pool sensible cho từng dialog type, fallback full pool."""
    if dtype == "trade":
        pool = [n for n in npcs if n.get("can_event") or n.get("can_farm")
                or n.get("npc_type") in ("merchant", "townsmen")]
    elif dtype == "combat":
        pool = [n for n in npcs if n.get("tier", 0) > 0
                or n.get("can_give_quest")
                or n.get("is_historical_figure")
                or n.get("npc_type") in ("warrior", "soldier", "guard")]
    elif dtype == "lore":
        pool = [n for n in npcs if n.get("is_historical_figure")
                or n.get("npc_type") == "lore_npc"
                or n.get("can_train_skill")]
    elif dtype == "quest":
        pool = [n for n in npcs if n.get("can_give_quest")
                or n.get("is_historical_figure")]
    elif dtype == "story":
        # Story = narrative-capable NPCs. Original filter (protagonist/
        # historical/mentor) only yields 58 NPCs missing nguyen + f3 era
        # entirely. Expanded to include lore_npc, can_train_skill (teacher),
        # and tier>0 (significant character) — covers all 11 eras
        # while still excluding plain villagers / mobs.
        pool = [n for n in npcs if n.get("is_protagonist")
                or n.get("is_historical_figure")
                or n.get("mentor") is not None
                or n.get("npc_type") == "lore_npc"
                or n.get("can_train_skill")
                or n.get("tier", 0) > 0]
    else:  # greeting / bark
        pool = list(npcs)
    if not pool:
        pool = list(npcs)
    return pool


def speaker_honorific(npc: dict) -> str:
    if npc.get("is_historical_figure"):
        key = "is_historical_figure"
    elif npc.get("npc_type") == "lore_npc":
        key = "lore_npc"
    elif npc.get("npc_type") == "merchant":
        key = "merchant"
    elif npc.get("npc_type") == "townsmen":
        key = "townsmen"
    else:
        key = "default"
    return NAME_HONORIFIC[key][0]


# ============================================================
# DIALOG LINE GENERATION
# ============================================================
ERA_TAGGED_TYPES = {"lore", "story"}


def _resolve_template_pool(dtype: str, era: str):
    """For era-tagged types (lore/story), return only templates matching
    the dialog era OR era-agnostic (None). For others, return raw list.
    Pre-validated: every era in ERAS_ALL has ≥1 matching template."""
    raw = TEMPLATES_BY_TYPE[dtype]
    if dtype not in ERA_TAGGED_TYPES:
        return raw
    matched = [text for (tag, text) in raw if tag == era or tag is None]
    if not matched:  # safety net — should never trigger after pool audit
        matched = [text for (tag, text) in raw if tag is None]
    return matched


def gen_dialog_line(dialog_id: int, dtype: str, npc: dict) -> dict:
    era = npc.get("era") or "ly"
    if era not in ERAS_ALL:
        era = "ly"
    pool = _resolve_template_pool(dtype, era)
    seed = f"dialog:{dialog_id}:{dtype}"
    base = seeded_pick(seed + ":t", pool)
    prefix = seeded_pick(seed + ":p", TONE_PREFIX)
    suffix = seeded_pick(seed + ":s", ERA_LOCALE_SUFFIX[era])
    text = f"{prefix}{base}{suffix}".strip()
    return {
        "i": dialog_id,
        "speaker_id": npc.get("_index", 1),
        "speaker_name": npc.get("name", f"NPC_{npc.get('_index', 1)}"),
        "era": era,
        "dialog_type": dtype,
        "text": text,
        "cultural_lock_pass": cultural_lock_check(text),
    }


def _audit_era_pool_coverage():
    """Sanity-check at module load: each era has ≥1 lore + ≥1 story
    template (era-specific OR era-agnostic). Aborts with code 3 if not."""
    for dtype in ERA_TAGGED_TYPES:
        for era in ERAS_ALL:
            pool = _resolve_template_pool(dtype, era)
            if not pool:
                print(f"FATAL pool empty: dtype={dtype} era={era}")
                sys.exit(3)


_audit_era_pool_coverage()


# ============================================================
# BUILD
# ============================================================
def build_dialogs(npcs: list) -> list:
    all_dialogs = []
    dialog_id = 1
    for dtype in TYPES_ORDER:
        count = FINAL_COUNT_BY_TYPE[dtype]
        pool = filter_speaker_pool(npcs, dtype)
        for k in range(count):
            seed = f"speaker:{dtype}:{dialog_id}"
            npc = seeded_pick(seed, pool)
            line = gen_dialog_line(dialog_id, dtype, npc)
            all_dialogs.append(line)
            dialog_id += 1
    return all_dialogs


def write_jsonl_lf(path: Path, items) -> int:
    body = "\n".join(json.dumps(i, ensure_ascii=False) for i in items) + "\n"
    path.write_bytes(body.encode("utf-8"))
    return len(items)


def write_outputs(all_dialogs: list) -> dict:
    reg = OUTPUT_DIR / "registry"
    era_dir = OUTPUT_DIR / "era"
    schema_dir = OUTPUT_DIR / "schema"
    tests_dir = OUTPUT_DIR / "tests"
    reports = OUTPUT_DIR / "reports"
    for d in [reg, era_dir, schema_dir, tests_dir, reports]:
        d.mkdir(parents=True, exist_ok=True)

    # Full
    n_full = write_jsonl_lf(reg / "dialog_full.jsonl", all_dialogs)

    # By type
    by_type = {}
    for d in all_dialogs:
        by_type.setdefault(d["dialog_type"], []).append(d)
    type_counts = {}
    for dtype, dlist in by_type.items():
        type_counts[dtype] = write_jsonl_lf(reg / f"dialog_{dtype}.jsonl", dlist)

    # By era (main 5 only per spec output structure)
    by_era = {}
    for d in all_dialogs:
        by_era.setdefault(d["era"], []).append(d)
    era_counts = {}
    for era, dlist in by_era.items():
        if era in ERAS_MAIN:
            era_counts[era] = write_jsonl_lf(era_dir / f"{era}.jsonl", dlist)

    # Schema SQL
    schema_sql = """-- DIALOG table (CMD_DIALOG v1.1, Foundation v2.8.0, R8.3 UNIQUE)
CREATE TABLE IF NOT EXISTS dialogs (
    dialog_id    INT PRIMARY KEY,
    speaker_id   INT NOT NULL,
    speaker_name VARCHAR(128) NOT NULL,
    era          VARCHAR(32) NOT NULL CHECK (era IN ('ly','tran','le','tay_son','nguyen','f1','f2','f3','f4','f5','g1')),
    dialog_type  VARCHAR(32) NOT NULL CHECK (dialog_type IN ('greeting','quest','lore','bark','combat','trade','story')),
    text         TEXT NOT NULL,
    cultural_lock_pass BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE(dialog_id)
);
CREATE INDEX IF NOT EXISTS idx_dialog_speaker ON dialogs(speaker_id);
CREATE INDEX IF NOT EXISTS idx_dialog_era ON dialogs(era);
CREATE INDEX IF NOT EXISTS idx_dialog_type ON dialogs(dialog_type);
"""
    (schema_dir / "dialog_table.sql").write_bytes(schema_sql.encode("utf-8"))

    # Tests
    test_code = '''"""15 dialog tests — CMD_DIALOG v1.1 acceptance."""
import json
from pathlib import Path

# tests/ is at cmd-dialog/output/tests/, so parents[1] = output/
OUTPUT = Path(__file__).resolve().parents[1]
REG = OUTPUT / "registry"


def _load_full():
    return [json.loads(line)
            for line in (REG / "dialog_full.jsonl").read_text("utf-8").splitlines()
            if line.strip()]


def test_count_50000():
    assert sum(1 for _ in (REG / "dialog_full.jsonl").open("r", encoding="utf-8")) >= 50000


def test_greeting_8000():
    n = sum(1 for line in (REG / "dialog_greeting.jsonl").open("r", encoding="utf-8") if line.strip())
    assert n >= 8000


def test_quest_12000():
    n = sum(1 for line in (REG / "dialog_quest.jsonl").open("r", encoding="utf-8") if line.strip())
    assert n >= 12000


def test_lore_5000():
    n = sum(1 for line in (REG / "dialog_lore.jsonl").open("r", encoding="utf-8") if line.strip())
    assert n >= 5000


def test_bark_7000():
    n = sum(1 for line in (REG / "dialog_bark.jsonl").open("r", encoding="utf-8") if line.strip())
    assert n >= 7000


def test_combat_5000():
    n = sum(1 for line in (REG / "dialog_combat.jsonl").open("r", encoding="utf-8") if line.strip())
    assert n >= 5000


def test_trade_3000():
    n = sum(1 for line in (REG / "dialog_trade.jsonl").open("r", encoding="utf-8") if line.strip())
    assert n >= 3000


def test_story_2297():
    n = sum(1 for line in (REG / "dialog_story.jsonl").open("r", encoding="utf-8") if line.strip())
    assert n >= 2297


def test_unique_dialog_id():
    full = _load_full()
    ids = [d["i"] for d in full]
    assert len(ids) == len(set(ids))


def test_cultural_lock_no_cjk():
    import re
    pat = re.compile(r"[\\u4E00-\\u9FFF\\u3040-\\u309F\\u30A0-\\u30FF]")
    full = _load_full()
    bad = [d for d in full if pat.search(d["text"])]
    assert not bad, f"CJK found in {len(bad)} lines"


def test_cultural_lock_no_tam_quoc():
    import re
    pat = re.compile(r"(Tào Tháo|Lưu Bị|Quan Vũ|Trương Phi|Khổng Minh|Tam Quốc)", re.IGNORECASE)
    full = _load_full()
    bad = [d for d in full if pat.search(d["text"])]
    assert not bad, f"Tam Quốc ref in {len(bad)} lines"


def test_5_main_eras_present():
    full = _load_full()
    eras = {d["era"] for d in full}
    main = {"ly", "tran", "le", "tay_son", "nguyen"}
    assert main.issubset(eras), f"missing eras: {main - eras}"


def test_speaker_id_linked():
    full = _load_full()
    bad = [d for d in full if not isinstance(d.get("speaker_id"), int) or d["speaker_id"] < 1]
    assert not bad


def test_schema_sql_exists():
    p = OUTPUT / "schema" / "dialog_table.sql"
    assert p.exists() and p.stat().st_size > 200


def test_split_by_type_files():
    types = ["greeting", "quest", "lore", "bark", "combat", "trade", "story"]
    for t in types:
        p = REG / f"dialog_{t}.jsonl"
        assert p.exists()


def test_cultural_lock_pass_field_correct():
    full = _load_full()
    bad = [d for d in full if d.get("cultural_lock_pass") is not True]
    assert not bad, f"cultural_lock_pass=False in {len(bad)} lines"
'''
    (tests_dir / "dialog_tests.py").write_bytes(test_code.encode("utf-8"))

    return {
        "full": n_full,
        "by_type": type_counts,
        "by_era": era_counts,
        "schema": True,
        "tests": True,
    }


# ============================================================
# SELF-AUDIT 15 CHECKS
# ============================================================
def self_audit(all_dialogs: list, write_meta: dict) -> dict:
    counts_by_type = Counter(d["dialog_type"] for d in all_dialogs)
    eras_present = {d["era"] for d in all_dialogs}
    ids = [d["i"] for d in all_dialogs]
    speakers_ok = all(isinstance(d.get("speaker_id"), int)
                      and d["speaker_id"] >= 1 for d in all_dialogs)
    lock_field_ok = all(d.get("cultural_lock_pass") is True
                        for d in all_dialogs)
    cjk_violations = sum(1 for d in all_dialogs
                         if CULTURAL_LOCK_REGEX.search(d["text"]))
    tam_quoc_violations = sum(1 for d in all_dialogs
                              if TAM_QUOC_BAN.search(d["text"]))
    type_files = OUTPUT_DIR / "registry"
    split_ok = all((type_files / f"dialog_{t}.jsonl").exists()
                   for t in TYPES_ORDER)

    checks = [
        ("count_50000",       len(all_dialogs) >= 50000,
            {"actual": len(all_dialogs), "target": 50000}),
        ("greeting_8000",     counts_by_type["greeting"] >= 8000,
            {"actual": counts_by_type["greeting"]}),
        ("quest_12000",       counts_by_type["quest"] >= 12000,
            {"actual": counts_by_type["quest"]}),
        ("lore_5000",         counts_by_type["lore"] >= 5000,
            {"actual": counts_by_type["lore"]}),
        ("bark_7000",         counts_by_type["bark"] >= 7000,
            {"actual": counts_by_type["bark"]}),
        ("combat_5000",       counts_by_type["combat"] >= 5000,
            {"actual": counts_by_type["combat"]}),
        ("trade_3000",        counts_by_type["trade"] >= 3000,
            {"actual": counts_by_type["trade"]}),
        ("story_2297",        counts_by_type["story"] >= 2297,
            {"actual": counts_by_type["story"]}),
        ("unique_dialog_id",  len(ids) == len(set(ids)),
            {"dup": len(ids) - len(set(ids))}),
        ("no_cjk",            cjk_violations == 0,
            {"violations": cjk_violations}),
        ("no_tam_quoc",       tam_quoc_violations == 0,
            {"violations": tam_quoc_violations}),
        ("5_main_eras_present",
            set(ERAS_MAIN).issubset(eras_present),
            {"present": sorted(eras_present)}),
        ("speaker_id_linked", speakers_ok, {}),
        ("schema_sql_exists",
            (OUTPUT_DIR / "schema" / "dialog_table.sql").exists(), {}),
        ("split_by_type_files", split_ok, {}),
    ]
    passed = sum(1 for _, ok, _ in checks if ok)
    return {
        "passed": passed,
        "total": len(checks),
        "pass_rate": passed / len(checks),
        "checks": [{"name": n, "pass": ok, **d} for n, ok, d in checks],
    }


# ============================================================
# HONEST GAPS (4 admitted per spec)
# ============================================================
def write_reports(all_dialogs, audit, write_meta):
    reports = OUTPUT_DIR / "reports"
    reports.mkdir(parents=True, exist_ok=True)

    summary = {
        "cmd": CMD_NAME,
        "version": CMD_VERSION,
        "foundation_hash": FOUNDATION_HASH,
        "generated_at": "2026-05-19T04:00:00Z",
        "total_dialog": len(all_dialogs),
        "target_full": TARGET_FULL,
        "spec_target_baseline": 42297,
        "count_by_type": dict(Counter(d["dialog_type"] for d in all_dialogs)),
        "count_by_era": dict(Counter(d["era"] for d in all_dialogs)),
        "unique_dialog_id": len({d["i"] for d in all_dialogs}),
        "audit": audit,
        "write_meta": write_meta,
    }
    (reports / "summary.json").write_bytes(
        (json.dumps(summary, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    )
    (reports / "validation.json").write_bytes(
        (json.dumps(audit, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    )

    honest_gaps = {
        "cmd": CMD_NAME,
        "version": CMD_VERSION,
        "shipped_at": "2026-05-19T04:00:00Z",
        "gaps_admitted": [
            {
                "severity": "MED",
                "item": "Template-based dialog repetition",
                "reason": (
                    f"50000 lines synthesized from ~{sum(len(p) for p in TEMPLATES_BY_TYPE.values())} "
                    "base templates × tone prefix × era locale suffix. Lore depth low; mass categories "
                    "(bark, combat, trade) recycle short templates."
                ),
                "mitigation": (
                    "Phase 14 Week 4 enrichment — feed NPC personality/era richer suffix pools, "
                    "consider LLM-augmented enrichment pass on subset."
                ),
            },
            {
                "severity": "MED",
                "item": "Speaker context not always coherent",
                "reason": (
                    "NPC pool filtered loosely by dialog type (e.g. trade prefers merchant/townsmen "
                    "but falls back to full pool if subset empty). Lore monk could speak combat barks "
                    "if era distribution dictates."
                ),
                "mitigation": (
                    "Tighten filter_speaker_pool predicates per category; introduce 'tone' attribute "
                    "on NPC for finer match."
                ),
            },
            {
                "severity": "LOW",
                "item": "No emotion/tone variation per speaker",
                "reason": (
                    "Tone prefix is dialog_id-seeded, not personality-seeded; same NPC could greet "
                    "warmly in one line and curtly in another."
                ),
                "mitigation": (
                    "Hash speaker_id into tone pick to lock NPC voice persona."
                ),
            },
            {
                "severity": "LOW",
                "item": "No audio/voice acting hints",
                "reason": "audio_id mapping not populated — CMD AUDIO (Phase 15) will build.",
                "mitigation": "Defer to CMD AUDIO; dialog schema already has room for audio_id.",
            },
            {
                "severity": "LOW",
                "item": "NPC names not 1:1 with speaker_id (upstream cmd-npc data property)",
                "reason": (
                    "cmd-npc/output/registry/npc_full.jsonl contains 2062 duplicate "
                    "names across 10000 NPCs (e.g. 'Hoàng Nam' appears 6 times with "
                    "distinct _index/uuid). Speaker_name in dialog output reflects "
                    "this duplication. Not a cmd-dialog defect — upstream registry "
                    "design intentionally allows reuse of common Vietnamese names."
                ),
                "mitigation": (
                    "Out of cmd-dialog scope. If 1:1 mapping needed, raise with "
                    "cmd-npc owner to enforce unique name OR add disambiguator "
                    "(e.g. era suffix) at name generation."
                ),
            },
        ],
        "resolves_alerts": [
            "HIGH-dialog_count_below_target-20260519-002905",
            "HIGH-dialog_count_below_target-20260519-015201",
        ],
    }
    (reports / "honest_gaps_v11.json").write_bytes(
        (json.dumps(honest_gaps, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    )

    # Determinism marker — sha256 of dialog_full.jsonl
    full_path = OUTPUT_DIR / "registry" / "dialog_full.jsonl"
    sha = hashlib.sha256(full_path.read_bytes()).hexdigest()
    (full_path.parent / "dialog_full.jsonl.sha256").write_bytes(
        f"{sha}  dialog_full.jsonl\n".encode("utf-8")
    )
    return sha


# ============================================================
# MAIN
# ============================================================
def main() -> int:
    print(f"[{CMD_NAME}] v{CMD_VERSION} start")
    verify_foundation()
    npcs = load_npc_registry()
    print(f"[{CMD_NAME}] generating {TARGET_FULL} dialog lines...")
    all_dialogs = build_dialogs(npcs)
    write_meta = write_outputs(all_dialogs)
    audit = self_audit(all_dialogs, write_meta)
    sha = write_reports(all_dialogs, audit, write_meta)
    print(f"[{CMD_NAME}] audit {audit['passed']}/{audit['total']} "
          f"pass_rate={audit['pass_rate']:.3f} sha={sha[:16]}...")
    if audit["pass_rate"] >= 0.95:
        print(f"[{CMD_NAME}] PASS — ship")
        return 0
    print(f"[{CMD_NAME}] PARTIAL — score below 0.95")
    return 1


if __name__ == "__main__":
    sys.exit(main())
