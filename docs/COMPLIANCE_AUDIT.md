# 📋 COMPLIANCE MATRIX — OLD vs NEW v2.8.0

> **Date:** 2026-05-18 · **Author:** Trợ lý (read-only audit, KHÔNG sửa code OLD)
> **Backup:** `D:\BACKUP_FINAL_TSONLINE_20260518.zip` (20MB, SHA256 4064719187E557BFB5A3A088C7115C7DA74AAF3C37C8866F60DB40EFB107F0BB)
> **Git anchor:** Tag `pre-migration-v2.8.0` trên `D:\DỰ ÁN AI\FINAL TSONLINE\` HEAD `ad3633f`

---

## I. RULE COMPATIBILITY MATRIX (R1-R70)

**Discovery:** OLD R1-R33 và NEW R1-R70 là **SAME LINEAGE** (không phải 2 framework khác). Bằng chứng: `CMD_ENGINE_v1.0.md` cite R1/R4/R5/R8/R30/R31 (gameplay R1-R33) + R44/R45/R46/R47/R67/R68/R70 (NEW additions) trong CÙNG 1 spec.

| Era | Rules | Version | OLD code? | NEW required? | Migration |
|---|---|---|---|---|---|
| Gameplay | R1-R33 | v1.0 (OLD spec/01_MASTER_LOCK.md) | ✅ Full FROZEN | ✅ Unchanged | 🟢 Keep |
| Integrity | R34-R43 | v2.2 | 🟡 Partial (audit hooks) | ✅ | Verify tuần 2 |
| Transaction | R44-R47 | v2.3 | ✅ Anti-dupe extensive | ✅ | 🟢 Match |
| CMD authoring | R48-R49 | v2.3.2 | ❌ N/A | ✅ | Setup tuần 1 |
| Runtime platform | R50-R56 | v2.4 | 🟡 DB conn + migrations | ✅ | Verify tuần 2 |
| MMO Runtime | R57-R65 | v2.5 | 🟡 Network/journal partial | ✅ | Audit tuần 2 |
| Runtime correctness | R66-R70 | v2.6 | ❌ Missing | 🟡 **GRACE PERIOD** | Tuần 2 add adapter |

### Critical detail — Grace period (Foundation v2.8.0 line 24):
> *"CMD đã ship (DB v2.4.2, ENGINE v1.0 nếu có) vẫn chạy. CMD AUTH/NETWORK/SHARD mới BẮT BUỘC tuân R66-R70."*

→ CMD1/2/3 FROZEN code KHÔNG cần R66-R70 ngay. Chỉ NEW CMD (cmd-auth/cmd-network/cmd-shard) cần implement R66-R70 from scratch.

### Spot-check content conflict — R23 (OLD) vs R67 (NEW)
| | R23 OLD | R67 NEW |
|---|---|---|
| Scope | WHAT (interval values) | HOW (clock implementation) |
| Content | Combat 100ms / AI 200ms / DOT 500ms / Regen 1s | monotonic_ns + server tick stamp + anti-cheat |
| Relationship | Complementary | R67 enforces R23 |

→ **NO CONFLICT.** R67 là foundation kỹ thuật cho R23 hoạt động enforce-able.

---

## II. DATA COMPLIANCE (9/9 file)

| File | R compliance | Notes |
|---|---|---|
| `element_wheel.json` | ✅ R30/R31 (BP scale, INT). R19 TÂM nerf 8000 BP | 5 ngũ hành + TÂM. Khớp gameplay model 6-element |
| `npc_constants.json` | ✅ R30/R31. R10 threat resist per tier | Tier scale match Boss tier system |
| `skill_constants.json` | ✅ R30/R31. R23 turn_delay_ms=1200 (decoded from TS Online) | Phase 3 spec compliant |
| `status_constants.json` | ✅ R30/R31. DR levels for hard CC/soft CC/DOT | R13 chain CC DR khớp |
| `threat_constants.json` | ✅ R10 exact match: Damage 100%/Heal 70%/Taunt 500%/Guard 200%/Summon 40% | Phase 4 |
| `itemization_constants.json` | ✅ R30/R31. Modifier recursion guard depth=8 | CMD2 Phase 11 FROZEN |
| `economy_constants.json` | ✅ Locked by Mr.Long 14/5. Inflation guard | CMD2 Phase 11 |
| `stat_budget.json` | ✅ Per-rarity budget (common→legendary) | Spec/08 |
| `slot_cap.json` | ✅ Bão Kích per slot. Total = 5000 BP = 50% (match global cap) | Spec/08 Mục III |
| `loot_tables.json` | ✅ Loot generation | |
| `pvp_normalization.json` | ✅ PvP normalization | R14 anti-P2W |
| `quest_constants.json` | ✅ Quest config | |
| `sets.json` + `affix_pool.json` + `items.json` | ✅ Itemization v15 | |

**Verdict:** 13/13 data file CLEAN. All BP scale + INT only + locked by Mr.Long 14/5. KHÔNG conflict với NEW spec.

---

## III. CMD ROLE MAPPING (OLD CMD1-4 → NEW 22 CMD)

| OLD CMD | OLD deliverable | NEW CMD slot | Migration effort |
|---|---|---|---|
| **CMD1 Combat** | `src/logic/combat_runtime.ts` + 132 logic file + Phase 19 mutation 94% | **cmd-engine** (core + wrappers + replay) + **cmd-boss** (boss AI runtime) | PORT 3-4d |
| | `data/element_wheel.json` (6 hệ) | `cmd-engine/output/core/element_matrix.ts` | EXTEND (add RB path axis) 1d |
| | `data/status_constants.json` + `apply_effect.ts` | `cmd-engine/output/core/status_effects.ts` | PORT 2d |
| | `src/logic/replay_event_stream.ts` + `replay_compaction.ts` | `cmd-engine/output/replay/` + add R68 state_checksum | PORT+EXTEND 2d |
| **CMD2 Economy** | `src/modules/economy/` + `economy_integration/` (anti-dupe extensive) | **cmd-db** (transaction wrappers) + **cmd-engine** (economy formulas) | SPLIT 3d |
| | `src/modules/itemization/` | **cmd-item** | PORT 2d |
| | `data/economy_constants.json` + `itemization_constants.json` | `cmd-engine/data/` (constants) + `cmd-db/data/` | COPY 0.5d |
| | `data/loot_tables.json` + `affix_pool.json` + `sets.json` + `items.json` | `cmd-item/data/` | COPY 0.5d |
| **CMD3 Quest** | `src/modules/quest/` (cross_shard, dialog, dungeon, companion) | **cmd-quest** (quest+progression) + **cmd-dialog** (dialog runtime) | SPLIT 2d |
| | `data/quest_constants.json` | `cmd-quest/data/` | COPY 0.5d |
| **CMD4 Tooling+Auth+Cloud** | `src/server/anti_bot/` + `anti_cheat/` | **cmd-qa-core** (anti-cheat) + **cmd-parse** (anti-bot detection) | PORT 1d |
| | `src/server/auth/` | **cmd-parse** (auth) + NEW cmd-auth (R66) | PORT + NEW 2d |
| | `src/db/` + `migrations/` + repositories | **cmd-db** (DB layer) | PORT 1d |
| | `src/network/` | NEW cmd-network (R69) | PORT + NEW 2d |
| | `src/tools/` + `scripts/` | `scripts/` repo root | COPY 0.5d |
| **Tests** | `tests/` 338 file flat + phase folders | `cmd-*/tests/` per CMD | RE-ORG 5-7d |
| **Specs** | `spec/00-11_*.md` (12 file) | `foundation/` + `docs/` repo | COPY 0.5d |

### CMD trống / KHÔNG có OLD equivalent (cần build mới hoặc grace period):
- **cmd-lead** — Orchestrator. NEW (build trong Phase 14).
- **cmd-place** — Place management. ❓ Có thể overlap với map/zone code cũ.
- **cmd-map** — Content map. Reuse từ project SVTK map system existing.
- **cmd-event** — Event scheduler. Có thể bridge từ encounter_recording.
- **cmd-sprite** — Art sprite pipeline. CMD-ART team handle.
- **cmd-icon** — Icon pipeline. CMD-ART.
- **cmd-audio** — Audio. NEW.
- **cmd-qa-content / cmd-qa-art / cmd-qa-full** — QA layers (cmd-qa-core đã có anti-cheat bridge).

### Overlap risk
- CMD2 economy → split sang cmd-db + cmd-engine. Cần định ranh giới rõ.
- CMD4 anti-bot → vào cmd-qa-core hay cmd-parse? Spec mới chưa rõ → flag.

---

## IV. ROLLBACK PLAYBOOK (L4)

### Trigger rollback khi
- Phase 14 sprint week 1: nếu copy file gặp lỗi structure → STOP, restore.
- Phase 14 sprint week 2: nếu gap fill (R67/R68) break compile → STOP.
- Phase 14 sprint week 3: nếu < 95% test 338 pass → consider rollback.

### Rollback steps (5 phút)
```powershell
# 1. Confirm backup integrity
$h = (Get-FileHash 'D:\BACKUP_FINAL_TSONLINE_20260518.zip' -Algorithm SHA256).Hash
if ($h -ne '4064719187E557BFB5A3A088C7115C7DA74AAF3C37C8866F60DB40EFB107F0BB') {
  throw "BACKUP CORRUPT — abort rollback. Contact Mr.Long."
}

