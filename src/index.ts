import 'dotenv/config';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);

  await runMigrations(config);

  const app = buildApp({ pool, config });
  const server = app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`listening on :${config.PORT}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`${signal} received, shutting down`);
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
