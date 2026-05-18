# CMD NPC — Audit Index

Master index of all deep audit rounds executed on CMD NPC v1.1.0 output.

**Method (all rounds):** verified-data-only, mỗi bug reproducible với evidence cụ thể, không suy đoán.

---

## Round summary

| Round | Date | Validator | Bugs fixed | Audit report |
|---|---|---|---|---|
| 1-10 | 2026-05-18 | 15→20 | 10 | [AUDIT_REPORT_ROUND_1_10_20260518-235531.md](status/AUDIT_REPORT_ROUND_1_10_20260518-235531.md) |
| 11-20 | 2026-05-19 | 20→25 | 10 | [AUDIT_REPORT_ROUND_11_20_20260519-000806.md](status/AUDIT_REPORT_ROUND_11_20_20260519-000806.md) |
| 21-30 | 2026-05-19 | 25→30 | 10 | [AUDIT_REPORT_ROUND_21_30_20260519-002705.md](status/AUDIT_REPORT_ROUND_21_30_20260519-002705.md) |
| 31-40 | 2026-05-19 | 30→35 | 10 | [AUDIT_REPORT_ROUND_31_40_20260519-011348.md](status/AUDIT_REPORT_ROUND_31_40_20260519-011348.md) |
| 41-50 | 2026-05-19 | 35→40 | 10 | [AUDIT_REPORT_ROUND_41_50_20260519-012526.md](status/AUDIT_REPORT_ROUND_41_50_20260519-012526.md) |
| **51-60** | **2026-05-19** | **40→45** | **10** | (current build) |

**Cumulative total: 60 hidden bugs fixed.**

---

## Bug fix areas covered

### Round 1-10: foundation correctness
Schema uniformity, UUID R74.A, spawn collision R75, class_hierarchy R80, dmg_taken_multi R80, skill_ids range R71 SKILL_165, sceneId orphan R75, boss tier R80, townsmen tier R76, validator extension.

### Round 11-20: identity + R71.4 + diacritics
Protagonist uniqueness R83, mentor R83, historical figure diacritics, SQL CHECK scene_id removal, surname pool expansion, protagonist background, era distribution R71.4 hybrid, validator extension, ex-side noncombat skills alert, mentor stats anomaly alert.

### Round 21-30: brief compliance + tier 9 + lifecycle
recolor_index alias (brief line 224), starting_class novice (brief line 219), pet template fields (brief line 826-838), transaction log R74.B, tier 9 distribution, era_extra_9 cleanup, protagonist hp alert, aggro scaling R80, raid_extreme marker, validator extension.

### Round 31-40: schema + dedup + gender + bg
SQL schema 14 columns, skill_ids dedup, gender heuristic, is_questgiver redundancy removal, historical figure background, SQL CHECK cultural_tag/aggro/gender, honest_gaps refresh, honest_gaps history, pet_evolution semantic fix, validator extension. **Plus bonus: Tam Quốc collision PROTECTED_NAMES (Triệu Vân).**

### Round 41-50: existing flag + systemic alerts + sweep
Existing historical flag (50 names), systemic hp anomaly alert (366 NPCs), mentor type mismatch alert, alerts sweep policy (alerts-processed/), completions sweep (completions-resolved/), transaction log idempotency, validator extension (historical count, mentor crossref, hp coverage, dedup policy, pet fields).

### Round 51-60: data sync + canonical refs + archive cap
Rebirthable non-boss alert, era_start_year backfill, mentor_npc_idx canonical, alerts-processed cap, audit_history code sync, AUDIT_INDEX.md (this file), status-archived cap, rebirthable alert wire, validator R51-R53 checks, validator R54-R55 checks.

---

## Active ex-side alerts (R71.1 immutable — source NPC_438.jsonl untouched)

| Severity | Issue ID | Count |
|---|---|---|
| HIGH | npc_existing_uuid_null_R74A | 438 |
| HIGH | npc_existing_scene_id_orphan_R75 | 59 |
| HIGH | npc_existing_systemic_hp_anomaly_R78 | 366 |
| MED | npc_existing_spawn_collision_R75 | 284 pairs |
| MED | npc_existing_type_tier_violation_R76_R80 | 111 |
| MED | npc_existing_mentor_type_mismatch_R83 | 2 |
| MED | npc_existing_rebirthable_non_boss_R74 | 43 (NEW Round 51-60) |
| LOW | npc_existing_noncombat_skills | 327 |
| LOW | npc_existing_mentor_stats_anomaly | 2 |
| LOW | npc_protagonist_stats_anomaly | 1 |

**10 cumulative alerts** (1 new Round 51-60).

---

## Pipeline diagram

```
load existing 438 → normalize (uuid/gender/historical_flag/era_year/protagonist_meta)
                 → extend to 10000 (5 main era hist figures + missing types + balanced gen)
                 → write_registry (5 jsonl + sha256)
                 → write_era (5 main + extra_9 active/unused)
                 → write_sprite_mapping
                 → write_schema (SQL with 52 columns + CHECKs)
                 → write_era_distribution
                 → write_npc_template_transaction_log (idempotent R74.B)
                 → sweep_old_npc_artifacts (alerts/completions/status archive)
                 → validator (45 checks)
                 → write_honest_gaps (audit_history 6 rounds)
                 → write_status
                 → write_lead_heartbeat_completion
                 → write_metrics
                 → alerts (10 ex-side per build)
                 → cold archive caps
```

---

**See `cmd-npc/status/AUDIT_REPORT_ROUND_*.md` for detailed per-round evidence + post-fix verification.**
