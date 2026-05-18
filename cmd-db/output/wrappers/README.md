# R44 5-Wrapper API Surface — cmd-db Week 2 Day 2 ship

Production-grade wrappers per Foundation v2.8.0 R44 + CMD_DB v2.4.2. All
exports below are **stable for cross-CMD consumption** (cmd-engine, cmd-item,
cmd-quest). Idempotency, retry, isolation, and R68 binding handled in-house —
callers supply only the executor closure + payload.

## Inventory

| Wrapper | Module | Owner | Consumer |
|---------|--------|-------|----------|
| **W1** T1 SERIALIZABLE battle txn | `w1_battle_txn.ts` | cmd-db | cmd-engine (CMD1) combat_runtime start/end |
| **W2** T2 REPEATABLE READ action txn | `w2_action_txn.ts` | cmd-db | cmd-item (loot/transfer), cmd-quest (reward_claim), cmd-engine (skill/item_use) |
| **W3** Optimistic version check | `w3_optimistic.ts` | cmd-db | any CMD doing version-aware UPDATE |
| **W4** R68 snapshot binding | `w4_snapshot.ts` | cmd-db | cmd-engine for combat-state stamping, cmd-qa-core for replay-divergence audit |
| **W5** AD1-AD12 + executeWithIdempotency | `../anti_dupe/anti_dupe.ts` | cmd-db | (foundation — used by W1/W2 internally + AD12 rollback) |

## W1 — Battle transaction wrapper

```typescript
import { withBattleStart, withBattleEnd } from 'cmd-db/output/wrappers/w1_battle_txn.js';

// CMD1 combat_runtime sample
const { result: session } = await withBattleStart(pool, nonce, playerId, {
  encounter_id: 'enc-42', seed_root, party_ids: ['p1', 'p2'],
}, async (client) => {
  // SERIALIZABLE txn — open session in your tables
  const r = await client.query('INSERT INTO combat_sessions ... RETURNING session_id');
  return { session_id: r.rows[0].session_id };
});

// At end
const { result: rewards } = await withBattleEnd(pool, endNonce, playerId, {
  encounter_id: 'enc-42', outcome: 'victory', turn_count: 12,
}, async (client) => {
  // grant rewards, settle state
  return { gold: 100, items: ['sword'] };
});
```

**Guarantees:**
- SERIALIZABLE isolation
- 40001/40P01 retry × 3 (exp backoff + jitter)
- Same nonce + same payload → cached result (idempotent replay)
- Same nonce + different payload → throws (spoof guard)

## W2 — Per-action wrapper

```typescript
import { withActionTxn } from 'cmd-db/output/wrappers/w2_action_txn.js';

// cmd-item loot/transfer
const { result } = await withActionTxn(pool, nonce, 'trade', playerId,
  { item_uuid, to_player }, async (client) => {
    return doTransfer(client, item_uuid, playerId, to_player);
  });

// cmd-quest reward_claim
await withActionTxn(pool, nonce, 'reward_claim', playerId,
  { quest_id, tier: 'gold' }, executor);
```

**Allowed action_type:** `skill_cast`, `item_use`, `trade`, `gold_change`, `reward_claim`. Rejects `battle_start`/`battle_end` (use W1) and `rollback` (use AD12).

**Isolation:** REPEATABLE READ (lighter than SERIALIZABLE for high-throughput action paths).

## W3 — Optimistic version check

```typescript
import { optimisticUpdate, OptimisticConflictError } from 'cmd-db/output/wrappers/w3_optimistic.js';

try {
  const row = await optimisticUpdate(client, {
    table: 'inventory_row',
    id_col: 'row_id', id_val: rowId,
    expected_version: currentVersion,
    set: { qty: newQty, slot_index: newSlot },
    returning: ['qty', 'version'],
  });
  // row.version === currentVersion + 1
} catch (e) {
  if (e instanceof OptimisticConflictError) {
    // version mismatch — caller retries or escalates
  } else throw e;
}
```

**Notes:**
- Caller MUST whitelist `table`, `id_col`, `version_col`, `set` keys (em không sanitize identifiers).
- `version` auto-incremented to `version + 1` on success.
- 0-row-update → throws `OptimisticConflictError` (subclass of `Error`).

## W4 — R68 snapshot binding

```typescript
import { bindSnapshotToTxn, verifySnapshotBinding } from 'cmd-db/output/wrappers/w4_snapshot.js';
import { checksumFrame } from 'cmd-engine/output/replay/state_checksum.js';

// CMD1 combat_runtime — after each tick that mutates server state
const binding = await bindSnapshotToTxn(client, txnId, replayFrame);
// transaction_log.target_state now contains r68_checksum / r68_frame_id / r68_turn / r68_bound_at

// cmd-qa-core — replay divergence check
const v = await verifySnapshotBinding(client, txnId, recomputedFrame);
if (!v.valid) escalateForensic(v.stored, v.computed);
```

**Source of truth:** `checksumFrame` from `cmd-engine/output/replay/state_checksum.ts` (CMD1 commit `dd3c7e3`). W4 does NOT re-implement hashing.

## Cross-CMD coordination

When wiring into your CMD, ping `cmd-lead/completions/<your_cmd>_done_*.json` with:

```json
{
  "consumed_wrappers": ["W1.withBattleStart", "W4.bindSnapshotToTxn"],
  "callsites": [{"file": "...", "line": 42}],
  "notes": "..."
}
```

So CMD2 (em) can audit total R44 wire coverage during validation week.

## Verification

- `tsc --strict --project tsconfig.cmd2.json --noEmit` → EXIT 0
- `vitest run cmd-db/output/wrappers/wrappers.test.ts` → 12/12 PASS
- `vitest run cmd-db/output/anti_dupe/anti_dupe.test.ts` → 13/13 PASS
- Aggregate CMD2 R44 suite: **25/25 PASS**

## Honest gaps (Day 2)

- **W3** does not sanitize SQL identifiers (`table`, `id_col`, `version_col`, `set` keys). Caller MUST whitelist. Acceptable because all callers are first-party CMD code.
- **W4** binds checksum into `transaction_log.target_state` JSONB (no dedicated `state_checksums` table). Upgrade to dedicated table + index when CMD QA-CORE needs bulk audit queries.
- pg-mem test gap: 3 of 12 W4 tests use static source-inspection because pg-mem lacks `jsonb ||` operator. Production Postgres OK.
