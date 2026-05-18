# R44 Concurrency Soak Suite — Day 5

DSN-gated test suite that exercises **true concurrency** paths that single-
connection tests cannot trigger. Companion to `r44_integration.test.ts`.

## Scenarios

| ID | Subject | Exercises |
|----|---------|-----------|
| **S1** | 8 parallel callers same nonce | idempotency convergence — only 1 executor invocation, ≥7 returns fromCache |
| **S2** | 8 parallel gold UPDATEs same player | SERIALIZABLE 40001 retry path + final balance exact |
| **S3** | 8 parallel `optimisticUpdate` same row | 1 winner + 7 `OptimisticConflictError` |
| **S4** | 8 parallel `ad12_rollback` same txn | 1 actual rollback + 7 `previously_rolled_back=true` cache hits |
| **S5** | 4 parallel `recoverStalePending` workers | `FOR UPDATE SKIP LOCKED LIMIT` partitions workload — total recovered = total seeded, no double-count |
| **S6** | 8 parallel mismatched payload + same nonce | exactly 8 spoof-detection errors (1st committer locks the payload hash) |

## Why this can't run on pg-mem

- `BEGIN ISOLATION LEVEL SERIALIZABLE` + retry on 40001 requires real Postgres MVCC + transaction conflict detection
- `FOR UPDATE SKIP LOCKED LIMIT N` inside a CTE is real-Postgres only
- jsonb `||` merge operator
- Real connection pool concurrency

## Run

```bash
# Local Postgres
export PG_TEST_DSN="postgres://postgres:postgres@localhost:5432/postgres"
node ./node_modules/vitest/vitest.mjs run cmd-db/output/integration/concurrency_soak.test.ts

# Docker
docker run --rm -d --name svtk_soak_pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
export PG_TEST_DSN="postgres://postgres:postgres@localhost:5432/postgres"
node ./node_modules/vitest/vitest.mjs run cmd-db/output/integration/
docker stop svtk_soak_pg
```

## Pool config (soak-specific override)

`withTestDb({ poolMax: 16, statementTimeoutMs: 10_000 })` — 16-connection pool
gives 8-way parallel callers + 8 headroom for harness operations. Statement
timeout bumped to 10s to accommodate 3× retry × exponential backoff worst case.

## Contention factor

`PARALLEL = 8` chosen because:
- Fits in 16-connection pool with headroom
- High enough to reliably trigger SERIALIZABLE conflicts on shared rows
- Low enough to keep wall-clock under 30s per scenario

To stress harder, bump `PARALLEL` in `concurrency_soak.test.ts` and re-run.

## Interpretation of S2 retry hit count

Console logs `[soak] S2 retry hits: N`. Postgres MVCC sometimes serializes
cheap UPDATEs without raising 40001 — N may be 0 even with true contention.
The deterministic assertion is the **final gold balance** (1000 + PARALLEL × 10
= 1080 when PARALLEL=8). That's the correctness contract; retry count is
diagnostic only.

## Adding new soak scenarios

Append `it.skipIf(skip)('S7 ...', async () => {})` block to
`concurrency_soak.test.ts`. Use `h.pool` and existing wrappers. Always seed
fresh state in the test body — `beforeAll` seed is shared across scenarios.

## Honest gaps

- **Latency/throughput benchmarking** — out of scope; build separate bench
  harness when capacity planning needed.
- **Long-duration drift** (>1 hour) — defer to release-candidate soak.
- **Cross-region replication** — out of scope until multi-region deployment.
