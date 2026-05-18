# 🎯 PROMPT TRỢ LÝ — UPLOAD GITHUB + KICKOFF PHASE 1

> Paste vào Claude trợ lý có quyền git push + chạy CMD.
> Mr.Long sẽ upload `SVTK_FINAL_v2.8.0_complete.zip` riêng cho trợ lý.

---

## ⚡ MASTER PROMPT (paste nguyên)

```
Bạn là CMD Claude trợ lý SVTK. Mr.Long giao việc decisive sau đây.

═══════════════════════════════════════════════════════════════
NHIỆM VỤ 2 PHASE:
  PHASE A: Upload toàn bộ package lên GitHub
  PHASE B: Kickoff Phase 1 BACKEND (CMD5 LEAD + Team A DB + Team B ENGINE)
═══════════════════════════════════════════════════════════════

REPO:    https://github.com/Trinhlong1988/svtk-status
BRANCH:  main
AUTHOR:  smartbeevn@gmail.com
SOURCE:  SVTK_FINAL_v2.8.0_complete.zip (48 files)

═══════════════════════════════════════════════════════════════
QUY TẮC TUYỆT ĐỐI
═══════════════════════════════════════════════════════════════
1. AUTONOMOUS — KHÔNG hỏi Mr.Long, KHÔNG offer 1/2/3 hay a/b/c/d.
2. CULTURAL LOCK — verify package không có CJK chars + Tam Quốc.
3. FOLDER STRUCTURE bắt buộc (KHÔNG flat upload).
4. THỨ TỰ — upload đúng phases A→B, KHÔNG đảo.
5. CMD5 ĐIỀU PHỐI — gap → push alert lên cmd-lead/alerts/.

═══════════════════════════════════════════════════════════════
PHASE A: UPLOAD GITHUB (24 file ưu tiên + scripts + data)
═══════════════════════════════════════════════════════════════

A1. Verify zip integrity:
    - Giải nén /tmp/svtk_upload/
    - Count 48 files
    - Scan CJK + Tam Quốc → nếu hit → push HIGH alert + STOP

A2. Tổ chức folder structure trong repo:

    foundation/
      SVTK_FOUNDATION_v2.8.0.md
      INDEX.sha256

    docs/
      SVTK_README.md
      SVTK_ROADMAP.md
      SVTK_OPERATION_PHASE1.md
      SVTK_OPERATION_PHASE2.md
      SVTK_OPERATION_PHASE3.md
      SVTK_OPERATION_PHASE4.md
      SVTK_OPERATION_PHASE5.md

    cmd-lead/
      cmd.md                        ← CMD5_LEAD_v2.1.md
      alerts/.gitkeep
      completions/.gitkeep
      heartbeats/.gitkeep
      inbox-recheck/.gitkeep
      dashboard/.gitkeep
      escalations/.gitkeep

    cmd-db/cmd.md                   ← CMD_DB_v2.4.2_patch.md
    cmd-engine/cmd.md               ← CMD_ENGINE_v1.0.md
    cmd-place/cmd.md                ← CMD_PLACE_v1.0.md
    cmd-parse/cmd.md                ← CMD_PROMPT_v6_STRICT_VERIFIED.md

    cmd-npc/
      cmd.md                        ← CMD_NPC_v1.1.md
      existing/NPC_438.jsonl
      existing/gaps_v1.txt
      output/registry/npc_full.jsonl
      inbox/.gitkeep
      status/.gitkeep

    cmd-skill/
      cmd.md                        ← CMD_SKILL_v1.0.md
      existing/SKILL_165.jsonl
      output/registry/skill_full.jsonl
      inbox/.gitkeep
      status/.gitkeep

    cmd-item/cmd.md                 ← CMD_ITEM_v1.1.md
    cmd-boss/cmd.md                 ← CMD_BOSS_v1.0.md
    cmd-quest/cmd.md                ← CMD_QUEST_v1.1.md
    cmd-map/cmd.md                  ← CMD_MAP_v1.1.md
    cmd-dialog/cmd.md               ← CMD_DIALOG_v1.1.md
    cmd-event/cmd.md                ← CMD_EVENT_v1.0.md
    cmd-sprite/cmd.md               ← CMD_SPRITE_v1.0.md
    cmd-icon/cmd.md                 ← CMD_ICON_v1.0.md
    cmd-audio/cmd.md                ← CMD_AUDIO_v1.0.md

    cmd-qa-content/cmd.md           ← CMD_QA_CONTENT_v1.0.md
    cmd-qa-art/cmd.md               ← CMD_QA_ART_v1.0.md
    cmd-qa-core/cmd.md              ← CMD_QA_CORE_v1.0.md
    cmd-qa-full/cmd.md              ← CMD_QA_FULL_v1.0.md

    ship/
      PROMPT_TROLY_SHIP_AB.md
      PROMPT_TROLY_UPLOAD_GITHUB.md  ← prompt này

    scripts/
      svtk_pipeline.py
      comprehensive_audit.py
      audit_decisive_all.py
      audit_v280_strict.py
      test_decisive_50.py
      test_pipeline_50.py
      test_npc_full_system.py
      test_char_damage.py
      test_anti_dupe.py
      test_npc_map_allocation.py
      test_lead_protocol.py
      test_bidirectional.py
      test_qa_protocol.py
      test_team_dependency.py
      test_prompt_troly_v2.py

A3. THỨ TỰ COMMIT (5 commits tách biệt, dễ rollback):

    Commit 1: "Add Foundation v2.8.0 + docs"
              foundation/ + docs/ + ship/ + .gitignore + README.md

    Commit 2: "Add CMD5 LEAD orchestrator"
              cmd-lead/

    Commit 3: "Add Team CORE (DB + ENGINE + PLACE + PARSE)"
              cmd-db/ + cmd-engine/ + cmd-place/ + cmd-parse/

    Commit 4: "Add Team CONTENT (8) + Team ART (3)"
              cmd-npc/ + cmd-skill/ + cmd-item/ + cmd-boss/ +
              cmd-quest/ + cmd-map/ + cmd-dialog/ + cmd-event/ +
              cmd-sprite/ + cmd-icon/ + cmd-audio/

    Commit 5: "Add Team QA (4) + scripts"
              cmd-qa-content/ + cmd-qa-art/ + cmd-qa-core/ +
              cmd-qa-full/ + scripts/

A4. Push 5 commit → branch main

A5. Reply lại Mr.Long:
    {
      "phase_a": "DONE",
      "commits": ["sha1-1", "sha1-2", "sha1-3", "sha1-4", "sha1-5"],
      "files_uploaded": 48,
      "repo_url": "https://github.com/Trinhlong1988/svtk-status",
      "ready_for_phase_b": true
    }

═══════════════════════════════════════════════════════════════
PHASE B: KICKOFF PHASE 1 BACKEND (CMD5 + Team A + Team B + QA)
═══════════════════════════════════════════════════════════════

B1. Chạy 4 CMD theo thứ tự (4 terminal song song):

    Terminal 1 — CMD5 LEAD:
       cd /repo && python3 -c "exec(open('cmd-lead/cmd.md').read())"
       (poll alerts/ mỗi 5 phút urgent, 1h normal)

    Terminal 2 — Team A DB:
       cd /repo/cmd-db && python3 <<<"$(cat cmd.md)"
       Output: schema.sql (PostgreSQL 17 table)
       Push: cmd-db/output/schema.sql + cmd-lead/completions/

    Terminal 3 — Team B ENGINE:
       cd /repo/cmd-engine && python3 <<<"$(cat cmd.md)"
       Output: combat.py (CHAR + damage formula + element wheel)
       Push: cmd-engine/output/combat.py + cmd-lead/completions/

    Terminal 4 — QA Core:
       cd /repo/cmd-qa-core && python3 <<<"$(cat cmd.md)"
       Verify: 17 GATE 1 criteria
       Push verdict: cmd-lead/completions/QA-VERDICT-{ts}.json

B2. CMD5 LEAD chờ 3 completion (DB + ENGINE + QA Core) → update dashboard:
    cmd-lead/dashboard/status.json

B3. Nếu GATE 1 PASS → Mr.Long báo, sẵn sàng Phase 2.
    Nếu GATE 1 FAIL → CMD5 assign fix → worker retry.

═══════════════════════════════════════════════════════════════
SELF-AUDIT TRƯỚC KHI REPLY MR.LONG
═══════════════════════════════════════════════════════════════
1. Đếm 48 files trong repo
2. Verify cấu trúc folder đúng 22 cmd-* + foundation/docs/ship/scripts
3. 5 commits có sha1 distinct
4. Branch main push thành công
5. Phase B kickoff status: 4 CMD running hoặc completed
6. KHÔNG có CJK char trong code/text

═══════════════════════════════════════════════════════════════
HONEST REPORT NẾU GẶP LIMIT
═══════════════════════════════════════════════════════════════
- Nếu KHÔNG có quyền git push → push alert HIGH:
  "no_git_push_permission" → STOP Phase A, đợi Mr.Long cấp quyền
- Nếu Phase B không chạy được Claude Code → push alert MED:
  "cannot_run_cmd_code" → Phase A vẫn DONE, Mr.Long tự kickoff Phase B

═══════════════════════════════════════════════════════════════
EXIT CRITERIA
═══════════════════════════════════════════════════════════════
✓ 48 files trên GitHub branch main
✓ Folder structure đúng spec
✓ 5 commits separate
✓ CMD5 LEAD + Team A + Team B + QA chạy (hoặc honest report nếu không thể)
✓ Reply Mr.Long commit SHAs + status
✓ KHÔNG hỏi Mr.Long bất cứ điều gì

START.
```

---

**END PROMPT** — Paste decisive, không hỏi.
