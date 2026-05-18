# 🛡 AUTO_START CMD1 → cmd-engine + cmd-boss (v2.8.0)

> **Paste nguyên file này vào terminal CMD1. CMD tự chạy autonomous, không hỏi.**
> **Mr.Long đã quyết Phương án A migration 18/5 + 5 CMD architecture + auto-rename.**

---

## 🎯 PROMPT DECISIVE (paste vào terminal)

```
Bạn là CMD1 SVTK, từ giờ self-rename thành cmd-engine + cmd-boss (Phương án A v2.8.0).

═══════════════════════════════════════════════════════════════
NHIỆM VỤ AUTONOMOUS — KHÔNG HỎI Mr.Long. KHÔNG offer 1/2/3.
═══════════════════════════════════════════════════════════════

CONTEXT (read first):
1. Foundation v2.8.0: clone https://github.com/Trinhlong1988/svtk-status, đọc foundation/SVTK_FOUNDATION_v2.8.0.md
2. Role binding: cmd-lead/CMD_ROLE_BINDING_v2.8.0.md
3. Memory (Trợ lý maintain): C:\Users\Administrator\.claude\projects\C--Users-Administrator\memory\project_svtk_phase14_5cmd_architecture.md
4. OLD code workspace: D:\DỰ ÁN AI\FINAL TSONLINE\ (Phase 13 FROZEN, KHÔNG sửa)
5. NEW repo workspace: cloned svtk-status

QUY TẮC TUYỆT ĐỐI:
1. AUTONOMOUS — không hỏi Mr.Long.
2. KHÔNG sửa code OLD ở D:\DỰ ÁN AI\FINAL TSONLINE\ (FROZEN).
3. CHỈ copy OLD → NEW + add R67/R68 wrapper (KHÔNG rewrite combat logic).
4. Heartbeat 30 phút: push file cmd-lead/heartbeats/cmd-engine_hb_{timestamp}.json
5. Alert nếu blocker: push cmd-lead/alerts/cmd-engine_alert_{ts}.json — cmd-lead (Trợ lý) sẽ ship Zalo Mr.Long.
6. Completion: push cmd-lead/completions/cmd-engine_done_{ts}.json + commit message rõ ràng.

═══════════════════════════════════════════════════════════════
TASK 1 (Tuần 1, Mon-Tue): Migrate Combat OLD → NEW
═══════════════════════════════════════════════════════════════

A. Copy 80+ file combat:
   - Source: D:\DỰ ÁN AI\FINAL TSONLINE\src\logic\combat_*.ts (+ apply_effect, status_*, aura_*, mechanic_*, etc.)
   - Target: cmd-engine/output/legacy/<filename>
   - Preserve subfolders nếu có

B. Copy 10+ file boss:
   - Source: src/logic/boss_*.ts (boss_ai_runtime, boss_phase_machine, boss_script_registry, boss_mechanic_runtime, boss_timeline_resolver, boss_target_hook, etc.)
   - Target: cmd-boss/output/legacy/

C. Copy data:
   - data/element_wheel.json → cmd-engine/data/
   - data/status_constants.json → cmd-engine/data/
   - data/threat_constants.json → cmd-engine/data/
   - data/skill_constants.json → cmd-engine/data/

D. TypeScript compile verify:
   cd repo && npm install (nếu cần) && npx tsc --noEmit cmd-engine/output/legacy/*.ts
   Nếu lỗi import path → fix import relative path (KHÔNG sửa logic).

E. Heartbeat + commit:
   git add cmd-engine/ cmd-boss/
   git commit -m "CMD1 migrate combat legacy → cmd-engine + cmd-boss"
   git push origin main
   echo '{"cmd":"cmd-engine+cmd-boss","status":"week1_migrate_done","ts":"$(date -u +%FT%TZ)","files_migrated":<count>}' > cmd-lead/completions/cmd-engine_done_$(date +%s).json
   git add cmd-lead/completions/ && git commit -m "cmd-engine completion ping" && git push

═══════════════════════════════════════════════════════════════
TASK 2 (Tuần 2, Mon-Wed): Gap fill R67 TickScheduler + R68 state_checksum
═══════════════════════════════════════════════════════════════

A. R67 TickScheduler adapter:
   - File mới: cmd-engine/output/runtime/tick_scheduler_adapter.ts
   - Wrap existing combat_runtime.ts tick semantics (beginCombatTurn/tickAuraGuard/endCombatTurn) thành R67 interface (monotonic_ns + server tick stamp).
   - Test: 5 deterministic test (same seed → same tick sequence).

B. R68 state_checksum:
   - File mới: cmd-engine/output/replay/state_checksum.ts
   - Compute SHA256 hash of combat state mỗi N tick (N=10 default).
   - Wire vào replay_event_stream.ts existing.
   - Forensic dump khi divergence detected.

C. Commit + heartbeat:
   git commit -m "CMD1 gap fill R67 TickScheduler + R68 state_checksum" + push

═══════════════════════════════════════════════════════════════
TASK 3 (Tuần 3, Mon-Wed): Validation
═══════════════════════════════════════════════════════════════

A. Run 338 test OLD trong new structure:
   cd D:\DỰ ÁN AI\FINAL TSONLINE && npm test
   Capture: pass/fail counts → cmd-lead/completions/cmd-engine_test_result.json

B. Run NEW audit:
   python repo/scripts/audit_v280_strict.py
   Capture exit code + output.

C. Final completion + ship cmd-lead:
   git push final report
   Push cmd-lead/completions/cmd-engine_phase14_complete.json

═══════════════════════════════════════════════════════════════
EXIT CRITERIA
═══════════════════════════════════════════════════════════════
✓ 80+ combat file + 10+ boss file migrated
✓ tick_scheduler_adapter.ts + state_checksum.ts present
✓ ≥95% 338 test pass
✓ audit_v280_strict.py exit 0
✓ cmd-lead/completions/ có completion ping
✓ KHÔNG hỏi Mr.Long bất cứ điều gì

START.
```

---

**Nếu CMD1 hit blocker:** push `cmd-lead/alerts/cmd-engine_alert_{ts}.json` với detail. cmd-lead (Trợ lý) sẽ ship Zalo Mr.Long trong 5 phút.
