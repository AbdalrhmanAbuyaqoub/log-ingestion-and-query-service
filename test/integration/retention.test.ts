import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { dropExpiredPartitions as DropExpiredPartitions } from '../../src/retention/partition-manager.js';

describe('retention', () => {
  let container: StartedTestContainer;
  let db: pg.Pool;
  let closeDb: () => Promise<void>;
  let dropExpiredPartitions: typeof DropExpiredPartitions;

  beforeAll(async () => {
    container = await new GenericContainer('postgres:18-alpine')
      .withEnvironment({ POSTGRES_USER: 'logs', POSTGRES_PASSWORD: 'logs', POSTGRES_DB: 'logs' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    const databaseUrl = `postgres://logs:logs@${container.getHost()}:${container.getMappedPort(5432)}/logs`;
    process.env.DATABASE_URL = databaseUrl;
    db = new pg.Pool({ connectionString: databaseUrl });
    await db.query(
      await readFile(new URL('../../migrations/001_initial.sql', import.meta.url), 'utf8'),
    );
    ({ dropExpiredPartitions } = await import('../../src/retention/partition-manager.js'));
    ({ close: closeDb } = await import('../../src/db/index.js'));
  }, 60_000);

  afterAll(async () => {
    await closeDb?.();
    await db?.end();
    await container?.stop();
  });

  it('cleans expired data but aborts atomically for retained data in the default', async () => {
    const now = new Date('2026-08-12T15:00:00Z');
    await db.query(`
      CREATE TABLE logs_p2026_06_01 PARTITION OF logs
        FOR VALUES FROM ('2026-06-01') TO ('2026-06-02');
      INSERT INTO logs ("timestamp", level, service, message)
        VALUES ('2026-05-01', 'info', 'old', 'expired');
      INSERT INTO log_rollups_1m VALUES
        ('2026-05-01', 'old', 'info', 1),
        ('2026-08-01', 'kept', 'info', 1);
    `);

    await expect(dropExpiredPartitions(30, now, true)).resolves.toMatchObject({ dropped: 1 });
    const cleaned = await db.query<{ raw: string; rollups: string }>(`
      SELECT count(*)::text AS raw,
             (SELECT count(*)::text FROM log_rollups_1m) AS rollups
      FROM logs
    `);
    expect(cleaned.rows[0]).toEqual({ raw: '0', rollups: '1' });

    await db.query(`
      CREATE TABLE logs_p2026_06_02 PARTITION OF logs
        FOR VALUES FROM ('2026-06-02') TO ('2026-06-03');
      INSERT INTO logs ("timestamp", level, service, message)
        VALUES ('2026-08-10', 'info', 'misrouted', 'retained');
      INSERT INTO log_rollups_1m VALUES ('2026-05-02', 'old', 'info', 1);
    `);

    await expect(dropExpiredPartitions(30, now, true)).rejects.toMatchObject({
      code: 'RETENTION_DEFAULT_CONTAINS_RETAINED_LOGS',
      retainedRows: '1',
    });
    const unchanged = await db.query<{ raw: string; rollups: string; expired: boolean }>(`
      SELECT count(*)::text AS raw,
             (SELECT count(*)::text FROM log_rollups_1m) AS rollups,
             EXISTS (SELECT FROM pg_class WHERE relname = 'logs_p2026_06_02') AS expired
      FROM logs
    `);
    expect(unchanged.rows[0]).toEqual({ raw: '1', rollups: '2', expired: true });
  });
});
