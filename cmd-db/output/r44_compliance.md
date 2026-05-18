# R44 Compliance Gap Analysis — CMD2 / cmd-db

> **Author:** CMD2 (cmd-db + cmd-item + cmd-engine economy split)
> **Reference spec:** `cmd-db/cmd.md` (CMD_DB v2.4.2 P1 production hardening patch)
> **Reference prompt:** `cmd-lead/auto-start/AUTO_START_PROMPT_CMD2_v2.8.0.md` § TASK 2 (Tuần 2)
> **Date:** 2026-05-18
> **Verdict:** PARTIAL — ~30% pattern match. Major NEW implementation needed Week 2-3.

---

## 1. R44 5-wrapper requirement (per AUTO_START prompt)

| # | Wrapper | Spec scope | Owner CMD |
|---|---------|-----------|-----------|
| W1 | **T1 SERIALIZABLE start/end battle** | combat session txn lifecycle | cmd-engine (combat) + cmd-db (txn wrap) |
| W2 | **T2 REPEATABLE READ action** | in-battle action (skill cast / loot / transfer) | cmd-db |
| W3 | **T2 optimistic status check** | version / status check before update | cmd-db |
| W4 | **T2 R68 snapshot** | replay-safe deterministic snapshot tied to action | cmd-db + cmd-engine (replay) |
| W5 | **AD1-AD12 anti-dupe nonce + idempotency** | implicit per CMD_DB v2.4.2 (executeWithIdempotency wrapper) | cmd-db |

---

## 2. OLD source inventory (what was migrated into cmd-db)

| Migrated file | Role in OLD | Layer |
|---------------|-------------|-------|
| `output/legacy/connection.ts` | pg `Pool` singleton + `initPool/setPool/closePool` | Plumbing (no anti-dupe) |
| `output/legacy/inventory_snapshot_persist.ts` | persist inventory snapshot | Persistence (no transaction wrap) |
| `output/legacy/repositories/*.ts` (5 files) | character / economy / inventory / player / quest CRUD on `pg.Pool` | CRUD (no anti-dupe wrap) |
| `migrations/001_init.sql` + `002_progression_snapshots.sql` | base schema + progression snapshot | Schema (no `pending_actions` / `idempotency_log` table) |
| `output/persistence/persistence_adapter.ts` | frozen Phase 11B in-memory persistence adapter | Phase 11B contract (no pg backing) |
| `output/persistence/persistence_adapter_bridge.ts` | Phase 13 Batch 2 generic bridge envelope (4-domain) | Bridge ONLY — no DB ownership per spec invariant |
| `output/integrity/cross_region_integrity_runtime.ts` | cross-region integrity verification runtime | Verification layer (no DB txn) |
| `output/anti_dupe/economy_integrity_verification_runtime.ts` | snapshot/persistence/reconnect/canonical replay verification | **Runtime verification ONLY — NOT DB anti-dupe wrapper** |

---

## 3. Gap matrix W1-W5

| Wrapper | OLD has? | Spec required impl | Gap | Severity |
|---------|----------|--------------------|-----|----------|
| **W1 T1 SERIALIZABLE start/end battle** | ❌ | `BEGIN ISOLATION LEVEL SERIALIZABLE` + 40001 retry loop wrapping `combatBegin` / `combatEnd` | Full NEW impl needed | 🔴 P0 |
| **W2 T2 REPEATABLE READ action** | ❌ | `BEGIN ISOLATION LEVEL REPEATABLE READ` wrapping per-action DB calls (skill cast, transfer, loot pickup) | Full NEW impl needed | 🔴 P0 |
| **W3 T2 optimistic status check** | ❌ | SQL `WHERE status = expected AND version = N` + RETURNING; reject on 0 rows updated | Full NEW impl needed; `pending_actions.status` enum locked in P11B (5-value, see invariant) | 🟡 P1 |
| **W4 T2 R68 snapshot** | 🟡 PARTIAL | `compute_state_checksum` wrapper on top of existing replay stream | `replay_event_stream` + `combat_replay_verification_runtime` exist in OLD (per audit memory). `compute_state_checksum` ≈ 1-day NEW (matches audit memory finding). | 🟡 P1 |
| **W5 AD1-AD12 + executeWithIdempotency** | ❌ | `executeWithIdempotency(pool, nonce, action_type, player_id, payload, executor, maxRetries=3)` + AD1-AD12 patterns (canonical payload hash, inventory cap 30, AD12 rollback idempotency, stale pending cron). Code template fully in `cmd-db/cmd.md` § P1.1-P1.5. | Full NEW impl needed; copy-from-spec ~600 LOC + `idempotency_log` + `pending_actions` tables migration | 🔴 P0 |

