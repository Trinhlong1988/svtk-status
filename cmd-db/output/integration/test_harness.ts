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
import { Pool, type PoolClient } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '../../migrations');

export interface HarnessHandle {
  pool: Pool;
  schema: string;
  /** Drop the per-test schema and close the pool. Always call in afterEach/afterAll. */
  cleanup: () => Promise<void>;
}

export interface HarnessOptions {
  /** Pool max connection count (default 4). Soak tests bump to 16-32. */
  poolMax?: number;
  /** Per-statement timeout in ms (default 5000). Soak retry-loops may extend. */
  statementTimeoutMs?: number;
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
/**
 * Split SQL on top-level `;` while respecting:
 *   - line comments `-- ... \n`
 *   - block comments `/* ... *\/`
 *   - single-quoted string literals `'...'` (with `''` escape)
 *   - dollar-quoted blocks `$tag$ ... $tag$` (Postgres DO / function bodies)
 *
 * Naive `sql.split(';')` breaks on any `;` inside a comment or function body.
 * Blank/comment-only chunks are dropped from output.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  let inDollar: string | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Inside dollar-quoted block: look for closing tag
    if (inDollar) {
      if (ch === '$' && sql.startsWith(inDollar, i)) {
        buf += inDollar;
        i += inDollar.length;
        inDollar = null;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }

    // Line comment `-- ... \n` — preserve in buf, skip semicolons inside
    if (ch === '-' && next === '-') {
      const eol = sql.indexOf('\n', i);
      const end = eol === -1 ? sql.length : eol + 1;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }

    // Block comment `/* ... */`
    if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? sql.length : close + 2;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }

    // Single-quoted string literal — `''` is escape for embedded quote
    if (ch === "'") {
      buf += ch;
      i++;
      while (i < sql.length) {
        const c = sql[i];
        buf += c;
        i++;
        if (c === "'") {
          if (sql[i] === "'") {
            buf += sql[i];
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }

    // Dollar-quote open `$tag$` or `$$`
    if (ch === '$') {
      const m = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (m) {
        inDollar = m[0];
        buf += inDollar;
        i += inDollar.length;
        continue;
      }
    }

    // Statement boundary
    if (ch === ';') {
      const stmt = buf.trim();
      if (stmt && !stmt.split('\n').every(l => l.trim().startsWith('--') || l.trim() === '')) {
        out.push(stmt);
      }
      buf = '';
      i++;
      continue;
    }

    buf += ch;
    i++;
  }
  const tail = buf.trim();
  if (tail && !tail.split('\n').every(l => l.trim().startsWith('--') || l.trim() === '')) {
    out.push(tail);
  }
  return out;
}

export async function withTestDb(opts: HarnessOptions = {}): Promise<HarnessHandle> {
  const dsn = process.env.PG_TEST_DSN;
  if (!dsn) {
    throw new Error(SKIP_REASON);
  }

  // R5 bug-hunt: 8 random bytes = 64-bit entropy → collision ~2^32 calls (safe).
  const schema = `r44_test_${randomBytes(8).toString('hex')}`;

  // Step 1+2: single pool throughout — earlier admin/scoped split caused
  // ECONNRESET on pglite-socket when first pool.end() ran before second
  // pool connected. Real Postgres also fine with single-pool pattern.
  // CREATE SCHEMA runs via the main pool; the verify hook sets search_path
  // on every new connection (per pg-pool docs — verify is awaited).
  // R3 bug-hunt + pglite compat: search_path applied via pg-pool `verify`
  // hook (NOT `pool.on('connect')` which is fire-and-forget per pg-pool
  // implementation, NOT Postgres `options` startup parameter which
  // pglite-socket does not handle and resets the connection). `verify`
  // is awaited per new connection checkout, so subsequent queries see
  // the correct search_path; works on both real PG and pglite-socket.
  const pool = new Pool({
    connectionString: dsn,
    max: opts.poolMax ?? 4,
    statement_timeout: opts.statementTimeoutMs ?? 5000,
    application_name: `r44_test_${schema}`,
    verify: (client: PoolClient, cb: (err?: Error) => void) => {
      client.query(`SET search_path TO "${schema}", public`)
        .then(() => cb())
        .catch((e) => cb(e instanceof Error ? e : new Error(String(e))));
    },
  } as ConstructorParameters<typeof Pool>[0] & {
    verify: (client: PoolClient, cb: (err?: Error) => void) => void;
  });

  // Step 3: create schema then apply migrations in order, all through pool.
  // verify hook makes SET search_path land per new connection automatically.
  // R2/R4 bug-hunt fix: wrap in try/catch so a mid-migration failure drops
  // the schema + closes the scoped pool instead of leaking both.
  // pglite-socket compat: split multi-statement SQL on top-level `;`, respecting
  // `$$ ... $$` dollar-quoted blocks (DO / function bodies). Real Postgres
  // accepts multi-statement Simple Queries too, so this split is benign there.
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    for (const file of MIGRATION_ORDER) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      for (const stmt of splitSqlStatements(sql)) {
        await pool.query(stmt);
      }
    }
  } catch (err) {
    // Cleanup via SAME pool (avoid pglite-socket reconnect issue); best-effort
    // DROP before ending — on real PG either order works.
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end().catch(() => {});
    throw err;
  }

  return {
    pool,
    schema,
    cleanup: async () => {
      // Drop schema while pool is still open (avoids reconnect cycle that
      // pglite-socket dislikes; real PG handles either order).
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await pool.end().catch(() => {});
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
