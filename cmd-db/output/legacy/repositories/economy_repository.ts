/**
 * Economy repository — gold sink + faucet ledger.
 *
 * CHECK constraint enforces: amount ≥ 0 → sink_type NULL (faucet)
 *                            amount < 0 → sink_type NOT NULL (sink).
 *
 * Anti-inflation analytics (CPI / velocity / wealth gini) computed from this
 * ledger in Layer 3 service (simulator/economy.ts).
 */
import type { Pool, PoolClient } from 'pg';
import type { Currency } from './character_repository.js';

export type SinkType =
  | 'repair'
  | 'upgrade'
  | 'tax'
  | 'craft'
  | 'destination'
  | 'inflation';

export interface TransactionRow {
  id: string;
  char_id: string;
  /** BIGINT signed → string from driver. */
  amount: string;
  currency: Currency;
  sink_type: SinkType | null;
  related_action: string | null;
  schema_version: number;
  created_at: Date;
}

export interface LogTransactionInput {
  char_id: string;
  amount: bigint;
  currency: Currency;
  /** REQUIRED when amount < 0, MUST be null when amount ≥ 0 (CHECK enforces). */
  sink_type?: SinkType | null;
  related_action?: string | null;
}

/**
 * Append transaction row. Validates sign↔sink_type rule client-side to give
 * better error than CHECK constraint violation.
 */
export async function logTransaction(
  executor: Pool | PoolClient,
  input: LogTransactionInput,
): Promise<TransactionRow> {
  const isSink = input.amount < 0n;
  if (isSink && !input.sink_type) {
    throw new Error(
      `logTransaction: amount=${input.amount} is a sink but sink_type not provided`,
    );
  }
  if (!isSink && input.sink_type) {
    throw new Error(
      `logTransaction: amount=${input.amount} is a faucet but sink_type=${input.sink_type} provided`,
    );
  }
  const { rows } = await executor.query<TransactionRow>(
    `INSERT INTO economy_transactions (char_id, amount, currency, sink_type, related_action)
     VALUES ($1, $2::bigint, $3, $4, $5)
     RETURNING *`,
    [
      input.char_id,
      input.amount.toString(),
      input.currency,
      input.sink_type ?? null,
      input.related_action ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('logTransaction: INSERT did not return row');
  return row;
}

export interface CurrencyFlowSummary {
  currency: Currency;
  total_faucet: string;
  total_sink: string;
  net: string;
}

/**
 * Aggregate faucet/sink totals per currency for a character in a time window.
 * Returns BigInt-safe strings.
 */
export async function summarizeFlowSince(
  pool: Pool,
  charId: string,
  sinceMs: number,
): Promise<CurrencyFlowSummary[]> {
  if (!Number.isFinite(sinceMs)) {
    throw new Error('summarizeFlowSince: sinceMs must be finite');
  }
  const { rows } = await pool.query<{
    currency: Currency;
    total_faucet: string;
    total_sink: string;
    net: string;
  }>(
    `SELECT
       currency,
       COALESCE(SUM(CASE WHEN amount >= 0 THEN amount ELSE 0 END), 0)::text  AS total_faucet,
       COALESCE(SUM(CASE WHEN amount <  0 THEN amount ELSE 0 END), 0)::text  AS total_sink,
       COALESCE(SUM(amount), 0)::text                                        AS net
     FROM economy_transactions
     WHERE char_id = $1 AND created_at >= to_timestamp($2 / 1000.0)
     GROUP BY currency
     ORDER BY currency ASC`,
    [charId, sinceMs],
  );
  return rows;
}

/**
 * Aggregate sink amounts per sink_type for inflation dashboard (Layer 3 only).
 * Returns negative amount as positive total (for readability).
 */
export async function summarizeSinksByType(
  pool: Pool,
  currency: Currency,
  sinceMs: number,
): Promise<{ sink_type: SinkType; total: string }[]> {
  if (!Number.isFinite(sinceMs)) {
    throw new Error('summarizeSinksByType: sinceMs must be finite');
  }
  const { rows } = await pool.query<{ sink_type: SinkType; total: string }>(
    `SELECT
       sink_type,
       COALESCE(SUM(-amount), 0)::text AS total
     FROM economy_transactions
     WHERE currency = $1
       AND sink_type IS NOT NULL
       AND created_at >= to_timestamp($2 / 1000.0)
     GROUP BY sink_type
     ORDER BY sink_type ASC`,
    [currency, sinceMs],
  );
  return rows;
}

/** Recent transactions for a character (audit / dispute resolution). */
export async function listRecent(
  pool: Pool,
  charId: string,
  limit: number = 100,
): Promise<TransactionRow[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error(`listRecent: limit must be integer in [1, 10000], got ${limit}`);
  }
  const { rows } = await pool.query<TransactionRow>(
    `SELECT * FROM economy_transactions
     WHERE char_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [charId, limit],
  );
  return rows;
}
