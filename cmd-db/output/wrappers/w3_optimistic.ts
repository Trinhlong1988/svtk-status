/**
 * R44 W3 — Optimistic status / version check helper
 *
 * Wraps `UPDATE ... WHERE version = $expected RETURNING ...` so callers get a
 * boolean + post-row instead of having to inspect rowCount themselves. On
 * version mismatch (0 rows updated), throws `OptimisticConflictError` so
 * upstream wrappers can either retry (W1/W2 retry loop) or surface to caller.
 *
 * Used by cmd-item (loot/transfer), cmd-quest (reward grant), and W1/W2 wrappers
 * for any state mutation that needs concurrency-safe write without taking a
 * row lock the entire txn.
 */
import type { PoolClient, QueryResultRow } from 'pg';

export class OptimisticConflictError extends Error {
  constructor(
    public readonly table: string,
    public readonly id_col: string,
    public readonly id_val: unknown,
    public readonly expected_version: number,
  ) {
    super(
      `Optimistic conflict on ${table}.${id_col}=${String(id_val)} ` +
      `(expected version ${expected_version}, row missing or stale)`,
    );
    this.name = 'OptimisticConflictError';
  }
}

export interface OptimisticUpdateSpec {
  /** Target table identifier (whitelisted by caller — em không sanitize). */
  table: string;
  /** Primary-key column name. */
  id_col: string;
  /** Primary-key value. */
  id_val: unknown;
  /** Version column name. Default 'version'. */
  version_col?: string;
  /** Expected current version. Update only fires if DB row matches. */
  expected_version: number;
  /** Column-name → new-value map (excluding version). */
  set: Record<string, unknown>;
  /** Optional RETURNING column list. Default `*`. */
  returning?: readonly string[];
}

/**
 * W3 — perform optimistic UPDATE with version increment.
 *
 * SQL emitted (table/version_col are concatenated — caller's job to whitelist):
 *
 *   UPDATE <table>
 *      SET <set...>, <version_col> = <version_col> + 1
 *    WHERE <id_col> = $1 AND <version_col> = $2
 *    RETURNING <returning>
 */
export async function optimisticUpdate<R extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  spec: OptimisticUpdateSpec,
): Promise<R> {
  const versionCol = spec.version_col ?? 'version';
  const setEntries = Object.entries(spec.set);
  // Reject empty sets — would emit invalid SQL.
  if (setEntries.length === 0) {
    throw new Error('W3: optimisticUpdate requires at least 1 column in set');
  }

  // Param order: [...setValues, id_val, expected_version]
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let pIdx = 1;
  for (const [col, val] of setEntries) {
    setClauses.push(`${col} = $${pIdx}`);
    params.push(val);
    pIdx++;
  }
  setClauses.push(`${versionCol} = ${versionCol} + 1`);

  const idParam = pIdx;
  params.push(spec.id_val);
  pIdx++;
  const versionParam = pIdx;
  params.push(spec.expected_version);

  const returning = (spec.returning && spec.returning.length > 0)
    ? spec.returning.join(', ')
    : '*';

  const sql =
    `UPDATE ${spec.table} ` +
    `SET ${setClauses.join(', ')} ` +
    `WHERE ${spec.id_col} = $${idParam} AND ${versionCol} = $${versionParam} ` +
    `RETURNING ${returning}`;

  const result = await client.query(sql, params);
  if (result.rowCount === 0 || result.rows.length === 0) {
    throw new OptimisticConflictError(spec.table, spec.id_col, spec.id_val, spec.expected_version);
  }
  return result.rows[0] as R;
}
