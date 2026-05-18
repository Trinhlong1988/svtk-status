# 🚀 SVTK OPERATION PHASE 3 — LOGIC ACTIVATE

> Sau GATE 2 PASS → kickoff PHASE 3 (SKILL + CHAR + QUEST)

---

## 📋 Mục tiêu PHASE 3

```
TARGET:
  SKILL count ≥ 300 (TSO 200)
  QUEST count ≥ 3000 (TSO 2262)
  CHAR system: 5 class × stat scaling 1-120 verified
  Damage formula: char đánh boss → output đúng formula
  Element wheel: 5 ngũ hành + Tâm áp dụng correctly
```

---

## 🏗️ Vận hành 2 Team + CMD5

```
Tab 1 — CMD5 LEAD            (chạy nền)
Tab 2 — Team A: CMD_SKILL    (R71: 165 → 306)
Tab 3 — Team B: CMD_QUEST    (R71: 588 → 3000)
Tab 4 — CMD_QA_CONTENT       (verify schema + cross-ref)
Tab 5 — CMD_QA_CORE          (verify CHAR damage + element wheel)
```

---

## 🔄 Pipelines PHASE 3

### Team A — CMD_SKILL

```
1. Load existing: cmd-skill/existing/SKILL_165.jsonl
2. Detect tier gaps: tier 1/5/6/8 = 0
3. Fix: fill_skill_tier_gaps() → 165 → 300+
4. Apply cost_sp formula: 10×(1+tier×0.2) + power×0.5
5. Element distribution: 50 skill/hệ × 6 hệ = 300
6. Save: cmd-skill/output/registry/skill_full.jsonl
```

### Team B — CMD_QUEST

```
1. Load existing: cmd-quest/existing/QUEST_588.jsonl
2. Anti-dupe R74:
   - quest_instance_uuid per player
   - quest_template_id giữ original
   - reward_claimed flag (anti-replay)
3. 6 type quest:
   - Main:   1000 (TSO 259)
   - Side:   500  (TSO 142)
   - Lore:   300  (TSO 88)
   - Event:  100  (TSO 28)
   - Raid:   200  (TSO 50)
   - Reborn: 50   (TSO 21)
   - + chuỗi quest extend → 3000
4. Cross-ref: quest_giver_npc_id, target_boss_id, target_item_ids
5. Save: cmd-quest/output/registry/quest_full.jsonl
```

### CHAR system (đã trong CMD_ENGINE)

```
KHÔNG cần CMD riêng. Đã có:
- CHAR_SCHEMA (11 stat + class + equipment)
- 5 class: warrior/mage/ranger/priest/assassin
- compute_char_stats(level, class) — verify scaling 1-120
- Damage formula: normal/skill/PvP
- Element wheel áp dụng trong calculate_element_modifier
- NPC class hierarchy 6 mức (regular → thần)
```

QA Core verify: bot chơi 30 phút → log damage output → check match formula.

---

## 🚦 GATE 3 — KIỂM SOÁT

```
✓ SKILL ≥ 300, đủ 10 tier × 6 hệ
✓ QUEST ≥ 3000, đủ 6 type
✓ Quest instance UUID unique per player
✓ Reward anti-replay verified
✓ Char level 1-120 stat scaling correct
✓ Damage formula:
  - Normal attack: ATK × variance - DEF × 0.5
  - Skill: (INT/ATK + power) × variance - resist × 0.6
  - PvP: × 0.6 reduction
  - Element strong/weak: ×1.5 / ×0.5
  - NPC class taken: regular 1.0 → thần 0.3
  - Crit × 2
✓ Bot QA chơi 30 phút không crash
```

---

## ⏱️ Thời gian dự kiến

```
Team A SKILL:     2-3 ngày
Team B QUEST:     4-5 ngày
QA verify:        2 ngày
CHAR test bot:    1 ngày
─────────────────────
TỔNG PHASE 3: 5-7 ngày
```
