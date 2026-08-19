import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { dropExpiredPartitions as DropExpiredPartitions } from '../../src/retention/partition-manager.js';

describe('partition management and retention', () => {
  let container: StartedTestContainer;
  let verificationPool: pg.Pool;
  let closeServicePool: () => Promise<void>;
  let dropExpiredPartitions: typeof DropExpiredPartitions;

  beforeAll(async () => {
    container = await new GenericContainer('postgres:18-alpine')
      .withEnvironment({ POSTGRES_USER: 'logs', POSTGRES_PASSWORD: 'logs', POSTGRES_DB: 'logs' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    const databaseUrl = `postgres://logs:logs@${container.getHost()}:${container.getMappedPort(5432)}/logs`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.RETENTION_DAYS = '30';
    verificationPool = new pg.Pool({ connectionString: databaseUrl });
    for (const name of ['001_initial.sql']) {
      const migration = await readFile(
        new URL(`../../migrations/${name}`, import.meta.url),
        'utf8',
      );
      await verificationPool.query(migration);
    }

    ({ dropExpiredPartitions } = await import('../../src/retention/partition-manager.js'));
    ({ close: closeServicePool } = await import('../../src/db/index.js'));
  }, 60_000);

  afterAll(async () => {
    await closeServicePool?.();
    await verificationPool?.end();
    await container?.stop();
  });

  it('drops expired raw partitions and deletes expired rollups while retaining valid ones', async () => {
    const now = new Date('2026-08-12T15:00:00Z');
    await verificationPool.query(`
      CREATE TABLE logs_p2026_06_01 PARTITION OF logs
      FOR VALUES FROM ('2026-06-01T00:00:00.000Z') TO ('2026-06-02T00:00:00.000Z');

      INSERT INTO log_rollups_1m (bucket_start, service, level, count)
      VALUES ('2026-06-01T00:00:00Z', 'svc', 'info', 5),
             ('2026-05-01T00:00:00Z', 'svc', 'info', 3),
             ('2026-08-01T00:00:00Z', 'svc', 'info', 7);
    `);

    await expect(dropExpiredPartitions(30, now, true)).resolves.toMatchObject({ dropped: 1 });

    const expired = await verificationPool.query(`
      SELECT 1 FROM pg_class WHERE relname = 'logs_p2026_06_01'
    `);
    expect(expired.rowCount).toBe(0);

    const retainedRollups = await verificationPool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM log_rollups_1m
    `);
    expect(retainedRollups.rows[0]?.count).toBe('1');

    const retainedRow = await verificationPool.query<{ bucket_start: Date }>(
      `SELECT bucket_start FROM log_rollups_1m ORDER BY bucket_start`,
    );
    expect(retainedRow.rows[0]?.bucket_start.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('skips when the advisory lock is already held', async () => {
    const now = new Date('2026-08-12T15:00:00Z');
    const lockKey = 1_813_047_329;
    await verificationPool.query('SELECT pg_advisory_lock($1)', [lockKey]);

    await expect(dropExpiredPartitions(30, now, false)).resolves.toMatchObject({
      skipped: true,
      dropped: 0,
    });

    await verificationPool.query('SELECT pg_advisory_unlock($1)', [lockKey]);
  });

  it('ensures partitions with inherited indexes for retained timestamps', async () => {
    const now = new Date('2026-08-12T15:00:00Z');
    const { ensurePartitionsForTimestamps } =
      await import('../../src/retention/partition-manager.js');

    await expect(
      ensurePartitionsForTimestamps([new Date('2026-08-12T12:00:00Z')], 30, now),
    ).resolves.toBe(1);

    const children = await verificationPool.query<{ name: string }>(`
      SELECT child.relname AS name
      FROM pg_inherits i
      JOIN pg_class child ON child.oid = i.inhrelid
      WHERE i.inhparent = 'logs'::regclass
        AND child.relname = 'logs_p2026_08_12'
    `);
    expect(children.rows.map((row) => row.name)).toEqual(['logs_p2026_08_12']);

    const serviceIndexes = await verificationPool.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND (indexname = 'logs_service_ts_idx' OR indexname LIKE '%service_timestamp_idx')
        AND tablename = 'logs_p2026_08_12'
        AND indexdef LIKE '%(service, "timestamp" DESC)%'
        AND indexdef NOT LIKE '%id DESC%'
    `);
    expect(serviceIndexes.rows[0]?.count).toBe(1);

    const sequence = await verificationPool.query<{ cache_size: string }>(`
      SELECT cache_size::text
      FROM pg_sequences
      WHERE schemaname = 'public' AND sequencename = 'logs_id_seq'
    `);
    expect(sequence.rows[0]?.cache_size).toBe('1000');
  });
});
