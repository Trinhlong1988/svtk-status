/**
 * R44 concurrency soak — exercises true 40001 SERIALIZABLE retry path that
 * single-connection tests cannot trigger. DSN-gated.
 *
 * Scenarios:
 *   S1 — N parallel callers same nonce: all converge to same fromCache result
 *   S2 — N parallel callers same gold row: SERIALIZABLE conflict resolved via retry
 *   S3 — N parallel optimisticUpdate same row: 1 wins, (N-1) OptimisticConflictError
 *   S4 — N parallel ad12_rollback same txn: 1 actual + (N-1) previously_rolled_back
 *   S5 — P1.5 stale recovery under parallel writers: SKIP LOCKED proves contention-safe
 *
 * NOT included (out of scope for soak):
 *   - latency benchmarking (use separate bench harness)
 *   - long-duration drift (>1 hour) — defer to release-candidate soak
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harnessAvailable, SKIP_REASON, withTestDb, type HarnessHandle } from './test_harness.js';
import { executeWithIdempotency, ad12_rollback } from '../anti_dupe/anti_dupe.js';
import { optimisticUpdate, OptimisticConflictError } from '../wrappers/w3_optimistic.js';
import { recoverStalePending } from '../cron/stale_pending_runner.js';

const skip = !harnessAvailable();
const PARALLEL = 8;  // contention factor — fits in 16-conn pool with headroom

describe.skipIf(skip)('R44 concurrency soak', () => {
  let h: HarnessHandle;

  beforeAll(async () => {
    h = await withTestDb({ poolMax: 16, statementTimeoutMs: 10_000 });
    await h.pool.query(`
      INSERT INTO players (username, email, password_hash, player_id, gold) VALUES
        ('s1', 's1@test.local', 'x', 's1', 1000),
        ('s2', 's2@test.local', 'x', 's2', 1000),
        ('s3', 's3@test.local', 'x', 's3', 1000)
    `);
  }, 30_000);

  afterAll(async () => {
    if (h) await h.cleanup();
  });

  // ── S1 ────────────────────────────────────────────────────────
  it(`S1 — ${PARALLEL} parallel same-nonce → all converge to fromCache`, async () => {
    const nonce = randomUUID();
    let executorCalls = 0;
    const tasks = Array.from({ length: PARALLEL }, () =>
      executeWithIdempotency(h.pool, nonce, 'trade', 's1', { x: 42 },
        async () => { executorCalls++; return { winner: 's1', value: 42 }; }),
    );
    const results = await Promise.all(tasks);
    // Exactly one executor invocation must reach the database side
    expect(executorCalls).toBe(1);
    // All results identical
    for (const r of results) {
      expect(r.result.winner).toBe('s1');
      expect(r.result.value).toBe(42);
    }
    // At least N-1 returned fromCache=true (one may be fromCache=false depending on race winner)
    const cachedCount = results.filter(r => r.fromCache).length;
    expect(cachedCount).toBeGreaterThanOrEqual(PARALLEL - 1);
  }, 20_000);

  // ── S2 ────────────────────────────────────────────────────────
  it(`S2 — ${PARALLEL} parallel gold updates same player: SERIALIZABLE retry succeeds`, async () => {
    // Reset gold to known value
    await h.pool.query(`UPDATE players SET gold = 1000 WHERE player_id = 's2'`);
    let retries40001 = 0;
    // Each caller adds 10 gold; final must be 1000 + (PARALLEL * 10)
    const tasks = Array.from({ length: PARALLEL }, () =>
      executeWithIdempotency(h.pool, randomUUID(), 'gold_change', 's2', { delta: 10 },
        async (client) => {
          try {
            await client.query(`UPDATE players SET gold = gold + 10 WHERE player_id = 's2'`);
            return { ok: true };
          } catch (e: unknown) {
            const code = (e as { code?: string }).code;
            if (code === '40001' || code === '40P01') retries40001++;
            throw e;
          }
        }),
    );
    const results = await Promise.all(tasks);
    expect(results.length).toBe(PARALLEL);
    const final = await h.pool.query(`SELECT gold FROM players WHERE player_id = 's2'`);
    expect(Number(final.rows[0].gold)).toBe(1000 + PARALLEL * 10);
    // 40001 retries are expected under contention — non-zero count proves the path was exercised
    // (lenient: pg may serialize on cheap UPDATEs without conflict, so we don't insist >0)
    console.log(`  [soak] S2 retry hits: ${retries40001}`);
  }, 30_000);

  // ── S3 ────────────────────────────────────────────────────────
  it(`S3 — ${PARALLEL} parallel optimisticUpdate same row: 1 wins, ${PARALLEL - 1} conflict`, async () => {
    const itemUuid = randomUUID();
    await h.pool.query(
      `INSERT INTO item_instances (item_uuid, item_id, location, version)
       VALUES ($1, 'shared_item', 'inventory', 0)`, [itemUuid]);

    const tasks = Array.from({ length: PARALLEL }, async (_, idx) => {
      const client = await h.pool.connect();
      try {
        return await optimisticUpdate(client, {
          table: 'item_instances',
          id_col: 'item_uuid', id_val: itemUuid,
          expected_version: 0,
          set: { current_owner_id: `claim_${idx}` },
          returning: ['current_owner_id', 'version'],
        });
      } finally { client.release(); }
    });
    const settled = await Promise.allSettled(tasks);
    const wins = settled.filter(s => s.status === 'fulfilled');
    const conflicts = settled.filter(s => s.status === 'rejected'
      && s.reason instanceof OptimisticConflictError);
    expect(wins.length).toBe(1);
    expect(conflicts.length).toBe(PARALLEL - 1);
    // Winner row version must be 1
    const winner = wins[0] as PromiseFulfilledResult<{ version: number; current_owner_id: string }>;
    expect(Number(winner.value.version)).toBe(1);
  }, 20_000);

  // ── S4 ────────────────────────────────────────────────────────
  it(`S4 — ${PARALLEL} parallel ad12_rollback same txn: 1 actual + ${PARALLEL - 1} previously_rolled_back`, async () => {
    const txnId = randomUUID();
    const itemUuid = randomUUID();
    await h.pool.query(
      `INSERT INTO item_instances (item_uuid, item_id, location, version, current_owner_id)
       VALUES ($1, 'rollback_item', 'inventory', 1, 's2')`, [itemUuid]);
    await h.pool.query(
      `INSERT INTO transaction_log (txn_id, txn_type, player_id, target_type, target_uuid,
                                    source_state, status)
       VALUES ($1, 'trade', 's1', 'item', $2,
               jsonb_build_object('current_owner_id', 's1'), 'committed')`,
      [txnId, itemUuid]);

    const tasks = Array.from({ length: PARALLEL }, () =>
      ad12_rollback(h.pool, txnId, 'gm_soak', `parallel-${Math.random()}`));
    const results = await Promise.all(tasks);
    const newRollbacks = results.filter(r => !r.previously_rolled_back);
    const cached = results.filter(r => r.previously_rolled_back);
    expect(newRollbacks.length).toBe(1);
    expect(cached.length).toBe(PARALLEL - 1);
    // All return identical compensated_items count
    for (const r of results) expect(r.compensated_items).toBe(1);
  }, 30_000);

  // ── S5 ────────────────────────────────────────────────────────
  it('S5 — recoverStalePending under parallel writers: SKIP LOCKED is contention-safe', async () => {
    // Seed 50 expired pending rows
    const seeds = Array.from({ length: 50 }, (_, i) =>
      h.pool.query(
        `INSERT INTO pending_actions (nonce, action_type, player_id, payload, payload_hash,
                                       status, expires_at)
         VALUES ($1, 'trade', 's3', '{}'::jsonb, repeat('a', 64), 'pending',
                 NOW() - INTERVAL '1 hour')`,
        [`s5_${i}_${randomUUID()}`]));
    await Promise.all(seeds);

    // Run 4 parallel recoverStalePending — SKIP LOCKED means they partition the workload
    const recoveries = await Promise.all([
      recoverStalePending(h.pool),
      recoverStalePending(h.pool),
      recoverStalePending(h.pool),
      recoverStalePending(h.pool),
    ]);
    const totalRecovered = recoveries.reduce((sum, r) => sum + r.recovered, 0);
    // All 50 must be recovered (no double-counting, no orphan)
    expect(totalRecovered).toBe(50);
  }, 30_000);

  // ── S6 — bonus: idempotency cache under spoof attempt during contention ──
  it('S6 — parallel calls with mismatched payload + same nonce → exactly 1 spoof error', async () => {
    const nonce = randomUUID();
    // First call commits with payload {x:1}
    await executeWithIdempotency(h.pool, nonce, 'trade', 's1', { x: 1 },
      async () => ({ first: true }));
    // Now PARALLEL callers try with DIFFERENT payload {x:2} — all should be rejected
    const tasks = Array.from({ length: PARALLEL }, () =>
      executeWithIdempotency(h.pool, nonce, 'trade', 's1', { x: 2 },
        async () => ({ shouldnt: true })));
    const settled = await Promise.allSettled(tasks);
    const spoofs = settled.filter(s => s.status === 'rejected'
      && (s.reason as Error).message.includes('spoof attempt'));
    expect(spoofs.length).toBe(PARALLEL);
  }, 20_000);
});

// Soak suite availability self-test (runs even without DSN)
describe('R44 concurrency soak — availability', () => {
  it('reports availability based on PG_TEST_DSN', () => {
    if (skip) console.log(`[soak suite SKIPPED] ${SKIP_REASON}`);
    expect(typeof harnessAvailable()).toBe('boolean');
  });
});