---

## 4. Schema gap — migrations needed (NEW for Phase 14)

OLD migrations (`001_init.sql`, `002_progression_snapshots.sql`) do NOT include:
- `idempotency_log` (nonce, action_type, player_id, payload_hash, response, expire_at)
- `pending_actions` (action_id, player_id, status enum, version int, created_at, recovered_at)
- `gm_action_log` (for AD12 rollback prev-info lookup)
- `inventory.slot` CHECK constraint (max 30 per P1.3)

**Action:** add `003_anti_dupe_schema.sql` + `003_anti_dupe_schema.down.sql` in Week 2.

---

## 5. Quantified compliance

| Dimension | Score | Note |
|-----------|-------|------|
| Plumbing (pool, connection, repositories) | 100% | OLD migrated as-is |
| Wrapper W1 (SERIALIZABLE battle txn) | 0% | not started |
| Wrapper W2 (REPEATABLE READ action) | 0% | not started |
| Wrapper W3 (optimistic status) | 0% | not started |
| Wrapper W4 (R68 snapshot) | ~40% | replay stream exists, need checksum helper |
| Wrapper W5 (AD1-AD12 + idempotency) | 0% | not started |
| Schema (idempotency_log + pending_actions + gm_action_log) | 0% | needs `003_*` migration |
| Verification runtime | 100% | `economy_integrity_verification_runtime` migrated |
| **Aggregate vs R44 5-wrapper acceptance ≥99%** | **~30%** | **BELOW threshold** |

---

## 6. Recommendation — Week 2 plan

1. **Day 1-2 (NEW):** implement `output/anti_dupe/anti_dupe.ts` per `cmd.md` § P1.1-P1.5 (~600 LOC). Includes `executeWithIdempotency` + AD1-AD12.
2. **Day 3 (NEW):** add `migrations/003_anti_dupe_schema.sql` (idempotency_log + pending_actions + gm_action_log + inventory CHECK).
3. **Day 4 (NEW):** wire W1/W2/W3 wrappers as composition over `executeWithIdempotency`. Document binding points for cmd-engine (combat lifecycle) + cmd-item (loot/transfer).
4. **Day 5 (NEW):** R68 `compute_state_checksum` helper on top of OLD `replay_event_stream` (1-day per audit memory).
5. **Day 6-7 (TEST):** unit test 12-item self-audit per `cmd.md` § acceptance + integration test cross-CMD.

**Estimated reach after Week 2:** 90-95% (4 gap defer per spec § BACKLOG).

---

## 7. Inter-CMD coordination flag

- **cmd-engine (CMD1):** combat W1 wrapper binding — em sẽ ship API `withBattleTxn(player_id, executor)`; CMD1 wraps `combatBegin` / `combatEnd`.
- **cmd-item (CMD2 self):** loot/transfer W2 wrapper binding — em handle internally.
- **cmd-quest (CMD3):** W2 binding cho quest-reward grant — em provide adapter signature.

Push alert `cmd-lead/alerts/cmd-db_alert_w2_below_threshold_20260518T140940Z.json` (separate ship, see § 8).

---

## 8. Honest verdict

Per CMD_DB v2.4.2 § acceptance threshold ≥99% (DB critical) and AUTO_START § EXIT criteria:

> **CMD2 Week 1 = MIGRATION DONE (100%)**
> **CMD2 Week 2 = R44 COMPLIANCE PARTIAL (~30% start, target 90-95% end-of-week)**
> **CMD2 Week 3 = VALIDATION against OLD 198 P11B + 53 Phase 13 tests + NEW anti_dupe tests**

R44 implementation cannot be a copy from OLD — it is NEW production hardening. Em ship Week 1 migration completion + flag Week 2 needs full NEW impl per `cmd.md` spec.

**END r44_compliance.md**
