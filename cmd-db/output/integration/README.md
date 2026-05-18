# R44 Postgres integration test harness — cmd-db Week 2 Day 3

DSN-gated test harness that exercises the production-Postgres-only items the
pg-mem-based unit suites cannot reach. **Skips cleanly** when `PG_TEST_DSN` is
unset so CI without Postgres stays green.

## What's covered (gaps pg-mem cannot exercise)

| Gap | Spec | Test |
|-----|------|------|
| **A1/A2** SERIALIZABLE isolation + idempotency cache | CMD_DB v2.4.2 § P1.1 | `Gap A1`, `Gap A2` |
| **B1/B2** W1 SERIALIZABLE + W2 REPEATABLE READ wrappers | R44 W1/W2 | `Gap B1`, `Gap B2` |
| **C1** Schema CHECK `slot_index 0..29` | § P1.3 | `Gap C1` |
| **C2** `find_free_inventory_slot()` PL/pgSQL + `pickupItem` | § P1.3 | `Gap C2` |
| **D1** W3 `optimisticUpdate` against real `RETURNING` | R44 W3 | `Gap D1` |
| **E1** W4 jsonb `||` merge into `target_state` | R44 W4 | `Gap E1` |
| **F1** P1.5 `FOR UPDATE SKIP LOCKED LIMIT` in CTE | § P1.5 | `Gap F1` |
| **G1** BIGINT precision (gold > 2^53) — closes R3 bug-hunt finding | bug hunt R3 | `Gap G1` |
| **H1** Schema CHECK status enum | 003 migration | `Gap H1` |

## How to run

```bash
# Local Postgres (recommended for dev)
export PG_TEST_DSN="postgres://postgres:postgres@localhost:5432/svtk_test"
node ./node_modules/vitest/vitest.mjs run cmd-db/output/integration/r44_integration.test.ts

# Docker (one-liner)
docker run --rm -d --name svtk_test_pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
sleep 3
export PG_TEST_DSN="postgres://postgres:postgres@localhost:5432/postgres"
node ./node_modules/vitest/vitest.mjs run cmd-db/output/integration/
docker stop svtk_test_pg
```

## Schema isolation

Every `withTestDb()` call:
1. Creates a unique schema `r44_test_<random hex>`.
2. Pins `search_path = '<schema>, public'` on every pooled connection.
3. Applies migrations `001_init.sql` → `002_progression_snapshots.sql` → `003_anti_dupe_schema.sql` in order.
4. Returns `{ pool, schema, cleanup }`.

Always call `cleanup()` in `afterAll` / `afterEach` — drops the schema CASCADE
and closes the pool. Concurrent tests against the same DSN are safe (separate
schemas, no cross-test state).

## Pool config

| Setting | Value | Why |
|---------|-------|-----|
| `max` | 4 | small enough to debug concurrency, large enough to exercise SERIALIZABLE conflict paths |
| `statement_timeout` | 5000 ms | catches infinite-loop tests fast |
| `application_name` | `r44_test_<schema>` | trace per-test traffic in `pg_stat_activity` |

## CI integration suggestion

Add a workflow step that boots `postgres:16` as a service container, then runs
`vitest run cmd-db/output/integration/`. The skip-when-no-DSN behavior means
the same test file works in both modes — no separate config.

## Honest gaps

- Tests do NOT exercise true concurrency conflict (would need two parallel
  Pool clients colliding on a SERIALIZABLE row lock to trigger 40001 retry).
  Add a `concurrency.test.ts` separately when needed; current suite verifies
  the wrapper signatures + happy paths + schema constraints.
- The `Gap G1` BIGINT test seeds gold *past* Number.MAX_SAFE_INTEGER but only
  reverts one transaction's worth — full whale-account roundtrip stress
  belongs in a soak suite.
- pg-mem unit tests + this integration suite are complementary: together they
  cover the full Day 1 + Day 2 ship.
