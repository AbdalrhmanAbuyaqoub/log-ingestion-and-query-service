import 'dotenv/config';
import { loadConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { close as closeDb } from './db/index.js';
import { buildApp } from './app.js';
import { runPartitionMaintenance } from './retention/partition-manager.js';
import { startPartitionScheduler } from './retention/scheduler.js';

async function main(): Promise<void> {
  const config = loadConfig();

  await runMigrations(config);
  await runPartitionMaintenance(config.RETENTION_DAYS, new Date(), 2, true);

  const app = buildApp();
  const partitionScheduler = startPartitionScheduler(config.RETENTION_DAYS);
  const server = app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`listening on :${config.PORT}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`${signal} received, shutting down`);
    server.close();
    await partitionScheduler.stop();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
