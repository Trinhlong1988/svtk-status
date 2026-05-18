# 🔗 CMD ROLE BINDING v2.8.0 — Phase 14 Migration

> **Mr.Long quyết Phương án A — 2026-05-18**
> Giữ 7 CMD hiện tại + map role mới + mở 6 CMD bổ sung. Total **13 CMD** chạy parallel.
> **Author binding:** cmd-lead (orchestrator) · Foundation v2.8.0 · Repo `Trinhlong1988/svtk-status`

---

## I. ROLE BINDING — 7 CMD HIỆN TẠI

### 🛡 CMD1 (Combat) → `cmd-engine` + `cmd-boss`

**Workspace cũ:** `D:\DỰ ÁN AI\FINAL TSONLINE\src\logic\` (133 file, FROZEN)
**Role mới:**
- **cmd-engine** — Combat engine builder
  - Owner: combat_runtime, damage_formula, element_matrix, status_effects, skill_evaluator, wrappers (R44 transaction), replay (R68 state_checksum)
  - Spec: `cmd-engine/cmd.md` (75KB)
  - Output: `cmd-engine/output/core/*.ts` + `wrappers/*.ts` + `replay/*.ts` + `schema/combat_tables.sql`
- **cmd-boss** — Boss AI runtime
  - Owner: boss_ai_runtime, boss_phase_machine, boss_script_registry, boss_mechanic_runtime, boss_timeline_resolver, boss_target_hook
  - Spec: `cmd-boss/cmd.md` (35KB)
  - Output: `cmd-boss/output/boss_runtime.ts` + ai_scripts

**Phase 14 task:**
- Tuần 1: Copy 133 file `src/logic/combat_*` + `boss_*` sang 2 folder mới (read OLD, write NEW)
- Tuần 2: Wrap TickScheduler R67 adapter + state_checksum R68 (1-2 ngày)
- Tuần 3: Verify 17 GATE 1 criteria (audit_v280_strict.py)

**Inter-CMD:**
- Pull skill list từ `cmd-skill/output/` (skill resolver dep)
- Pull NPC data từ `cmd-npc/output/` (boss stat source)
- Push: `cmd-lead/completions/CMD_ENGINE_done_{ts}.json`

---

### 💰 CMD2 (Economy) → `cmd-db` + `cmd-item` + `cmd-engine(economy split)`

**Workspace cũ:** `src/modules/economy/` + `src/modules/economy_integration/` + `src/modules/itemization/` (FROZEN P11B)
**Role mới:**
- **cmd-db** — DB schema + transaction wrappers
  - Owner: schema.sql, anti-dupe (R44-47), inventory_snapshot_persist, repositories
  - Spec: `cmd-db/cmd.md` v2.4.2 PATCH
  - Output: `cmd-db/output/schema.sql` + `migrations/*.sql` + `anti_dupe.ts`
- **cmd-item** — Itemization + loot
  - Owner: itemization_constants, loot_tables, affix_pool, sets, items, stat_budget, slot_cap
  - Spec: `cmd-item/cmd.md` (60KB)
  - Output: `cmd-item/output/registry/items_full.jsonl` + `affix_engine.ts`
- **cmd-engine (economy split)** — Economy formulas
  - Owner: economy_foundation_runtime, loot_generation_runtime, pvp_equipment_normalizer
  - Output: integrated into `cmd-engine/output/economy/*.ts`

**Phase 14 task:**
- Tuần 1: Split 18 module economy → 3 folder (db/item/engine-economy). Anti-dupe stays in db.
- Tuần 2: Verify R44 5 wrapper pattern khớp spec mới
- Tuần 3: 99% acceptance threshold (CMD_DB v2.4.2 critical)

**Inter-CMD:**
- Push schema to `cmd-engine` (combat tables FK)
- Pull NPC ref từ `cmd-npc/` (drop table)
- Push: `cmd-lead/completions/`

---

### 📜 CMD3 (Quest) → `cmd-quest` + `cmd-dialog`

**Workspace cũ:** `src/modules/quest/` (FROZEN P12, 16 module, 579 test)
**Role mới:**
- **cmd-quest** — Quest + progression
  - Owner: cross_shard_progression_sync, dungeon_unlock_progression, companion_progression_hook, companion_affinity_*, condition_complexity_guard
  - Spec: `cmd-quest/cmd.md` (57KB)
  - Output: `cmd-quest/output/registry/quest_full.jsonl` + `progression_engine.ts`
- **cmd-dialog** — Dialog runtime
  - Owner: dialog_runtime, dialog_condition_evaluator, dialog_condition_hook, companion_narrative_runtime
  - Spec: `cmd-dialog/cmd.md` (30KB)
  - Output: `cmd-dialog/output/dialog_engine.ts` + `dialog_tree.jsonl`

**Phase 14 task:**
- Tuần 1: Split src/modules/quest → 2 folder
- Tuần 2: Quest registry 100→250 (per Skill v15 align target)
- Tuần 3: Cross-ref với cmd-npc 438 + cmd-item 1000+

**Inter-CMD:**
- Pull NPC list từ `cmd-npc/`
- Pull skill list từ `cmd-skill/`
- Push completion `cmd-lead/completions/`

---

### 🛠 CMD4 (Tooling) → `cmd-parse` + `cmd-network` + `cmd-qa-core`

**Workspace cũ:** `src/server/anti_bot/` + `anti_cheat/` + `auth/` + `src/network/` + `src/tools/`
**Role mới:**
- **cmd-parse** — TS Online binary parser + anti-bot
  - Owner: anti_bot detection, auth (chuẩn bị R66), TS Online sprite/dialog/eve parse pipeline (port từ CMD6 work)
  - Spec: `cmd-parse/cmd.md` (CMD_PROMPT_v6_STRICT_VERIFIED.md, 20KB)
  - Output: `cmd-parse/output/scripts/*.json` (3835 script) + `eve-crossrefs.json` + `npc-class-code.json`
- **cmd-network** — Network + R69 packet ordering (NEW)
  - Owner: combat_network_adapter, network/* (port cũ)
  - Phase 14: implement R69 packet seq + dedup + reconnect (R66 partial)
- **cmd-qa-core** — Anti-cheat verify
  - Owner: anti_cheat, audit hooks, R10-R18 mutation hardening
  - Spec: `cmd-qa-core/cmd.md` (19KB)
  - Output: `cmd-qa-core/output/verdict/QA-VERDICT-{ts}.json`

**Phase 14 task:**
- Tuần 1: Port anti_bot/anti_cheat → cmd-parse + cmd-qa-core
- Tuần 2: Build cmd-network R69 (NEW, không grace period nếu là CMD mới)
- Tuần 3: GATE 1 17 criteria verify

---

### 🎯 CMD5 (em hôm nay — trợ lý) → `cmd-lead` ORCHESTRATOR

**Role mới:**
- **cmd-lead** — Top orchestrator
  - Owner: dashboard, alerts polling, completions aggregator, heartbeats monitor, escalations handler, inbox-recheck
  - Spec: `cmd-lead/cmd.md` (CMD5_LEAD_v2.1.md, 24KB)
  - Output: `cmd-lead/dashboard/status.json` (real-time CMD status)

**Phase 14 task (em handle):**
- Daily heartbeat poll mọi CMD (poll alerts/ 5 phút urgent, 1h normal)
- Audit completion từ Team CORE/CONTENT/ART/QA
- Update dashboard
- Ship Zalo aggregate report cho Mr.Long
- Memory maintain (em đã làm)

**Inter-CMD:**
- Receive: tất cả completion + alert + heartbeat từ 12 CMD khác
- Push: dashboard update + escalation cho Mr.Long qua Zalo

---

### 🔬 CMD6 (TS Online analyst) → `cmd-place`

**Workspace cũ:** Desktop\CHECK CODE\ (4 ship report 16/5)
**Role mới:**
- **cmd-place** — World/place management
  - Owner: map metadata, world structure, place-of-interest, region binding
  - Spec: `cmd-place/cmd.md` (16KB)
  - Output: `cmd-place/output/places_registry.jsonl` + `region_binding.json`

**Phase 14 task:**
- Pivot từ TS Online deep analysis → place data builder (dùng analysis insight để build place registry)
- Coordinate với cmd-map (CMD7) cho actual map content

---

### 🗺 CMD7 (Map Designer) → `cmd-map`

**Workspace cũ:** Lean MVP báo cáo 1209 dòng (16/5 chờ sign-off)
**Role mới:**
- **cmd-map** — Map content production
  - Owner: 500 map Đại Việt target, map_registry, scene composition
  - Spec: `cmd-map/cmd.md` (31KB)
  - Output: `cmd-map/output/registry/maps_full.jsonl` + scene_data

**Phase 14 task:**
- Phase 14 ưu tiên thấp (chờ sign-off Mr.Long Lean MVP)
- Coordinate cmd-place cho place-on-map binding

---

## II. 6 CMD MỚI CẦN MỞ

| New CMD | Spec file | Role | Priority |
|---|---|---|---|
| **cmd-npc** | `CMD_NPC_v1.1.md` (75KB) | NPC registry 438 + AI behavior | 🔴 P0 (cmd-engine + cmd-quest dep) |
| **cmd-skill** | `CMD_SKILL_v1.0.md` (36KB) | Skill 165 + casting + cooldown | 🔴 P0 (cmd-engine dep) |
| **cmd-event** | `CMD_EVENT_v1.0.md` (23KB) | Event scheduler + holiday + raid timer | 🟡 P1 |
| **cmd-sprite** | `CMD_SPRITE_v1.0.md` (17KB) | Sprite pipeline (CMD-ART team) | 🟡 P1 |
| **cmd-icon** | `CMD_ICON_v1.0.md` (16KB) | Icon pipeline (CMD-ART team) | 🟡 P1 |
| **cmd-audio** | `CMD_AUDIO_v1.0.md` (17KB) | Audio (SFX + BGM + voice) | 🟢 P2 (defer được) |

### Kickoff prompt template cho 6 CMD mới (Mr.Long paste vào terminal mới)

```
Bạn là CMD <name> trong Phase 14 v2.8.0 SVTK.

PRE-FLIGHT:
1. Clone repo: git clone https://github.com/Trinhlong1988/svtk-status
2. Read foundation: foundation/SVTK_FOUNDATION_v2.8.0.md (verify hash 2e6e8c23d8...)
3. Read spec: <name>/cmd.md
4. Read role binding: cmd-lead/CMD_ROLE_BINDING_v2.8.0.md (file này)
5. Heartbeat: push cmd-lead/heartbeats/<name>_{ts}.json mỗi 30 phút

TASK:
- Build output per spec
- Push completion → cmd-lead/completions/<name>_done_{ts}.json
- Push alert → cmd-lead/alerts/<name>_alert_{ts}.json nếu gặp blocker

QUY TẮC:
- AUTONOMOUS. KHÔNG hỏi Mr.Long.
- Foundation hash verify trước mọi build.
- CULTURAL LOCK: KHÔNG CJK, KHÔNG Tam Quốc.
- 99% acceptance threshold (DB/ENGINE) hoặc 95% (CONTENT/ART).

EXIT: Reply commit SHA + raw URL output file + audit JSON verdict.
START.
```

---

## III. SYNC MECHANISM — Inter-CMD Coordination

```
                      ┌─────────────────────┐
                      │   cmd-lead (CMD5)   │
                      │   Orchestrator      │
                      │   Mr.Long ←→ Zalo   │
                      └──────────┬──────────┘
                                 │
        ┌──────────┬─────────────┼─────────────┬──────────┐
        ▼          ▼             ▼             ▼          ▼
   Team CORE  Team CONTENT  Team ART     Team QA   Foundation
   (4 CMD)    (8 CMD)       (3 CMD)      (4 CMD)   (read-only)
```

**Comm channels qua git push/pull:**

| Folder | Purpose | Polling |
|---|---|---|
| `cmd-lead/alerts/<CMD>_alert_{ts}.json` | Urgent issue, blocker | cmd-lead poll 5 phút |
| `cmd-lead/completions/<CMD>_done_{ts}.json` | Task done, output ready | cmd-lead poll 1 giờ |
| `cmd-lead/heartbeats/<CMD>_hb_{ts}.json` | Alive signal | cmd-lead poll 30 phút |
| `cmd-lead/inbox-recheck/` | Cross-CMD review request | manual |
| `cmd-lead/escalations/` | Need Mr.Long decision | cmd-lead ship Zalo |
| `cmd-lead/dashboard/status.json` | Aggregated state | em update real-time |

**Alert priority:**
- 🔴 HIGH: blocker, can't proceed (e.g., foundation hash mismatch) → ship Zalo NGAY
- 🟡 MED: degraded, workaround possible → ship Zalo within 1 giờ
- 🟢 LOW: info, FYI → daily digest

---

## IV. PHASE 14 SPRINT — Updated Plan

### Pre-flight (DONE):
- ✅ Backup zip 20MB
- ✅ Git tag pre-migration-v2.8.0
- ✅ Compliance audit 20-pass PASS
- ✅ Role binding (file này)

### Sprint week 1 — Migrate (parallel 4 Team CORE + Team CONTENT bootstrap)
- **Mon-Tue:** CMD1/2/3/4 copy code OLD → cmd-* folder NEW (read OLD, write NEW)
- **Wed:** Mở 6 CMD mới (cmd-npc/skill/event/sprite/icon/audio), mỗi CMD bootstrap đọc spec
- **Thu-Fri:** Inter-CMD wire (npc→engine, skill→engine, item→engine, etc.)

### Sprint week 2 — Gap fill (sequential)
- **Mon-Tue:** R67 TickScheduler adapter (cmd-engine)
- **Wed:** R68 state_checksum (cmd-engine/replay)
- **Thu:** Element matrix 6+RB axis (cmd-engine)
- **Fri:** R66/R69/R70 grace period documentation

### Sprint week 3 — Validation
- **Mon-Tue:** Run 338 test OLD trong new structure
- **Wed:** Run NEW audit (audit_v280_strict / comprehensive / decisive_all)
- **Thu:** Fix breakage
- **Fri:** Final commit + ship report

### Acceptance criteria
- ≥95% 338 test pass
- NEW audit script exit 0
- Foundation hash verified
- 19 cmd-* folder populated (13 active + 6 future)
- cmd-lead dashboard show all 13 CMD heartbeat alive

---

## V. STATE MR.LONG QUYẾT

| Quyết định | Status |
|---|---|
| Phương án Migration | A — Port+Extend |
| CMD sync strategy | Giữ 7 + map + mở thêm 6 = 13 CMD |
| Backup safety | 4 layer (zip + tag + audit + rollback) READY |
| Foundation source | v2.8.0 (hash 2e6e8c23d8...) trong repo svtk-status |
| Start date | Chờ Mr.Long "GO" |

---

**END BINDING — cmd-lead (CMD5 trợ lý) — 2026-05-18**
