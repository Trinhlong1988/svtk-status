/**
 * R44 integration tests — real Postgres, exercises the gaps pg-mem cannot cover.
 * Skipped cleanly when PG_TEST_DSN is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harnessAvailable, SKIP_REASON, withTestDb, type HarnessHandle } from './test_harness.js';
import {
  executeWithIdempotency,
  ad12_rollback,
  pickupItem,
} from '../anti_dupe/anti_dupe.js';
import { withBattleStart, withBattleEnd } from '../wrappers/w1_battle_txn.js';
import { withActionTxn } from '../wrappers/w2_action_txn.js';
import { optimisticUpdate, OptimisticConflictError } from '../wrappers/w3_optimistic.js';
import { bindSnapshotToTxn, verifySnapshotBinding } from '../wrappers/w4_snapshot.js';
import { recoverStalePending } from '../cron/stale_pending_runner.js';
import type { ReplayFrame } from '../../../cmd-engine/output/legacy/replay_frame.js';

const skip = !harnessAvailable();

function makeFrame(turn: number, frameId: string): ReplayFrame {
  return {
    frameId,
    schemaVersion: 1,
    sessionId: 's1',
    encounterId: 'e1',
    turn,
    statusDeltas: [],
    snapshot: { participants: [] },
    deterministicHash: 'h',
    eventCounts: { damage: 0, heal: 0, status: 0 },
    monotonicNs: BigInt(turn * 1000),
  } as unknown as ReplayFrame;
}

describe.skipIf(skip)('R44 Postgres integration', () => {
  let h: HarnessHandle;

  beforeAll(async () => {
    h = await withTestDb();
    // Seed: a player + an item in 'dropped' location
    await h.pool.query(
      `INSERT INTO players (player_id, gold) VALUES ('p1', 0), ('p2', 0)`,
    );
  }, 30_000);

  afterAll(async () => {
    if (h) await h.cleanup();
  });

  // ── P1.1 + P1.2 ────────────────────────────────────────────────
  it('Gap A1 — executeWithIdempotency runs against real SERIALIZABLE txn', async () => {
    const nonce = randomUUID();
    const r = await executeWithIdempotency(h.pool, nonce, 'trade', 'p1', { x: 1 },
      async (client) => {
        const r = await client.query("SELECT 'hello' AS msg");
        return { msg: r.rows[0].msg };
      });
    expect(r.fromCache).toBe(false);
    expect(r.result.msg).toBe('hello');
  });

  it('Gap A2 — idempotent replay returns fromCache=true on real Postgres', async () => {
    const nonce = randomUUID();
    await executeWithIdempotency(h.pool, nonce, 'trade', 'p1', { x: 1 },
      async () => ({ first: true }));
    const r2 = await executeWithIdempotency(h.pool, nonce, 'trade', 'p1', { x: 1 },
      async () => ({ second: true }));
    expect(r2.fromCache).toBe(true);
    expect(r2.result).toEqual({ first: true });
  });

  // ── W1 / W2 ────────────────────────────────────────────────────
  it('Gap B1 — W1 withBattleStart + withBattleEnd cycle', async () => {
    const startNonce = randomUUID();
    const endNonce = randomUUID();
    const s = await withBattleStart(h.pool, startNonce, 'p1', {
      encounter_id: 'enc-1', seed_root: 'sr', party_ids: ['p1'],
    }, async () => ({ session_id: 'sess-1' }));
    expect(s.result.session_id).toBe('sess-1');
    const e = await withBattleEnd(h.pool, endNonce, 'p1', {
      encounter_id: 'enc-1', outcome: 'victory', turn_count: 10,
    }, async () => ({ rewards: { gold: 50 } }));
    expect(e.result.rewards.gold).toBe(50);
  });

  it('Gap B2 — W2 REPEATABLE READ action wrap', async () => {
    const r = await withActionTxn(h.pool, randomUUID(), 'skill_cast', 'p1',
      { skill_id: 'fireball' }, async () => ({ damage: 100 }));
    expect(r.result.damage).toBe(100);
  });

  // ── P1.3 inventory CHECK + pickupItem ──────────────────────────
  it('Gap C1 — schema CHECK rejects slot_index out of range 0..29', async () => {
    const itemUuid = randomUUID();
    await h.pool.query(
      `INSERT INTO item_instances (item_uuid, item_id, location)
       VALUES ($1, 'sword', 'dropped')`, [itemUuid]);
    // Direct violating insert must fail
    await expect(h.pool.query(
      `INSERT INTO inventory (player_id, item_uuid, slot_index) VALUES ('p1', $1, 30)`,
      [itemUuid])).rejects.toThrow(/check constraint|violates/i);
  });

  it('Gap C2 — find_free_inventory_slot + pickupItem fill from slot 0 upward', async () => {
    const itemA = randomUUID();
    await h.pool.query(
      `INSERT INTO item_instances (item_uuid, item_id, location)
       VALUES ($1, 'sword_A', 'dropped')`, [itemA]);
    const r = await pickupItem(h.pool, itemA, 'p1', randomUUID());
    expect(r.success).toBe(true);
    expect(r.slot).toBeGreaterThanOrEqual(0);
    expect(r.slot).toBeLessThanOrEqual(29);
  });

  // ── W3 ─────────────────────────────────────────────────────────
  it('Gap D1 — W3 optimisticUpdate increments version + conflict throws', async () => {
    // Use item_instances.version as the optimistic version column
    const itemUuid = randomUUID();
    await h.pool.query(
      `INSERT INTO item_instances (item_uuid, item_id, location, version)
       VALUES ($1, 'gem', 'inventory', 0)`, [itemUuid]);

    const client = await h.pool.connect();
    try {
      const row = await optimisticUpdate<{ item_uuid: string; version: number }>(client, {
        table: 'item_instances',
        id_col: 'item_uuid', id_val: itemUuid,
        expected_version: 0,
        set: { location: 'auction' },
        returning: ['item_uuid', 'version'],
      });
      expect(Number(row.version)).toBe(1);

      // Stale version → conflict
      await expect(optimisticUpdate(client, {
        table: 'item_instances',
        id_col: 'item_uuid', id_val: itemUuid,
        expected_version: 0,  // stale
        set: { location: 'mail' },
      })).rejects.toBeInstanceOf(OptimisticConflictError);
    } finally { client.release(); }
  });

  // ── W4 jsonb || merge ─────────────────────────────────────────
  it('Gap E1 — W4 bindSnapshotToTxn merges r68_* into existing target_state jsonb', async () => {
    const txnId = randomUUID();
    await h.pool.query(
      `INSERT INTO transaction_log (txn_id, txn_type, target_type, target_state)
       VALUES ($1, 'trade', 'item', '{"caller_field":"keep"}'::jsonb)`, [txnId]);
    const frame = makeFrame(7, 'f-7');
    const client = await h.pool.connect();
    try {
      const b = await bindSnapshotToTxn(client, txnId, frame);
      expect(b.checksum).toMatch(/^[0-9a-f]{64}$/);
    } finally { client.release(); }

    const r = await h.pool.query(
      `SELECT target_state->>'r68_checksum' AS c,
              target_state->>'caller_field' AS keep,
              (target_state->>'r68_turn')::int AS t
       FROM transaction_log WHERE txn_id = $1`, [txnId]);
    expect(r.rows[0].c).toMatch(/^[0-9a-f]{64}$/);
    expect(r.rows[0].keep).toBe('keep');  // jsonb || preserved
    expect(r.rows[0].t).toBe(7);

    const verifyClient = await h.pool.connect();
    try {
      const v = await verifySnapshotBinding(verifyClient, txnId, frame);
      expect(v.valid).toBe(true);
    } finally { verifyClient.release(); }
  });

  // ── P1.5 FOR UPDATE SKIP LOCKED LIMIT in CTE ──────────────────
  it('Gap F1 — recoverStalePending marks expired pending → failed (real SQL)', async () => {
    await h.pool.query(
      `INSERT INTO pending_actions (nonce, action_type, player_id, payload, payload_hash,
                                    status, expires_at)
       VALUES ('stale-' || gen_random_uuid()::text, 'trade', 'p1',
               '{}'::jsonb, repeat('a', 64), 'pending',
               NOW() - INTERVAL '1 hour')`);
    const r = await recoverStalePending(h.pool);
    expect(r.recovered).toBeGreaterThanOrEqual(1);
    expect(r.current_stats.failed).toBeGreaterThanOrEqual(1);
  });

  // ── BIGINT precision roundtrip ─────────────────────────────────
  it('Gap G1 — ad12_rollback BIGINT roundtrip survives gold > Number.MAX_SAFE_INTEGER', async () => {
    // Seed: a committed gold_change txn for p1 with delta past 2^53
    const txnId = randomUUID();
    const bigDelta = (BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1000)).toString();
    await h.pool.query(`UPDATE players SET gold = $1::bigint WHERE player_id = 'p1'`, [bigDelta]);
    await h.pool.query(
      `INSERT INTO transaction_log (txn_id, txn_type, player_id, target_type, source_state, status)
       VALUES ($1, 'gold_change', 'p1', 'currency',
               jsonb_build_object('delta', $2::bigint), 'committed')`,
      [txnId, bigDelta]);
    const r = await ad12_rollback(h.pool, txnId, 'gm1', 'big-rollback');
    expect(r.success).toBe(true);
    // Verify gold reverted (Big-precision math: subtract bigDelta back)
    const after = await h.pool.query("SELECT gold FROM players WHERE player_id = 'p1'");
    expect(BigInt(after.rows[0].gold)).toBe(0n);
  });

  // ── Schema status enum CHECK ──────────────────────────────────
  it('Gap H1 — schema CHECK rejects invalid pending_actions.status', async () => {
    await expect(h.pool.query(
      `INSERT INTO pending_actions (nonce, action_type, player_id, payload, payload_hash,
                                    status, expires_at)
       VALUES ('x', 'trade', 'p1', '{}'::jsonb, repeat('a', 64), 'banana', NOW() + INTERVAL '1 hour')`,
    )).rejects.toThrow(/check constraint|violates/i);
  });
});

// Reflection — confirm the suite was wired even when skipped
describe('R44 Postgres integration — harness availability', () => {
  it('reports availability based on PG_TEST_DSN', () => {
    if (skip) {
      console.log(`[integration suite SKIPPED] ${SKIP_REASON}`);
    }
    expect(typeof harnessAvailable()).toBe('boolean');
  });
});
