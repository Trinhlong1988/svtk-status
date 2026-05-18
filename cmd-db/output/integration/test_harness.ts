/**
 * R44 integration test harness — real Postgres only.
 *
 * Gated by env `PG_TEST_DSN`. When unset, callers must use `it.skipIf(!harnessAvailable())`
 * so CI without Postgres skips cleanly. When set, provides an isolated schema-per-test
 * pattern: every `withTestDb()` call drops + recreates a unique schema, runs migrations
 * 001 → 002 → 003 in it, sets `search_path`, returns a pg Pool scoped to that schema.
 *
 * The harness is the ONLY place where the v2.4.2 spec items pg-mem cannot exercise
 * are actually executed:
 *   - BEGIN ISOLATION LEVEL SERIALIZABLE / REPEATABLE READ
 *   - 40001 retry semantics
 *   - jsonb `||` merge (W4)
 *   - FOR UPDATE SKIP LOCKED LIMIT N inside a CTE (P1.5)
 *   - BIGINT roundtrip (gold > Number.MAX_SAFE_INTEGER)
 *   - Schema CHECK constraints (inventory.slot 0-29, status enum)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '../../migrations');

export interface HarnessHandle {
  pool: Pool;
  schema: string;
  /** Drop the per-test schema and close the pool. Always call in afterEach/afterAll. */
  cleanup: () => Promise<void>;
}

/** True iff `PG_TEST_DSN` is set in environment. */
export function harnessAvailable(): boolean {
  return Boolean(process.env.PG_TEST_DSN);
}

/** Convenience reason string for `it.skipIf(...)` messages. */
export const SKIP_REASON =
  'PG_TEST_DSN not set — set PG_TEST_DSN=postgres://user:pass@host:port/db to enable real-Postgres integration tests';

const MIGRATION_ORDER = [
  '001_init.sql',
  '002_progression_snapshots.sql',
  '003_anti_dupe_schema.sql',
];

/**
 * Create an isolated test schema, apply migrations, return a scoped Pool.
 *
 * Schema name: `r44_test_<random>` — auto-cleaned by `cleanup()`.
 * Pool config: search_path = '<schema>,public', max=4, statement_timeout=5s.
 */
export async function withTestDb(): Promise<HarnessHandle> {
  const dsn = process.env.PG_TEST_DSN;
  if (!dsn) {
    throw new Error(SKIP_REASON);
  }

  const schema = `r44_test_${randomBytes(6).toString('hex')}`;

  // Step 1: admin pool — create schema
  const adminPool = new Pool({ connectionString: dsn, max: 1 });
  try {
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  } finally {
    await adminPool.end();
  }

  // Step 2: scoped pool — search_path points to schema
  const pool = new Pool({
    connectionString: dsn,
    max: 4,
    statement_timeout: 5000,
    application_name: `r44_test_${schema}`,
  });

  // Lock search_path on every checkout to keep migrations + queries inside the schema.
  pool.on('connect', (client) => {
    client.query(`SET search_path TO "${schema}", public`).catch(() => {});
  });

  // Step 3: apply migrations in order
  for (const file of MIGRATION_ORDER) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    await pool.query(sql);
  }

  return {
    pool,
    schema,
    cleanup: async () => {
      await pool.end().catch(() => {});
      const cleanupPool = new Pool({ connectionString: dsn, max: 1 });
      try {
        await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await cleanupPool.end();
      }
    },
  };
}

/**
 * Convenience helper for tests that only need a pool + schema name.
 * Caller still owns cleanup.
 */
export async function makeScopedPool(): Promise<HarnessHandle> {
  return withTestDb();
}
