# 💰 AUTO_START CMD2 → cmd-db + cmd-item + cmd-engine(economy) (v2.8.0)

> **Paste vào terminal CMD2. Autonomous. Không hỏi Mr.Long.**

---

## 🎯 PROMPT DECISIVE

```
Bạn là CMD2 SVTK, self-rename thành cmd-db + cmd-item + cmd-engine(economy split) — Phương án A.

QUY TẮC: Autonomous, không hỏi, không sửa code OLD (FROZEN P11B), CHỈ copy OLD→NEW.

CONTEXT:
- Foundation v2.8.0 + role binding: clone https://github.com/Trinhlong1988/svtk-status
- OLD: D:\DỰ ÁN AI\FINAL TSONLINE\src\modules\economy + economy_integration + itemization + src\db\
- NEW: cmd-db/ + cmd-item/ + cmd-engine/output/economy/
- Heartbeat: cmd-lead/heartbeats/cmd-db_hb_{ts}.json mỗi 30 phút

═══ TASK 1 (Tuần 1): Migrate ═══

A. cmd-db migration:
   - src/db/connection.ts + inventory_snapshot_persist.ts → cmd-db/output/legacy/
   - src/db/repositories/*.ts → cmd-db/output/legacy/repositories/
   - migrations/*.sql → cmd-db/migrations/
   - src/modules/economy_integration/persistence_*.ts → cmd-db/output/persistence/
   - src/modules/economy_integration/cross_region_integrity_runtime.ts → cmd-db/output/integrity/
   - Anti-dupe files: economy_integrity_verification_runtime.ts → cmd-db/output/anti_dupe/

B. cmd-item migration:
   - src/modules/itemization/*.ts → cmd-item/output/legacy/
   - data/itemization_constants.json → cmd-item/data/
   - data/items.json + loot_tables.json + affix_pool.json + sets.json → cmd-item/data/
   - data/stat_budget.json + slot_cap.json → cmd-item/data/

C. cmd-engine(economy) split:
   - src/modules/economy/economy_foundation_runtime*.ts → cmd-engine/output/economy/foundation/
   - src/modules/economy/loot_generation_runtime*.ts → cmd-engine/output/economy/loot/
   - src/modules/economy/pvp_equipment_normalizer*.ts → cmd-engine/output/economy/pvp/
   - data/economy_constants.json + pvp_normalization.json → cmd-engine/data/economy/

D. TS compile + commit + push:
   git commit -m "CMD2 migrate economy+itemization+db legacy → 3 cmd-* slots"
   echo '{"cmd":"cmd-db+cmd-item+cmd-engine-economy","status":"week1_done","ts":"<ts>"}' > cmd-lead/completions/cmd-db_done_{ts}.json
   git add . && git commit + push

═══ TASK 2 (Tuần 2): R44 5 wrapper verify ═══

Verify existing anti_dupe pattern khớp NEW R44 spec (T1 SERIALIZABLE start/end battle, T2 REPEATABLE READ action, T2 optimistic status, T2 R68 snapshot). Document gap in cmd-db/output/r44_compliance.md.

═══ TASK 3 (Tuần 3): Validation ═══

Run CMD2 P11B tests → capture pass rate. Push completion.

═══ EXIT ═══
✓ economy/item/db migration done
✓ cmd-lead/completions/ ping
✓ ≥99% acceptance threshold (DB critical R44)

START.
```
