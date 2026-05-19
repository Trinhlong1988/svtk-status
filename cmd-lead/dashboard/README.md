# SVTK DASHBOARD 20260519-091906 (cycle 50)

**Foundation:** v2.8.0 ✓ | **Completions resolved:** 88 | **Alerts processed:** 71 | **Escalations:** 1

## Cycle 50 — 14 alerts drained (npc audit batch 3)
- 3 HIGH npc_existing R74A/R75/R78 (re-flag lần 3)
- 5 MED npc_existing variants
- 5 LOW npc + 1 LOW legacy era
- 2 completions (cmd-quest cycle + npc_extend_to_10000)

## Re-flag counter
- **cmd_db_r44_wire_coverage_0pct**: 1/3
- **foundation_hash_three_way_mismatch**: 2/3
- **dialog_count_below_target**: 2/3
- **quest_count_below_target**: 2/3
- **qa_boss_missing**: 2/3
- **qa_event_missing**: 2/3
- **qa_item_missing**: 2/3
- **npc_existing_scene_id_orphan_R75**: 3/3 ⚠ NEXT WILL ESCALATE
- **npc_existing_systemic_hp_anomaly_R78**: 3/3 ⚠ NEXT WILL ESCALATE
- **npc_existing_uuid_null_R74A**: 3/3 ⚠ NEXT WILL ESCALATE
- **boss_count_below_target**: 1/3
- **event_count_below_target**: 1/3

## Note
3 npc_existing alerts là báo cáo định kỳ từ cmd-npc — KHÔNG phải drift mới. Mỗi audit round npc raise lại. Resolution = R71.1 immutable (npc gốc không sửa được, chỉ informational track).
