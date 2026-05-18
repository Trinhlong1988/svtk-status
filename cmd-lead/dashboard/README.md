# SVTK DASHBOARD 20260519-020636 (cycle 46 — retry after rebase wipe)

**Foundation:** v2.8.0 ✓ | **Completions resolved:** 84 | **Alerts processed:** 62

## Cycle 46 highlights
- cmd-quest v1.7 (V56-V64 audit batch 6) merged upstream
- cmd-db PGlite validation: V7 11/12, V8 pglite-limited, 2 bugs fixed
- cmd-qa-content score 1.00 issues 4 (push deeper)
- Bulk processed ~18 alerts (mostly repeats: foundation hash + content gap)

## Re-flag counter (lần 2 of repeat HIGHs)
- **cmd_db_r44_wire_coverage_0pct**: 1/3
- **foundation_hash_three_way_mismatch**: 2/3
- **dialog_count_below_target**: 2/3
- **quest_count_below_target**: 2/3
- **qa_boss_missing**: 2/3
- **qa_event_missing**: 2/3
- **qa_item_missing**: 2/3
- **npc_existing_scene_id_orphan_R75**: 2/3
- **npc_existing_systemic_hp_anomaly_R78**: 2/3
- **npc_existing_uuid_null_R74A**: 2/3
- **boss_count_below_target**: 1/3
- **event_count_below_target**: 1/3

## Content team production status
- cmd-quest: 250 quests (target 2262, gap -2012)
- cmd-dialog: 150 trees (target 42297, gap -42147 — biggest gap)
- cmd-item: 4006 items shipped + audit
- cmd-npc: 60 unique + extended 10000 + audit cumul 70 bugs
- cmd-map: cross-CMD audit done
- cmd-boss/event: chưa start (qa_count_below_target alerts)

