# R44 Cross-CMD Wire Callsite Tracker — owned by CMD2

Day 4 deliverable. Closes the **last 5%** of R44 compliance: verifies which
consumer CMDs have actually wired CMD2's W1/W2/W3/W4/AD12 wrappers vs which
are still missing.

## Files

| File | Purpose |
|------|---------|
| `callsite_scanner.mjs` | The scanner — runnable from repo root |
| `callsite_inventory.json` | All callsites discovered (consumer × symbol × file:line) |
| `missing_alerts.json` | Expected-but-not-found wire (coverage gap) |
| `coverage_report.md` | Human-readable coverage matrix |

## Run

```bash
node cmd-db/output/wire_tracker/callsite_scanner.mjs
```

Idempotent — re-running overwrites the 3 outputs. CMD5 LEAD can poll on a
schedule (suggested: every cmd-engine/cmd-item/cmd-quest commit cycle).

## What it tracks

**CMD2 export inventory** (16 symbols across 5 wrappers):
- W1: `withBattleStart`, `withBattleEnd`
- W2: `withActionTxn` + `W2ActionType`
- W3: `optimisticUpdate`, `OptimisticConflictError`
- W4: `bindSnapshotToTxn`, `verifySnapshotBinding`
- W5/P1.x core: `executeWithIdempotency`, `ad12_rollback`, `pickupItem`, `computePayloadHash`, `canonicalStringify`, `stringifyBigIntSafe`, `reviveBigIntSafe`
- P1.5 cron: `recoverStalePending`, `startStalePendingScheduler`

**Expected wire matrix** (9 entries per `CMD_ROLE_BINDING_v2.8.0.md` § II):
- `cmd-engine`: W1 begin/end + W4 R68 + W2 skill/item_use
- `cmd-item`:   W2 loot/trade + P1.3 pickupItem + W3 optimistic
- `cmd-quest`:  W2 reward_claim
- `cmd-qa-core`: W4 verifySnapshotBinding

## How to extend

When CMD2 ships a new wrapper, add to `CMD2_SYMBOLS` in `callsite_scanner.mjs`.
When a consumer CMD must adopt a wrapper, add to `EXPECTED`. Re-run scanner.

## Coverage interpretation

| Coverage | Action |
|----------|--------|
| 100% | R44 wire complete — close R44 alert |
| ≥80% but <100% | continue Week 2 — ship alerts to missing CMDs |
| <50% | escalate to cmd-lead — wire blocker for Week 3 validation |

Current snapshot: see `coverage_report.md`.
