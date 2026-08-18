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
    for (const name of ['001_initial.sql', '002_log_rollups.sql']) {
      const migration = await readFile(
        new URL(`../../migrations/${name}`, import.meta.url),
        'utf8',
      );
      await verificationPool.query(migration);
    }
    const requestIdMigration = await readFile(
      new URL('../../migrations/003_request_id_index.sql', import.meta.url),
      'utf8',
    );
    await verificationPool.query(requestIdMigration);
    const sequenceCacheMigration = await readFile(
      new URL('../../migrations/004_sequence_cache.sql', import.meta.url),
      'utf8',
    );
    await verificationPool.query(sequenceCacheMigration);
    const narrowRequestIdMigration = await readFile(
      new URL('../../migrations/005_replace_request_id_index.sql', import.meta.url),
      'utf8',
    );
    await verificationPool.query(narrowRequestIdMigration);
    const narrowServiceIndexMigration = await readFile(
      new URL('../../migrations/006_narrow_service_index.sql', import.meta.url),
      'utf8',
    );
    await verificationPool.query(narrowServiceIndexMigration);

    ({ dropExpiredPartitions } = await import('../../src/retention/partition-manager.js'));
    ({ close: closeServicePool } = await import('../../src/db/index.js'));
  }, 60_000);

  afterAll(async () => {
    await closeServicePool?.();
    await verificationPool?.end();
    await container?.stop();
  });

  it('drops expired raw and rollup partitions while retaining valid ones', async () => {
    const now = new Date('2026-08-12T15:00:00Z');
    await verificationPool.query(`
      CREATE TABLE logs_p2026_06_01 PARTITION OF logs
      FOR VALUES FROM ('2026-06-01T00:00:00.000Z') TO ('2026-06-02T00:00:00.000Z');
      CREATE TABLE log_rollups_1m_p2026_06_01 PARTITION OF log_rollups_1m
      FOR VALUES FROM ('2026-06-01T00:00:00.000Z') TO ('2026-06-02T00:00:00.000Z');
      CREATE TABLE log_rollups_1m_p2026_05_01 PARTITION OF log_rollups_1m
      FOR VALUES FROM ('2026-05-01T00:00:00.000Z') TO ('2026-05-02T00:00:00.000Z');
    `);

    await expect(dropExpiredPartitions(30, now, true)).resolves.toMatchObject({ dropped: 2 });

    const expired = await verificationPool.query(`
      SELECT 1
      FROM pg_class
      WHERE relname IN (
        'logs_p2026_06_01',
        'log_rollups_1m_p2026_06_01',
        'log_rollups_1m_p2026_05_01'
      )
    `);
    expect(expired.rowCount).toBe(0);
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
      WHERE i.inhparent IN ('logs'::regclass, 'log_rollups_1m'::regclass)
        AND child.relname IN ('logs_p2026_08_12', 'log_rollups_1m_p2026_08_12')
      ORDER BY child.relname
    `);
    expect(children.rows.map((row) => row.name)).toEqual([
      'log_rollups_1m_p2026_08_12',
      'logs_p2026_08_12',
    ]);

    const requestIdIndexes = await verificationPool.query<{ name: string; definition: string }>(`
      SELECT indexname AS name, indexdef AS definition
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexdef LIKE '%request_id%'
        AND tablename = 'logs_p2026_08_12'
    `);
    expect(requestIdIndexes.rows).toHaveLength(1);
    expect(requestIdIndexes.rows[0]?.definition).toContain("((attributes ->> 'request_id'::text))");
    expect(requestIdIndexes.rows[0]?.definition).not.toContain('timestamp DESC');
    expect(requestIdIndexes.rows[0]?.definition).not.toContain('id DESC');

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
