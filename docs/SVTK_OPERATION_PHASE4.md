# 🚀 SVTK OPERATION PHASE 4 — CONTENT FILL

> Sau GATE 3 PASS → kickoff PHASE 4 (ITEM + BOSS + DIALOG + EVENT)

---

## 📋 Mục tiêu PHASE 4

```
TARGET:
  ITEM   ≥ 1500 (TSO 1000)
  BOSS   ≥ 1200 (TSO 922)
  DIALOG ≥ 50000 (TSO 42297)
  EVENT  ≥ 600 (TSO 425)
```

---

## 🏗️ Vận hành 2 Team + CMD5

```
Tab 1 — CMD5 LEAD              (chạy nền)
Tab 2 — Team A: CMD_ITEM       (1500 item, anti-dupe UUID)
        + CMD_BOSS              (1200 boss, tier 6-9)
Tab 3 — Team B: CMD_DIALOG     (50000 dialog)
        + CMD_EVENT             (600 event)
Tab 4 — 4 QA CMD               (cross-verify)
```

---

## 🔄 Pipelines PHASE 4

### Team A workflow

**CMD_ITEM** (4-5 ngày):
```
1. Load existing 200 item (Việt sử lore: Chiếu Dời Đô, Hịch Tướng Sĩ, etc.)
2. Anti-dupe R74:
   - item_uuid per instance
   - transaction_log (pickup/drop/trade/store)
   - 2PC khi transfer
   - Anti-dupe heartbeat 30s scan
3. Extend 200 → 1500:
   - Weapon: 400
   - Armor: 300
   - Accessory: 200
   - Consumable: 300
   - Material: 200
   - Quest item: 100
4. Save: cmd-item/output/registry/item_full.jsonl
```

**CMD_BOSS** (3-4 ngày, sau ITEM):
```
1. Load existing 13 boss
2. Extend 13 → 1200:
   - tier 6 (boss):    600
   - tier 7 (boss):    300
   - tier 8 (thánh):   200
   - tier 9 (thần):    100
3. Drop_item_ids: link với ITEM 1500
4. Stat 11 field × class hierarchy multi (dmg_dealt 1.0-3.0)
5. Save: cmd-boss/output/registry/boss_full.jsonl
```

### Team B workflow

**CMD_DIALOG** (5-6 ngày):
```
1. Load existing dialog từ TS Online decode (42297 i_index unique)
2. Việt hóa 100% (no CJK, no Tam Quốc reference)
3. Link với:
   - npc_id (NPC nào nói)
   - quest_id (quest nào trigger)
   - era_lore (5 era + F + G)
4. Extend 42297 → 50000:
   - Daily dialog: 30000
   - Quest dialog: 15000
   - Event dialog: 5000
5. Save: cmd-dialog/output/registry/dialog_full.jsonl
```

**CMD_EVENT** (2-3 ngày):
```
1. 425 → 600 event
2. Event types:
   - Daily: 200
   - Weekly: 100
   - Festival (era-themed): 100
   - PvP tournament: 50
   - Raid event: 100
   - Drop boost: 50
3. Schedule per event
4. Reward distribution rules
5. Save: cmd-event/output/registry/event_full.jsonl
```

---

## 🚦 GATE 4 — KIỂM SOÁT

```
✓ Item UUID unique per instance
✓ Anti-dupe scenario verified (50 mock dupe attempts blocked)
✓ Boss drop → Item link verified (no orphan drop_item_id)
✓ Dialog → NPC link verified (no orphan npc_id)
✓ Quest dialog complete chain (giao → progress → complete)
✓ Event schedule không conflict
✓ Cultural lock 100% pass
```

---

## ⏱️ Thời gian dự kiến

```
Team A (ITEM + BOSS):  8-9 ngày
Team B (DIALOG + EVENT): 8-9 ngày (song song)
QA verify cross:        3-4 ngày
─────────────────────
TỔNG PHASE 4: 10-12 ngày
```
