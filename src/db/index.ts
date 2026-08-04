import pg from 'pg';
import { loadConfig } from '../config.js';

// Singleton pool — the single access point for all database interaction in the
// project. Per the node-postgres "Suggested Project Structure" guide, routes
// and modules import `query` / `getClient` from here rather than `pg` directly.
// This centralizes logging, diagnostics, and pool lifecycle in one place.
//
// Tests mock this module via `vi.mock('../../src/db/index.js', ...)`.

const config = loadConfig();

const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
});

const LOG_QUERIES = process.env.LOG_QUERIES === '1'; // to-do: check

/**
 * Execute a query against the pool. When `LOG_QUERIES=1` is set, logs the
 * duration and row count of every query — useful for debugging without
 // paying the logging cost in production (23k logs/s ingestion).
 * Query text and params are intentionally NOT logged to avoid leaking
 * potentially sensitive attribute values.
 */
export const query = async <T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> => {
  const start = Date.now();
  const res = await pool.query<T>(text, params as pg.QueryConfigValues<T>[]);
  if (LOG_QUERIES) {
    const duration = Date.now() - start;
    console.log('executed query', { duration, rows: res.rowCount });
  }
  return res;
};

/**
 * Check out a dedicated client for multi-statement transactions. Callers must
 * `release()` the client when done. The same `LOG_QUERIES=1` gate applies to
 * queries issued through the returned client only if they go through `query`.
 */
export const getClient = (): Promise<pg.PoolClient> => pool.connect();

/**
 * Drain the pool — called during graceful shutdown. Rejects if a client cannot
 * be closed; callers should still proceed with process exit.
 */
export const close = async (): Promise<void> => {
  await pool.end();
};
