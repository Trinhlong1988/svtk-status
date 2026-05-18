/**
 * Postgres connection pool wrapper — Phase 13 Tuần 1.
 *
 * Env-driven config (no hardcoded credentials per CLAUDE.md anti-pattern):
 *   DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
 *
 * Health check returns { healthy, latency_ms, error? } for monitoring wire-up (CMD4 Tuần 3).
 * Pool singleton; tests inject mock via setPool().
 */
import { Pool, type PoolConfig } from 'pg';

let activePool: Pool | null = null;

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

export interface HealthCheckResult {
  healthy: boolean;
  latency_ms: number;
  error?: string;
}

const DEFAULT_PORT = 5432;
const DEFAULT_MAX_POOL = 20;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONN_TIMEOUT_MS = 5_000;
const MIN_PORT = 1;
const MAX_PORT = 65535;

/** Load DB config from process.env. Throws if required vars missing/invalid. */
export function loadConfigFromEnv(): DbConfig {
  const host = process.env.DB_HOST;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_NAME;
  if (!host) throw new Error('DB_HOST env required');
  if (!user) throw new Error('DB_USER env required');
  if (!password) throw new Error('DB_PASSWORD env required');
  if (!database) throw new Error('DB_NAME env required');

  const portRaw = process.env.DB_PORT;
  const port = portRaw === undefined ? DEFAULT_PORT : Number(portRaw);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`DB_PORT invalid (must be integer in [${MIN_PORT}, ${MAX_PORT}]): ${portRaw}`);
  }

  return {
    host,
    port,
    user,
    password,
    database,
    max: DEFAULT_MAX_POOL,
    idleTimeoutMillis: DEFAULT_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: DEFAULT_CONN_TIMEOUT_MS,
  };
}

/** Initialize pool singleton. Returns existing pool if already initialized. */
export function initPool(config?: DbConfig): Pool {
  if (activePool) return activePool;
  const cfg = config ?? loadConfigFromEnv();
  const poolCfg: PoolConfig = {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    max: cfg.max,
    idleTimeoutMillis: cfg.idleTimeoutMillis,
    connectionTimeoutMillis: cfg.connectionTimeoutMillis,
  };
  activePool = new Pool(poolCfg);
  return activePool;
}

/** Get current pool. Throws if not initialized. */
export function getPool(): Pool {
  if (!activePool) {
    throw new Error('Pool not initialized — call initPool() or setPool() first');
  }
  return activePool;
}

/** Inject pool (tests use pg-mem instance or shared connection). */
export function setPool(pool: Pool): void {
  activePool = pool;
}

/** Probe DB liveness with SELECT 1. Latency captured for monitoring. */
export async function healthCheck(): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    const pool = getPool();
    const result = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    const latency_ms = Date.now() - start;
    const healthy = result.rows[0]?.ok === 1;
    return { healthy, latency_ms };
  } catch (err) {
    return {
      healthy: false,
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Close pool. Tests + graceful shutdown. */
export async function closePool(): Promise<void> {
  if (activePool) {
    await activePool.end();
    activePool = null;
  }
}
