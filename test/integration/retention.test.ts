import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { runPartitionMaintenance as RunPartitionMaintenance } from '../../src/retention/partition-manager.js';

describe('partition management and retention', () => {
  let container: StartedTestContainer;
  let verificationPool: pg.Pool;
  let closeServicePool: () => Promise<void>;
  let runPartitionMaintenance: typeof RunPartitionMaintenance;

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
    await verificationPool.query(`
      CREATE TABLE logs_p2026_08_11 PARTITION OF logs
      FOR VALUES FROM ('2026-08-11T00:00:00.000Z') TO ('2026-08-12T00:00:00.000Z')
    `);
    const requestIdMigration = await readFile(
      new URL('../../migrations/003_request_id_index.sql', import.meta.url),
      'utf8',
    );
    await verificationPool.query(requestIdMigration);

    ({ runPartitionMaintenance } = await import('../../src/retention/partition-manager.js'));
    ({ close: closeServicePool } = await import('../../src/db/index.js'));
  }, 60_000);

  afterAll(async () => {
    await closeServicePool?.();
    await verificationPool?.end();
    await container?.stop();
  });

  it('precreates the horizon, reconciles backfills, and drops expired data and partitions', async () => {
    const now = new Date('2026-08-12T15:00:00Z');
    await expect(runPartitionMaintenance(30, now, 2, true)).resolves.toMatchObject({
      created: 3,
      reconciled: 0,
    });

    await verificationPool.query(
      `INSERT INTO logs ("timestamp", level, service, message)
       VALUES ('2026-08-01T12:00:00Z', 'info', 'backfill', 'retained'),
              ('2026-06-01T12:00:00Z', 'info', 'backfill', 'expired')`,
    );

    await expect(runPartitionMaintenance(30, now, 2, true)).resolves.toMatchObject({
      reconciled: 1,
    });

    const rows = await verificationPool.query<{ partition: string; message: string }>(
      `SELECT tableoid::regclass::text AS partition, message FROM logs ORDER BY message`,
    );
    expect(rows.rows).toEqual([{ partition: 'logs_p2026_08_01', message: 'retained' }]);

    await verificationPool.query(`
      CREATE TABLE logs_p2026_06_01 PARTITION OF logs
      FOR VALUES FROM ('2026-06-01T00:00:00.000Z') TO ('2026-06-02T00:00:00.000Z')
    `);
    await expect(runPartitionMaintenance(30, now, 2, true)).resolves.toMatchObject({ dropped: 1 });

    const children = await verificationPool.query<{ name: string }>(`
      SELECT child.relname AS name
      FROM pg_inherits i
      JOIN pg_class child ON child.oid = i.inhrelid
      WHERE i.inhparent = 'logs'::regclass
      ORDER BY child.relname
    `);
    expect(children.rows.map((row) => row.name)).toEqual([
      'logs_default',
      'logs_p2026_08_01',
      'logs_p2026_08_11',
      'logs_p2026_08_12',
      'logs_p2026_08_13',
      'logs_p2026_08_14',
    ]);

    const requestIdIndexes = await verificationPool.query<{ count: string }>(`
      SELECT count(*)
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexdef LIKE '%request_id%'
        AND tablename IN ('logs', 'logs_p2026_08_11', 'logs_p2026_08_14')
    `);
    expect(requestIdIndexes.rows[0]?.count).toBe('3');

    const detached = await verificationPool.query(
      `SELECT 1 FROM pg_class WHERE relname LIKE 'logs_default_detached_%'`,
    );
    expect(detached.rowCount).toBe(0);
  });
});
