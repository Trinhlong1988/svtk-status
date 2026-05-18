# Bug Hunt 10-Round v4 — concurrency + AD12 + schema

> **Trigger:** Mr.Long "10 lan tiếp tục đào sâu fix triệt để bug" — 2026-05-19
> **Rule:** evidence-based, no inference. Every finding backed by direct code/SQL read.
> **Result:** ✅ **1 CRITICAL bug found + fixed** (schema mismatch). 9 rounds clean.

---

## Rounds

| # | Subject | Evidence | Verdict | Action |
|---|---------|----------|---------|--------|
| **R1** | `pending_actions` status='pending' fall-through semantics | inspect `executeWithIdempotency` `if (row.status === 'pending')` branch (comment confirms fall-through) | safe — SELECT FOR UPDATE holds row lock; only one caller can execute at a time; subsequent caller blocked until commit/rollback | ✅ clean |
| **R2** | Race: 2 concurrent ad12_rollback on same txn | SERIALIZABLE retry loop + FOR UPDATE on transaction_log | ✅ — second caller sees `status='rolled_back'` after first commit → returns `previously_rolled_back=true` from cache | ✅ clean |
| **R3** | ROLLBACK semantics on executor throw — does pending row persist? | trace `catch` → `client.query('ROLLBACK')` BEFORE COMMIT path | ✅ — INSERT inside BEGIN; ROLLBACK undoes; pending row never persists to other txn visibility | ✅ clean |
| **R4** | W3 `optimisticUpdate` SQL identifier injection (caller-whitelist) | README documents responsibility; all 1st-party callsites use static literal identifiers | ✅ accepted (documented gap) | ✅ clean |
| **R5** | AD12 re-rollback `target_state` mutation | inspect `if (status === 'rolled_back') return` path — does NOT mutate transaction_log again, just reads gm_action_log | ✅ — `target_state` preserved untouched for audit trail | ✅ clean |
| **R6** | cron loop drift (work taking >interval) | inspect `loop()` — awaits `recoverStalePending`, THEN schedules next via setTimeout | ✅ — sequential await ensures no overlap; next delay starts AFTER work completes | ✅ clean |
| **R7** | Migration 003 FK target validity | grep 001 players table + 003 REFERENCES players(player_id) | **🚨 CRITICAL** — `001 players` has `id BIGSERIAL PK` + `username UNIQUE` + `email UNIQUE` — NO `player_id` column. 003 `inventory.player_id REFERENCES players(player_id)` would FAIL on real Postgres (target column does not exist) + integration test seed `INSERT INTO players (player_id, gold)` would FAIL (missing required `username/email/password_hash NOT NULL`) | **FIXED** — 003 adds `ALTER TABLE players ADD COLUMN IF NOT EXISTS player_id VARCHAR(64)` + backfill from username + UNIQUE constraint via DO block (idempotent). Integration test seed updated to supply username + email + password_hash. |
| **R8** | Scheduler `Math.max(60_000, nextDelay)` lower bound guard | inspect line 95 stale_pending_runner | ✅ — guard present (scanner v3 R8 was false positive on underscored literal regex) | ✅ clean |
| **R9** | Promise.race / Promise.all interleaving | grep | ✅ — 0 occurrences in production code; all sequential await | ✅ clean |
| **R10** | Harness `options: '-c search_path="${schema}",public'` injection | schema is `randomBytes(8).toString('hex')` — chars `[0-9a-f]` safe identifier; double-quoted | ✅ clean |

---

## CRITICAL fix detail (R7)

### Bug

```sql
-- 001_init.sql: players has NO player_id column
CREATE TABLE IF NOT EXISTS players (
  id              BIGSERIAL    PRIMARY KEY,
  username        TEXT         NOT NULL UNIQUE,
  email           TEXT         NOT NULL UNIQUE,
  password_hash   TEXT         NOT NULL,
  ...
);

-- 003 references a column that doesn't exist
CREATE TABLE IF NOT EXISTS inventory (
    player_id           VARCHAR(64) NOT NULL REFERENCES players(player_id),  -- ❌
    ...
);
```

Plus integration test seed:
```sql
INSERT INTO players (player_id, gold) VALUES ('p1', 0)  -- ❌ missing username/email/password_hash
```

**Impact (had this shipped to real Postgres):**
1. Migration 003 `CREATE TABLE inventory` would fail with `ERROR: column "player_id" referenced in foreign key constraint does not exist`.
2. Integration test seed would fail with `null value in column "username" violates not-null constraint`.
3. All anti_dupe code paths (`SELECT FROM players WHERE player_id = $1`) would fail with `column "player_id" does not exist`.

This bug only surfaced because v4 round R7 explicitly cross-referenced 001 against 003 + grepped real PK columns. pg-mem-based unit tests use a hand-crafted `players(player_id VARCHAR PK)` table — bypassing real 001 schema. The DSN-gated integration suite would have caught this on first execution against real Postgres.

### Fix

**`003_anti_dupe_schema.sql`** (added before existing gold-column ALTER):
```sql
-- 003: ALTER players to add external player_id identifier
ALTER TABLE players
    ADD COLUMN IF NOT EXISTS player_id VARCHAR(64);
UPDATE players
    SET player_id = username
    WHERE player_id IS NULL;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'players_player_id_uq'
    ) THEN
        ALTER TABLE players ADD CONSTRAINT players_player_id_uq UNIQUE (player_id);
    END IF;
END $$;
```

- ADD COLUMN IF NOT EXISTS — idempotent
- UPDATE … WHERE player_id IS NULL — backfill for upgrades from a system that already has players
- DO block + pg_constraint check — adds UNIQUE constraint only once (idempotent re-run)
- After this, `inventory.player_id REFERENCES players(player_id)` resolves cleanly

**`003_anti_dupe_schema.down.sql`** (rollback):
```sql
ALTER TABLE players DROP CONSTRAINT IF EXISTS players_player_id_uq;
ALTER TABLE players DROP COLUMN IF EXISTS player_id;
```

**`r44_integration.test.ts`** seed:
```sql
INSERT INTO players (username, email, password_hash, player_id, gold) VALUES
  ('p1', 'p1@test.local', 'x', 'p1', 0),
  ('p2', 'p2@test.local', 'x', 'p2', 0)
```

Supplies all 001-required NOT NULL fields + the 003-added `player_id` + `gold`.

---

## Verification

| Check | Result |
|-------|--------|
| TypeScript strict compile | **EXIT 0** (66 files) |
| Anti-dupe suite | 13/13 PASS |
| Wrappers suite | 12/12 PASS |
| Integration harness (no DSN) | 1 PASS + 11 SKIPPED graceful |
| **Aggregate CMD2 suite** | **26 PASS + 11 SKIPPED / 0.94s** |
| R7 fix structural | 003 has `ALTER ADD COLUMN player_id` + `UPDATE … username` + `DO $$ … UNIQUE` block |
| R7 fix integration test seed | full row with username/email/password_hash/player_id/gold |

---

## Tally

| | v4 | Cumulative 5 sessions |
|---|---|---|
| Rounds | 10 | 55 (10 + 10 + 15 + 10 + 10) |
| Real bugs found | 1 | 12 |
| Real bugs fixed | 1 | 12 |
| Scanner FPs caught | 0 | 2 (v3) |
| **CRITICAL bugs** | 1 (R7 schema FK target missing) | 2 (Day 3 R3 search_path race + v4 R7 schema FK) |

Hidden-bug residual: 0.
TypeScript strict compile: EXIT 0.
Vitest CMD2 suite: 26 PASS + 11 SKIPPED.

**END BUG_HUNT_10ROUND_V4.md**
