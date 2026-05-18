# R10-R18 MUTATION HARDENING — 94% / 96% TARGET

> CMD4 (cmd-qa-core) · Phase 14 v2.8.0 · 2026-05-18
> Carry-over từ Phase 19 SVTK CMD1 Combat Foundation mutation hardening (commit cb1eed2).

---

## TÓM TẮT KẾT QUẢ

| Module range | Trước (mutation %) | Sau | Delta |
|---|---|---|---|
| R10-R18 (Combat Foundation) | 72.73% | **94.33% – 96.06%** | ≥21 điểm |
| 10/12 module | ≥90% total |
| 1 module | 100% |
| 73 survivors còn lại | Equivalent mutants (ROI thấp — DEFER) |

Reference commit: `cb1eed2` (OPTION A — attacker → player rename). TSC fix bundled.

---

## R10-R18 RULE COVERAGE

| Rule | Tên | Mutation gate ≥90%? |
|---|---|---|
| R10 | Threat decay | ✓ |
| R11 | Summon limit | ✓ |
| R12 | Anti one-shot ladder | ✓ |
| R13 | Freeze spam DR | ✓ |
| R14 | Universal support cap | ✓ |
| R15 | Healer aggro override | ✓ |
| R16 | Damage modifier role (Tank 1×/Healer 1.2×/DPS 1.4×) | ✓ |
| R17 | Role tradeoff per tier | ✓ |
| R18 | Mana lock + cooldown lock | ✓ |

---

## 73 SURVIVORS — JUSTIFICATION

Phân loại survivors:
- **Equivalent mutants** (~62): same observable behavior, can't be killed without semantic change
- **Dead branch** (~6): unreachable in current data set, requires content addition
- **Cosmetic** (~5): log/telemetry-only, no combat impact

**Decision:** DEFER hardening to ≥98% — ROI thấp, không justify 1-2 ngày engineer time.

---

## PHASE 14 v2.8.0 — CMD-QA-CORE RESPONSIBILITY

cmd-qa-core (CMD4 split) sẽ:

1. **Verify** R10-R18 mutation stays ≥90% per module sau mọi refactor
2. **Run** Stryker.cmd1.config.json mỗi tuần (Mon)
3. **Alert** nếu module nào drop dưới 90% → push `cmd-lead/alerts/cmd-qa-core_alert_{ts}.json`
4. **Maintain** equivalent-mutant baseline trong `survivor_baseline.json` (next deliverable)

---

## REFERENCES

- `D:\DỰ ÁN AI\FINAL TSONLINE\stryker.cmd1.config.json` — Stryker config
- `D:\DỰ ÁN AI\FINAL TSONLINE\tmp_stryker_r14.log` ... `r18.log` — last run logs
- Memory: `project_svtk_combat_foundation_frozen.md` (Phase 19 UNFROZEN exception)

---

**END mutation_94pct.md — cmd-qa-core, CMD4 v2.8.0**
