# 🗺️ SVTK ROADMAP — Vận hành 2 Team Work + CMD5 LEAD

> Version: 1.0 — 2026-05-18
> Foundation: v2.8.0 hash `2e6e8c23d8455d9b964744486be11f0a88684113c1cbc6eb77ec371dc266e467`

---

## 🎯 NGUYÊN TẮC ƯU TIÊN

```
1. BACKEND TRƯỚC — không có DB + ENGINE thì NPC/MAP không persist
2. WORLD SAU — NPC + MAP build world skeleton
3. LOGIC TIẾP — CHAR + SKILL + damage formula activate gameplay
4. CONTENT SAU — QUEST + ITEM + DIALOG fill story
5. QA CHẠY SONG SONG — 4 QA monitor liên tục từ phase 1
```

---

## 📋 5 PHASE ROADMAP

### PHASE 1 — BACKEND CORE (Tuần 1-2)

**Mục tiêu:** DB schema + ENGINE combat engine sẵn sàng.

| Order | CMD | Output | Critical |
|---|---|---|---|
| 1 | **CMD_DB** | PostgreSQL schema (npc/skill/char/item/quest/boss/map/dialog/event) | ✅ blocker |
| 2 | **CMD_ENGINE** | Combat engine + damage formula + element wheel + char class | ✅ blocker |
| 3 | **CMD_PLACE** | World coordinate + region + faction | high |

**Exit criteria Phase 1:**
- DB schema deploy được local PostgreSQL
- ENGINE damage formula test 3000/3000 pass
- CHAR + element wheel verified

### PHASE 2 — WORLD SKELETON (Tuần 2-3)

**Mục tiêu:** NPC + MAP đầy đủ + NPC allocated to MAP.

| Order | CMD | Output |
|---|---|---|
| 4 | **CMD_NPC** | 10000 NPC (tier 0-9, 10 type, 6 hệ) — R71 pipeline |
| 5 | **CMD_MAP** | 8500 map (10 biome, density per biome) |
| 6 | **NPC→MAP allocation** | Verify orphan/overcrowd via R75 formula |

**Exit criteria Phase 2:**
- NPC count ≥ 10000 (TSO 7817)
- MAP count ≥ 8500 (TSO 7047)
- 0 orphan sceneId, 0 overcrowd

### PHASE 3 — LOGIC ACTIVATE (Tuần 3-4)

**Mục tiêu:** SKILL + CHAR + QUEST hoạt động end-to-end.

| Order | CMD | Output |
|---|---|---|
| 7 | **CMD_SKILL** | 306 skill (6 hệ, 10 tier, cost_sp formula) |
| 8 | **CHAR system** | 5 class + stat scaling 1-120 (đã trong ENGINE) |
| 9 | **CMD_QUEST** | 3000 quest (6 type: Main/Side/Lore/Event/Raid/Reborn) |

**Exit criteria Phase 3:**
- Char đánh thường + skill ra damage đúng formula
- Quest instance per player UUID (anti-dupe R74)
- Element wheel áp dụng correctly

### PHASE 4 — CONTENT FILL (Tuần 4-6)

**Mục tiêu:** ITEM, BOSS, DIALOG, EVENT đầy đủ.

| Order | CMD | Output |
|---|---|---|
| 10 | **CMD_ITEM** | 1500 item (anti-dupe UUID + 2PC) |
| 11 | **CMD_BOSS** | 1200 boss (tier 6-9 + class hierarchy) |
| 12 | **CMD_DIALOG** | 50000 dialog |
| 13 | **CMD_EVENT** | 600 event |

### PHASE 5 — ART + QA + LAUNCH (Tuần 6-8)

| Order | CMD | Output |
|---|---|---|
| 14 | **CMD_SPRITE** | 158 sprite template × recolor cho 10000 NPC |
| 15 | **CMD_ICON** | Icon items |
| 16 | **CMD_AUDIO** | BGM + SFX |
| 17 | **4 QA CMD** | Full E2E test |

---

## 🏗️ VẬN HÀNH 2 TEAM PARALLEL + CMD5 GIÁM SÁT

### Đội hình mỗi phase

