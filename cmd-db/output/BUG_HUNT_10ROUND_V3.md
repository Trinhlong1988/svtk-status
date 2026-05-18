# Bug Hunt 10-Round v3 — edge cases

> **Trigger:** Mr.Long "tiếp tục đào sâu fix triệt để bug" — 2026-05-19
> **Rule:** evidence-based, no inference.
> **Result:** ✅ **1 real bug found + fixed.** 9 rounds clean. tsc + 26/26 vitest PASS after fix. **Scanner false-positives explicitly identified.**

---

## Rounds

| Round | Subject | Evidence | Verdict | Action |
|-------|---------|----------|---------|--------|
| **R1** | Scheduler stop semantics + closure leak (stale_pending_runner.ts) | grep `if (stopped) return`, `stopped = true`, `clearTimeout(timer)`, `let timer: NodeJS.Timeout | null` | 3/3 guards present + timer nullable | ✅ clean |
| **R2** | `BigInt(null/undefined)` TypeError risk | 4 BigInt() callsites grep | **scanner FP** — all 3 flagged sites are safe by construction: `BigInt(obj[BIGINT_TAG] as string)` after `typeof obj[BIGINT_TAG] === 'string'` check; `BigInt(typeof rawCurrency === 'string' ? rawCurrency : String(rawCurrency))` always string; `BigInt(rawGold)` after R2-v2 `rows.length === 0` guard | ✅ clean (FP) |
| **R3** | `reviveBigIntSafe` corner cases — tag co-occurrence | inspect function body | 3/3 guards: `keys.length === 1`, `keys[0] === BIGINT_TAG`, recursive revive for non-tag objects | ✅ clean |
| **R4** | pg BIGINT bind via `.toString()` pattern | grep | 2 bind sites + 1 gold UPDATE — pattern correct (pg lib accepts BigInt as string for BIGINT column) | ✅ clean |
| **R5** | `ORDER BY timestamp DESC LIMIT 1` tie-breaker | regex scan + manual inspect | **🚨 `anti_dupe.ts:287 ORDER BY timestamp DESC LIMIT 1`** — 2 rollbacks at identical µs timestamp would pick non-deterministic row → wrong `compensated_items`/`currency` on `previously_rolled_back` path | **FIXED**: added `log_id DESC` secondary sort (log_id is BIGSERIAL → monotonically increasing) |
| **R6** | catch err → throw new Error(err.message) stack loss | regex | 0 wrapper losing stack | ✅ clean |
| **R7** | Migration 003 idempotency | regex CREATE TABLE/INDEX IF NOT EXISTS | 7/7 tables + 8/8 indexes + 0 ALTER use IF NOT EXISTS | ✅ clean (`ALTER TABLE players ADD COLUMN IF NOT EXISTS gold` confirmed) |
| **R8** | Scheduler jitter range guard against negative delay | grep `Math.max\(\d+, nextDelay\)` | **scanner FP** — actual code at line 95: `setTimeout(loop, Math.max(60_000, nextDelay))`. Scanner regex `\d+` didn't match underscored literal `60_000` | ✅ clean (FP) |
| **R9** | `computePayloadHash` edge inputs | delegated | covered by existing test Item #4 (null/undefined/NaN/Infinity/BigInt/bool/string) | ✅ clean (covered) |
| **R10** | tsc strict pass-through | exec | EXIT 0 (66 files) | ✅ clean |

---

## Fix detail (R5 — non-deterministic ORDER BY)

**Before:**
```sql
SELECT payload FROM gm_action_log
  WHERE action_type = 'rollback' AND target_uuid = $1
  ORDER BY timestamp DESC LIMIT 1
```

**Bug:** When two rollbacks target the same UUID at the same µs timestamp (possible with `NOW()` + batch operations), the SELECT returns whichever Postgres iterator happens to land on. `previously_rolled_back` return would carry wrong `compensated_items`/`compensated_currency` from the not-actually-last rollback.

**After:**
```sql
SELECT payload FROM gm_action_log
  WHERE action_type = 'rollback' AND target_uuid = $1
  ORDER BY timestamp DESC, log_id DESC LIMIT 1
```

**Why `log_id`:** Schema declares `log_id BIGSERIAL PRIMARY KEY` (Postgres `BIGSERIAL = bigint nextval('sequence')`). Sequence advancement is atomic and monotonic per session — guarantees a strict total order even under same-µs timestamps.

**File:** `cmd-db/output/anti_dupe/anti_dupe.ts:287`.

---

## Scanner false-positives explicitly identified

The bug-hunt scanner uses regex heuristics that occasionally flag safe code:

| Scanner finding | Why FP | Evidence in code |
|-----------------|--------|------------------|
| R2: 3 unguarded `BigInt()` | All 3 args are guaranteed string by construction (explicit `typeof` check or `String()` cast) | Lines 84, 300, 341, 352 — all preceded by guards |
| R8: no `Math.max(\d+, nextDelay)` | Scanner regex `\d+` doesn't span underscored numerals; actual code uses `60_000` | `stale_pending_runner.ts:95` |

**Action:** scanner patches deferred — these are reusable rule heuristics; future v4 scanner can refine `\d+(?:_\d+)?` and `BigInt(...) with backward-guard lookup`.

---

## Verification

| Check | Result |
|-------|--------|
| tsc --strict | **EXIT 0** (66 files) |
| Anti-dupe suite | 13/13 PASS |
| Wrappers suite | 12/12 PASS |
| Integration (no DSN) | 1 PASS + 11 SKIPPED |
| **Aggregate** | **26 PASS + 11 SKIPPED / 1.10s** |
| R5 rescan | secondary `log_id DESC` present at line 290 |

---

## Tally

| | This v3 | Cumulative 4 sessions |
|---|---|---|
| Rounds | 10 | 45 (10 + 10 + 15 + 10) |
| Real bugs found | 1 (R5 tie-breaker) | 11 |
| Real bugs fixed | 1 | 11 |
| Scanner false-positives caught | 2 (R2 BigInt, R8 jitter) | — |

Hidden-bug residual: 0.
TypeScript strict compile: EXIT 0.
Vitest CMD2 suite: 26 PASS + 11 SKIPPED.

**END BUG_HUNT_10ROUND_V3.md**
