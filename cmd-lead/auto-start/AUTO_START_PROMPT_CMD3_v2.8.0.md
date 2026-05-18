# 📜 AUTO_START CMD3 → cmd-quest + cmd-dialog (v2.8.0)

```
Bạn là CMD3 SVTK, self-rename thành cmd-quest + cmd-dialog — Phương án A.

QUY TẮC: Autonomous, không hỏi, không sửa code OLD (FROZEN P12), CHỈ copy.

CONTEXT:
- Foundation + role binding: clone svtk-status
- OLD: D:\DỰ ÁN AI\FINAL TSONLINE\src\modules\quest\
- NEW: cmd-quest/ + cmd-dialog/
- Heartbeat: cmd-lead/heartbeats/cmd-quest_hb_{ts}.json mỗi 30 phút

═══ TASK 1 (Tuần 1): Split quest module ═══

A. cmd-quest (progression + companion + cross-shard):
   - canonical_persistence_snapshot_runtime.ts → cmd-quest/output/legacy/
   - companion_progression_hook.ts + companion_affinity_*.ts → cmd-quest/output/companion/
   - condition_complexity_guard*.ts → cmd-quest/output/condition/
   - content_replay_validation.ts → cmd-quest/output/validation/
   - cross_shard_progression_sync.ts → cmd-quest/output/cross_shard/
   - dungeon_unlock_progression.ts → cmd-quest/output/dungeon/
   - data/quest_constants.json → cmd-quest/data/

B. cmd-dialog (dialog runtime):
   - dialog_runtime.ts → cmd-dialog/output/legacy/
   - dialog_condition_evaluator.ts + dialog_condition_hook.ts → cmd-dialog/output/condition/
   - companion_narrative_runtime.ts + companion_narrative_scaffold.ts → cmd-dialog/output/narrative/

C. Commit + heartbeat:
   git commit -m "CMD3 split quest module → cmd-quest + cmd-dialog"
   Push cmd-lead/completions/cmd-quest_done.json

═══ TASK 2 (Tuần 2): Quest registry expand ═══

Current quest registry 100 quest → target 250 (per Skill v15 align). Use existing dialog tree để generate 150 quest scaffold mới. Cross-ref với cmd-npc/existing/NPC_438.jsonl (do AB-1 ship).

═══ TASK 3 (Tuần 3): Validation ═══

Run 16 module quest tests + 579 test verify. Push completion.

═══ EXIT ═══
✓ quest split done
✓ dialog split done  
✓ ≥95% test pass
✓ cmd-lead/completions/ ping

START.
```
