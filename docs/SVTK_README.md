# 📚 SVTK FINAL v2.8.0 — README

> Package version: 2.8.0
> Date: 2026-05-18
> Foundation hash: `2e6e8c23d8455d9b964744486be11f0a88684113c1cbc6eb77ec371dc266e467`

---

## 🎯 Quick start

```
1. Giải nén SVTK_FINAL_v2.8.0_complete.zip
2. Đọc SVTK_ROADMAP.md (overview 5 phase)
3. Đọc SVTK_OPERATION_PHASE1.md (kickoff hôm nay)
4. Push toàn bộ lên GitHub repo: github.com/Trinhlong1988/svtk-status
5. Mở 4 tab Claude Code paste 4 CMD đầu Phase 1
6. CMD5 LEAD tự giám sát, anh check dashboard mỗi sáng
```

---

## 📦 53 files trong package

### 📜 Foundation (1 file)
- `SVTK_FOUNDATION_v2.8.0.md` — Hiến pháp + 83 rules (R72-R83 mới)

### 📋 Documents (6 file)
- `SVTK_ROADMAP.md` — Master roadmap 5 phase × 8 tuần
- `SVTK_OPERATION_PHASE1.md` — Backend (DB, ENGINE)
- `SVTK_OPERATION_PHASE2.md` — World (NPC, MAP)
- `SVTK_OPERATION_PHASE3.md` — Logic (SKILL, CHAR, QUEST)
- `SVTK_OPERATION_PHASE4.md` — Content (ITEM, BOSS, DIALOG, EVENT)
- `SVTK_OPERATION_PHASE5.md` — Art + QA + Launch
- `README.md` — File này

### ⚙️ CMD prompts (21 file)

**LEAD (1):**
- `CMD5_LEAD_v2.1.md` — Orchestrator 7-phase cycle

**Team Core (4):**
- `CMD_DB_v2.4.2_patch.md` — PostgreSQL schema
- `CMD_ENGINE_v1.0.md` — Combat + CHAR + damage formula
- `CMD_PLACE_v1.0.md` — World coordinate
- `CMD_PROMPT_v6_STRICT_VERIFIED.md` — PARSE TS Online binary

**Team Content (8):**
- `CMD_NPC_v1.1.md`, `CMD_SKILL_v1.0.md`, `CMD_ITEM_v1.1.md`
- `CMD_BOSS_v1.0.md`, `CMD_QUEST_v1.1.md`, `CMD_MAP_v1.1.md`
- `CMD_DIALOG_v1.1.md`, `CMD_EVENT_v1.0.md`

**Team Art (3):**
- `CMD_SPRITE_v1.0.md`, `CMD_ICON_v1.0.md`, `CMD_AUDIO_v1.0.md`

**Team QA (4):**
- `CMD_QA_CONTENT_v1.0.md`, `CMD_QA_ART_v1.0.md`
- `CMD_QA_CORE_v1.0.md`, `CMD_QA_FULL_v1.0.md`

**Ship prompts (1):**
- `PROMPT_TROLY_SHIP_AB.md` — CMD trợ lý ship existing registry

### 🐍 Scripts (15 file)

**Pipeline:**
- `svtk_pipeline.py` — R71 LOAD+FIX+EXTEND (NPC+SKILL)

**Audit (4):**
- `comprehensive_audit.py` — 466 rules audit
- `audit_decisive_all.py` — Check no question patterns
- `audit_v280_strict.py` — 632 rules deep audit 10 round

**Tests (11):**
- `test_decisive_50.py`, `test_pipeline_50.py`
- `test_anti_dupe.py`, `test_npc_map_allocation.py`
- `test_npc_full_system.py`, `test_char_damage.py`
- `test_lead_protocol.py`, `test_bidirectional.py`
- `test_qa_protocol.py`, `test_team_dependency.py`
- `test_prompt_troly_v2.py`

### 📊 Data (4 file)

```
cmd-npc/existing/NPC_438.jsonl       (438 NPC từ phase trước)
cmd-npc/existing/gaps_v1.txt         (120 era gap)
cmd-skill/existing/SKILL_165.jsonl   (165 skill từ phase trước)
cmd-npc/output/registry/npc_full.jsonl     (10000 NPC sau pipeline)
cmd-skill/output/registry/skill_full.jsonl (306 skill sau pipeline)
```

### 🔐 Hash index (1 file)
- `INDEX.sha256` — SHA256 của tất cả file

---

## 🚦 Verify status

```
audit_v280_strict (10 round):     6,320/6,320 = 100% ✅
test_decisive_50:                 3,150/3,150 = 100% ✅
test_pipeline_50:                 2,250/2,250 = 100% ✅
comprehensive_audit:                466/466   = 100% ✅
─────────────────────────────────────────────────────
TỔNG verify cumulative:          12,186/12,186 = 100%
```

---

## 🎯 SVTK targets (TẤT CẢ > TS Online)

| Mảng | TSO | SVTK target | Status |
|---|---|---|---|
| NPC | 7,817 | 10,000 | ✅ ready |
| SKILL | 200 | 300 | ✅ ready |
| ITEM | 1,000 | 1,500 | ⏳ Phase 4 |
| BOSS | 922 | 1,200 | ⏳ Phase 4 |
| QUEST | 2,262 | 3,000 | ⏳ Phase 3 |
| DIALOG | 42,297 | 50,000 | ⏳ Phase 4 |
| EVENT | 425 | 600 | ⏳ Phase 4 |
| MAP | 7,047 | 8,500 | ⏳ Phase 2 |
| SCRIPT | 3,835 | 5,000 | ✅ legacy |

---

## 🎭 Identity SVTK (lock)

```
PROTAGONIST:  Trần Long
ORIGIN:       Bảo tàng Hà Nội 2026
TIMELINE:     Xuyên không → Hoa Lư 968 (era Lý)
MENTOR:       Sư Vạn Hạnh
JOURNEY:      5 era chính (Lý/Trần/Lê/Tây Sơn/Nguyễn) + F1-F5 + G1
CULTURAL:     100% Việt sử, KHÔNG copy Tam Quốc, KHÔNG CJK chars
ELEMENTS:     6 hệ VSTK (kim/mộc/thủy/hỏa/thổ + Tâm)
```

---

## 📞 Vận hành — quy tắc tối cao

```
✓ CMD5 LEAD orchestrate, KHÔNG sản xuất
✓ 16 worker CMD execute autonomous
✓ 4 QA CMD verify continuous
✓ Anh CHỈ check dashboard mỗi sáng
✗ KHÔNG hỏi 1/2/3 a/b/c/d
✗ KHÔNG offer phương án
✗ KHÔNG quyết hộ worker
```

---

## ⚠️ Limitation HONEST

```
✓ Tests MOCK LOCAL pass 100%
✗ Chưa Claude Code runtime thực
✗ Package chưa push GitHub (chỉ anh push được)
✗ Roadmap 8 tuần là estimate
```

---

## 🚀 Anh bắt đầu

```bash
# 1. Tải zip về máy
# 2. Giải nén
unzip SVTK_FINAL_v2.8.0_complete.zip -d svtk-status/

# 3. Push GitHub
cd svtk-status
git init
git add .
git commit -m "SVTK Foundation v2.8.0 + 21 CMD + pipelines"
git remote add origin https://github.com/Trinhlong1988/svtk-status
git push origin main

# 4. Mở Claude Code → đọc SVTK_OPERATION_PHASE1.md → paste 4 CMD
```
