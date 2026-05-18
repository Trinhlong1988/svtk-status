# R44 Cross-CMD Wire Coverage Report

> Generated: 2026-05-18T18:32:43.641Z
> Owner: CMD2 (cmd-db wire_tracker scanner)

## Summary

- CMD2 exports tracked: **16** symbols
- Sibling CMDs scanned: **19** (cmd-audio, cmd-boss, cmd-dialog, cmd-engine, cmd-event, cmd-icon, cmd-item, cmd-map, cmd-network, cmd-npc, cmd-parse, cmd-place, cmd-qa-art, cmd-qa-content, cmd-qa-core, cmd-qa-full, cmd-quest, cmd-skill, cmd-sprite)
- Total callsites discovered: **0**
- Expected wire matrix: **9** entries
- Coverage: **0/9 = 0%**

## Coverage by consumer CMD

| Consumer | Expected | Satisfied | Missing |
|----------|----------|-----------|---------|
| cmd-engine | 4 | 0 | 4 |
| cmd-item | 3 | 0 | 3 |
| cmd-quest | 1 | 0 | 1 |
| cmd-qa-core | 1 | 0 | 1 |

## Coverage by wrapper

| Wrapper | Consumers expected | Consumers satisfied |
|---------|--------------------|----------------------|
| W1 | cmd-engine, cmd-engine | *(none)* |
| W4 | cmd-engine, cmd-qa-core | *(none)* |
| W2 | cmd-engine, cmd-item, cmd-quest | *(none)* |
| P1.3 | cmd-item | *(none)* |
| W3 | cmd-item | *(none)* |

## ❌ Missing wire — expected but not found

| Consumer | Wrapper | Symbol | Reason |
|----------|---------|--------|--------|
| cmd-engine | W1 | `withBattleStart` | combat_runtime begin |
| cmd-engine | W1 | `withBattleEnd` | combat_runtime end |
| cmd-engine | W4 | `bindSnapshotToTxn` | R68 checksum bind after tick |
| cmd-engine | W2 | `withActionTxn` | skill_cast / item_use |
| cmd-item | W2 | `withActionTxn` | loot / trade |
| cmd-item | P1.3 | `pickupItem` | item pickup |
| cmd-item | W3 | `optimisticUpdate` | inventory_row version-aware update |
| cmd-quest | W2 | `withActionTxn` | reward_claim |
| cmd-qa-core | W4 | `verifySnapshotBinding` | replay divergence audit |


---

## How to add a new expected wire

Edit `CMD2_SYMBOLS` (if shipping new export) and `EXPECTED` (if a consumer CMD must adopt) in `callsite_scanner.mjs`, then re-run.

## Re-run

```bash
node cmd-db/output/wire_tracker/callsite_scanner.mjs
```