import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { runner } from 'node-pg-migrate';
import type { Config } from '../config.js';

// Resolves to <project-root>/migrations both in dev (src/db) and after build (dist/db).
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '..', '..', 'migrations');

/**
 * Applies all pending migrations, retrying transient connection failures.
 * The database container can take a moment to accept connections even after
 * its healthcheck passes (DNS propagation, restarts), so startup must not
 * crash on the first failed attempt.
 */
export async function runMigrations(
  config: Pick<Config, 'DATABASE_URL'>,
  maxAttempts = 15,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await runner({
        databaseUrl: config.DATABASE_URL,
        dir: MIGRATIONS_DIR,
        direction: 'up',
        migrationsTable: 'pgmigrations',
      });
      return;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await sleep(1000);
      }
    }
  }
  throw lastError;
}
