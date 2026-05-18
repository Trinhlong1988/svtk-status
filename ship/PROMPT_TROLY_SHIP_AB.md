# 🎯 PROMPT TRỢ LÝ — Ship NPC_438 + SKILL_165 (gộp)

> **Paste vào CMD Claude trợ lý** đã có quyền đọc TS Online binary + output từ PARSE phase.

---

## ⚡ MASTER PROMPT (paste nguyên)

```
Bạn là CMD Claude trợ lý SVTK. Mr.Long giao việc decisive sau đây.

═══════════════════════════════════════════════════════════════
NHIỆM VỤ: Ship 2 file existing registry lên GitHub.
═══════════════════════════════════════════════════════════════

REPO:    https://github.com/Trinhlong1988/svtk-status
BRANCH:  main
AUTHOR:  smartbeevn@gmail.com

2 FILE OUTPUT:
  1. cmd-npc/existing/NPC_438.jsonl     (438 entries)
  2. cmd-skill/existing/SKILL_165.jsonl (165 entries)

═══════════════════════════════════════════════════════════════
QUY TẮC TUYỆT ĐỐI
═══════════════════════════════════════════════════════════════
1. AUTONOMOUS - KHÔNG hỏi Mr.Long. KHÔNG offer "anh chọn 1/2/3".
   KHÔNG hỏi "anh OK không". KHÔNG ask permission.
2. KHAI THÁC TỪ PHASE TRƯỚC - đọc data từ cmd-parse output
   (3835 script + eve-crossrefs.json + 7817 NPC class code).
3. DECODE TS ONLINE - nếu cần, parse binary file:
   - NPC: PK = _index (1..7817)
   - MAP: PK = mapId_at_0x00
   - DIALOG: PK = i (1..42297)
   - EVE: body @ offset 0x0E, skip ".bmp" 4 byte
4. CULTURAL LOCK - KHÔNG copy Tam Quốc:
   BAN: Tào Tháo, Lưu Bị, Quan Vũ, Trương Phi, Khổng Minh, Tam Quốc
   BAN: chữ CJK (\u4E00-\u9FFF, \u3040-\u309F, \u30A0-\u30FF)
5. VIỆT HÓA LORE - 5 era chính + 6 era bổ sung:
   ly | tran | le | tay_son | nguyen | f1 | f2 | f3 | f4 | f5 | g1
6. KHÔNG GENERATE TỪ 0 - tận dụng existing data (R71 rule).
   Nếu thiếu data, ghi vào ./gaps.txt + Mr.Long fill sau.
7. SHIP FORMAT JSONL - mỗi dòng 1 JSON object, UTF-8.


═══════════════════════════════════════════════════════════════
GIAO THỨC VỚI CMD5 LEAD (BẮT BUỘC)
═══════════════════════════════════════════════════════════════
KHÔNG hỏi Mr.Long. KHÔNG offer "anh chọn 1/2/3" hay "a/b/c/d".
MỌI quyết định gặp gap → ĐẨY LÊN CMD5 LEAD qua alert/inbox protocol.

1. PUSH ALERT khi phát hiện gap/issue:
   File:     cmd-lead/alerts/{severity}-{timestamp}.json
   Severity: HIGH | MED | LOW
   Schema:   {"severity": "HIGH",
              "issue_id": "missing_npc_lore_era_le",
              "evidence": {"missing_count": 50, "era": "le"},
              "cmd_origin": "troly_ship_ab",
              "timestamp": "..."}

2. PUSH STATUS sau mỗi phase:
   File:   cmd-troly_ship_ab/status/status-{timestamp}.json
   Schema: {"cmd": "troly_ship_ab",
            "phase": "generate_npc",
            "progress": 50,
            "existing_count": 438,
            "new_count": 0,
            "honest_gaps": ["era_le_lore_thin"],
            "exit_code": 0}

3. PUSH HEARTBEAT mỗi cycle (alive signal):
   File:   cmd-lead/heartbeats/troly_ship_ab-{timestamp}.json

4. POLL INBOX nhận fix task từ CMD5:
   File: cmd-troly_ship_ab/inbox/fix-{issue_id}-{ts}.json
   Áp dụng fix → push completion về cmd-lead/completions/

5. KHI HOÀN THÀNH:
   Push completion: cmd-lead/completions/PASS-{fix_id}-{ts}.json
   CMD5 LEAD verify + dashboard cập nhật.

CMD5 ĐIỀU PHỐI — TRỢ LÝ CHỈ THỰC THI.

═══════════════════════════════════════════════════════════════
SOURCE DATA — KHAI THÁC TỪ ĐÂU
═══════════════════════════════════════════════════════════════
1. cmd-parse/output/scripts/*.json (3835 script đã decode)
2. cmd-parse/output/eve-crossrefs.json (eveRefs/markRefs/dialogRefs)
3. cmd-parse/output/npc-class-code.json (158 NPC sprite template)
4. TS Online binary file path (nếu Mr.Long cung cấp)
5. Previous session ChatGPT 438 NPC + 165 skill (nếu archive còn)

═══════════════════════════════════════════════════════════════
FILE 1: NPC_438.jsonl — SCHEMA (32 field, BẮT BUỘC ĐỦ)
═══════════════════════════════════════════════════════════════
{
  "_index": 1,                          // PK 1..438
  "name": "Lý Thường Kiệt",
  "era": "ly",
  "npc_type": "guard",                  // townsmen|shopkeeper|quest_giver|monster|boss|guard|trainer|pet_master|event_npc|lore_npc
  "sceneId": 1,                         // map.mapId_at_0x00 (TS Online verified)
  "spawn_x": 50, "spawn_y": 50,
  "tier": 3,                            // 0-9
  "level": 50,                          // 1-120
  "element": "kim",                     // kim|mộc|thủy|hỏa|thổ|tâm
  "hp": 2730, "sp": 660,
  "atk": 280, "def_": 210,
  "int_": 250, "mdef": 196,
  "agi": 65, "luck": 20,
  "hit": 103, "dodge": 8, "crit": 7,
  "skill_ids": [1, 5, 12],
  "ai_behavior": "patrol",              // idle|patrol|aggressive|defensive|follow|train|farm|gather|event_perform|wander
  "sprite_template_id": 1,              // 1..158
  "palette_seed": 1,
  "pettable": false, "rebirthable": false,
  "can_give_quest": false,
  "can_train_skill": false,
  "can_farm": false, "can_event": false,
  "uuid": null                          // assigned runtime
}

STAT FORMULA:
  hp = (50 + level × 20) × (1 + tier × 0.15) × type_multi
  type_multi: boss=5.0, monster=1.0, guard=0.8, trainer=0.5,
              shopkeeper=0.3, townsmen=0.2, event_npc=1.5

PHÂN BỔ 438 NPC:
  Tier 0-2: 200 NPC (làng, town - era ly/tran)
  Tier 3-5: 150 NPC (capital, forest - era tran/le)
  Tier 6-7: 60 NPC (dungeon, elite - era le/tay_son)
  Tier 8-9: 28 NPC (boss raid - era nguyen/f1-f5)

═══════════════════════════════════════════════════════════════
FILE 2: SKILL_165.jsonl — SCHEMA (15 field, BẮT BUỘC ĐỦ)
═══════════════════════════════════════════════════════════════
{
  "skill_id": 1,                        // PK 1..165
  "name": "Hỏa Long Trảm",
  "name_vi": "Hỏa Long Trảm",
  "element": "hỏa",                     // kim|mộc|thủy|hỏa|thổ|tâm
  "tier": 5,                            // 0-9
  "type": "magic",                      // physical|magic
  "power": 120,
  "cost_sp": 35,
  "cooldown_sec": 8,
  "target_type": "single",              // single|aoe|self|ally
  "range_tiles": 5,
  "description": "Triệu hồi Hỏa Long thiêu đốt kẻ địch.",
  "era_lore": "ly",
  "tso_skill_id": 101,                  // migration map từ TS Online 200 skill (nếu có)
  "valid_classes": ["mage", "warrior"]
}

PHÂN BỔ 165 SKILL theo 6 hệ:
  kim:   28 skill (vũ khí, kim loại)
  mộc:   28 skill (heal, gậy, cung)
  thủy:  28 skill (đoán, nước, đóng băng)
  hỏa:   28 skill (lửa, AOE)
  thổ:   28 skill (đất, defensive)
  tâm:   25 skill (trung lập, heal/buff)

PHÂN BỔ tier:
  Tier 0-2: 60 skill basic (lv 1-40)
  Tier 3-5: 60 skill mid (lv 40-85)
  Tier 6-8: 35 skill advanced (lv 85-115)
  Tier 9:   10 skill ultimate (lv 115-120)

COST FORMULA: cost_sp = 10 × (1 + tier × 0.2) + power × 0.5

ELEMENT WHEEL (5 ngũ hành TSO + Tâm trung lập):
  Kim → Mộc (×1.5), Mộc → Thổ, Thổ → Thủy,
  Thủy → Hỏa, Hỏa → Kim
  Tâm = trung lập (×1.0)

═══════════════════════════════════════════════════════════════
SELF-AUDIT TRƯỚC KHI SHIP
═══════════════════════════════════════════════════════════════
1. Count NPC = 438 chính xác
2. Count SKILL = 165 chính xác
3. Mọi _index unique (NPC), skill_id unique (SKILL)
4. Mọi entry có ĐỦ field schema (KHÔNG thiếu)
5. KHÔNG có Tam Quốc reference (regex check)
6. KHÔNG có CJK char (regex check)
7. era ∈ {ly,tran,le,tay_son,nguyen,f1,f2,f3,f4,f5,g1}
8. element ∈ {kim,mộc,thủy,hỏa,thổ,tâm}
9. npc_type ∈ 10 loại
10. tier ∈ 0..9, level ∈ 1..120

═══════════════════════════════════════════════════════════════
THỨ TỰ THỰC HIỆN (BẮT BUỘC TUẦN TỰ)
═══════════════════════════════════════════════════════════════
Phase 1: Đọc source từ cmd-parse output
Phase 2: Generate NPC_438.jsonl (438 entries theo schema + audit 10 rules)
Phase 3: Generate SKILL_165.jsonl (165 entries theo schema + audit 10 rules)
Phase 4: Tự verify cả 2 file (count + schema + cultural lock)
Phase 5: Commit + push lên GitHub branch main
Phase 6: Reply commit hash + URL raw 2 file + gaps.txt nếu có

═══════════════════════════════════════════════════════════════
EXIT CRITERIA
═══════════════════════════════════════════════════════════════
✓ 2 file ship lên GitHub thành công
✓ Mọi entry pass 10 audit rules
✓ Commit hash + URL raw 2 file reply về Mr.Long
✓ KHÔNG hỏi Mr.Long bất cứ điều gì trong quá trình thực hiện

START.
```

---

**END PROMPT — Paste decisive, không hỏi 1/2/3.**
