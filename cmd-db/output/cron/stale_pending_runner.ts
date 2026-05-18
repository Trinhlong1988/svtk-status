/**
 * CMD2 Phase 14 Week 2 Day 1 — P1.5 stale pending recovery
 *
 * Reclaims pending_actions stuck past expires_at (e.g. crash mid-txn) and
 * garbage-collects long-resolved rows.
 *
 * In-process scheduler — defer pg_cron extension or external scheduler to
 * production deployment per cmd-db/cmd.md Gap 3.
 */

import type { Pool } from 'pg';

export interface StaleRecoveryResult {
  recovered: number;
  hard_deleted: number;
  current_stats: Record<string, number>;
}

export async function recoverStalePending(pool: Pool): Promise<StaleRecoveryResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");

    const recoveredR = await client.query(`
      WITH stale AS (
        SELECT nonce FROM pending_actions
        WHERE status = 'pending' AND expires_at < NOW()
        FOR UPDATE SKIP LOCKED LIMIT 1000
      )
      UPDATE pending_actions
      SET status = 'failed',
          completed_at = NOW(),
          result = jsonb_build_object('error', 'expired_stale', 'recovered_at', NOW()::text)
      WHERE nonce IN (SELECT nonce FROM stale)
      RETURNING nonce
    `);

    const deletedR = await client.query(`
      DELETE FROM pending_actions
      WHERE status IN ('failed', 'duplicate_rejected')
        AND completed_at < NOW() - INTERVAL '24 hours'
      RETURNING nonce
    `);

    const statsR = await client.query(`
      SELECT status, COUNT(*) AS cnt FROM pending_actions GROUP BY status
    `);

    const stats: Record<string, number> = {};
    for (const row of statsR.rows) {
      stats[row.status] = Number(row.cnt);
    }

    await client.query('COMMIT');

    return {
      recovered: recoveredR.rows.length,
      hard_deleted: deletedR.rows.length,
      current_stats: stats,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface StalePendingSchedulerHandle {
  stop: () => void;
}

export function startStalePendingScheduler(
  pool: Pool,
  onResult?: (r: StaleRecoveryResult) => void,
  onError?: (e: unknown) => void,
): StalePendingSchedulerHandle {
  const intervalMs = 5 * 60 * 1000;
  const jitterMs = 30 * 1000;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  async function loop(): Promise<void> {
    if (stopped) return;
    try {
      const result = await recoverStalePending(pool);
      onResult?.(result);
    } catch (err) {
      onError?.(err);
    }
    if (stopped) return;
    const nextDelay = intervalMs + (Math.random() * 2 - 1) * jitterMs;
    timer = setTimeout(loop, Math.max(60_000, nextDelay));
  }

  // Initial 30s delay so startup does not spike
  timer = setTimeout(loop, 30_000);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