```
                    ┌──────────────────────┐
                    │   CMD5 LEAD (giám sát)│
                    │   Poll alerts mỗi 5m  │
                    │   Process completion  │
                    └──────────────────────┘
                       /                 \
            ┌──────────▼──────┐  ┌────────▼───────┐
            │   TEAM A        │  │   TEAM B       │
            │   (Backend)     │  │   (World)      │
            └─────────────────┘  └────────────────┘
                                       │
                              ┌────────▼──────┐
                              │  4 QA CMD     │
                              │  monitor + verify
                              └───────────────┘
```

### PHASE 1: BACKEND

| Team | CMD | Vai trò |
|---|---|---|
| **Team A** | CMD_DB | Build schema PostgreSQL |
| **Team B** | CMD_ENGINE | Build combat engine + damage formula |
| **Giám sát** | CMD5_LEAD | Poll alerts, verify completion |
| **QA** | CMD_QA_CORE | Verify schema + damage formula |

### PHASE 2: WORLD

| Team | CMD | Vai trò |
|---|---|---|
| **Team A** | CMD_NPC | Build 10000 NPC (R71 pipeline) |
| **Team B** | CMD_MAP | Build 8500 map (biome density) |
| **Giám sát** | CMD5_LEAD | Verify NPC→MAP allocation |
| **QA** | CMD_QA_CONTENT | Verify cultural lock + count |

### PHASE 3: LOGIC

| Team | CMD | Vai trò |
|---|---|---|
| **Team A** | CMD_SKILL | 306 skill + 6 hệ + tier formula |
| **Team B** | CMD_QUEST | 3000 quest + chuỗi quest |
| **Giám sát** | CMD5_LEAD | Verify cross-ref NPC↔QUEST |
| **QA** | CMD_QA_CONTENT + CMD_QA_CORE | Verify schema + dependency |

### PHASE 4: CONTENT

| Team | CMD | Vai trò |
|---|---|---|
| **Team A** | CMD_ITEM + CMD_BOSS | 1500 item + 1200 boss |
| **Team B** | CMD_DIALOG + CMD_EVENT | 50000 dialog + 600 event |
| **QA** | 4 QA | Run cross verify |

### PHASE 5: LAUNCH

| Team | CMD | Vai trò |
|---|---|---|
| **Team A** | CMD_SPRITE | Sprite + recolor |
| **Team B** | CMD_ICON + CMD_AUDIO | Icon + audio |
| **QA** | CMD_QA_FULL | End-to-end test bot |

---

## ⏱️ TIMELINE

```
Week 1-2:  Phase 1 — Backend
Week 2-3:  Phase 2 — World
Week 3-4:  Phase 3 — Logic
Week 4-6:  Phase 4 — Content
Week 6-8:  Phase 5 — Art + QA
─────────────────────────────
Total: 8 tuần, ship 4 sprint × 2 tuần
```

---

## 🚦 STATE GATES — KHÔNG CHO QUA NẾU CHƯA PASS

```
GATE 1 (sau Phase 1):  DB schema deploy OK + ENGINE damage 3000/3000 PASS
GATE 2 (sau Phase 2):  10000 NPC ≥ TSO, 0 orphan map allocation
GATE 3 (sau Phase 3):  Player char đánh boss → damage formula đúng FACT
GATE 4 (sau Phase 4):  Quest full chuỗi (NPC giao → boss kill → reward)
GATE 5 (sau Phase 5):  Bot QA chơi tour 1h KHÔNG crash
```

---

## 📞 ALERT PROTOCOL (CMD5 oversight)

```
Worker phát hiện gap → push HIGH alert lên cmd-lead/alerts/
CMD5 verify trong 5 phút urgent / 1h normal
CMD5 assign fix → cmd-{worker}/inbox/
Worker apply fix → push completion về cmd-lead/completions/
QA verify → push verdict PASS/FAIL/NEED_REVIEW
LEAD update dashboard (cmd-lead/dashboard.json)
```

---

## 🎯 KHỞI ĐỘNG PHASE 1 (KICKOFF)

```bash
# Anh paste theo thứ tự:
1. CMD5_LEAD_v2.1.md           (chạy nền)
2. CMD_DB_v2.4.2_patch.md      (Team A — Backend)
3. CMD_ENGINE_v1.0.md          (Team B — Combat engine)
4. CMD_QA_CORE_v1.0.md         (QA giám sát Phase 1)

Sau khi GATE 1 PASS → Phase 2 kickoff.
```