# 2. Move current state to quarantine
Move-Item 'D:\DỰ ÁN AI\FINAL TSONLINE' 'D:\QUARANTINE_FINAL_TSONLINE_FAILED'

# 3. Extract backup
Expand-Archive -Force 'D:\BACKUP_FINAL_TSONLINE_20260518.zip' 'D:\DỰ ÁN AI\FINAL TSONLINE'

# 4. Verify git tag
git -C 'D:\DỰ ÁN AI\FINAL TSONLINE' tag -l pre-migration-v2.8.0
# Expected: pre-migration-v2.8.0

# 5. Re-install dependencies (node_modules excluded from backup)
cd 'D:\DỰ ÁN AI\FINAL TSONLINE'
npm install

# 6. Smoke test
npm test -- --reporter=dot --bail
# Expected: 5878 tests pass (or current baseline)
```

### Post-rollback
- Document failure reason in `D:\BACKUP_FINAL_TSONLINE_20260518_ROLLBACK_LOG.md`
- Mr.Long decision: re-attempt Phase 14 (with fix) hoặc Phương án C fallback (CMD1 frozen, build cầu).

---

## V. PHASE 14 MIGRATION SPRINT — UPDATED PLAN

### Pre-flight (DONE):
- ✅ L1 Backup zip 20MB (5677 file)
- ✅ L2 Git tag `pre-migration-v2.8.0`
- ✅ L3a Rule compliance matrix
- ✅ L3b Data compliance (13/13 clean)
- ✅ L3c CMD role mapping
- ✅ L4 Rollback playbook

### Sprint week 1 — Migrate (5 ngày, parallel)
- CMD1 → cmd-engine + cmd-boss (port)
- CMD2 → cmd-db + cmd-engine + cmd-item (split)
- CMD3 → cmd-quest + cmd-dialog (split)
- CMD4 → cmd-parse + cmd-db + cmd-qa-core + cmd-network (split)
- Tests 338 → cmd-*/tests/

### Sprint week 2 — Gap fill (5 ngày, sequential do dependency)
- D1-2: R67 TickScheduler adapter (wrap combat_runtime tick)
- D3: R68 state_checksum (top of replay_stream)
- D4: Element matrix extend (6 hệ + RB path axis tách layer)
- D5: R66/R69/R70 grace period documentation (no implementation, just compliance doc)

### Sprint week 3 — Validation (5 ngày)
- D1-2: Re-run 338 test trong new structure
- D3: Run NEW audit script (`audit_v280_strict.py` / `comprehensive_audit.py` / `audit_decisive_all.py`)
- D4: Fix breakage (port issues)
- D5: Final report + commit + push svtk-status repo

### Acceptance criteria
- ✅ 338 test pass ≥ 95% (allow ≤5% port-related breakage)
- ✅ NEW audit script return PASS (exit 0)
- ✅ Foundation hash verify pass
- ✅ All 22 cmd-* folder populated (no empty CMD)
- ✅ Cross-reference test: gameplay R1-R33 + runtime R34-R70 cited correctly

---

**END AUDIT — 18/5/2026**
