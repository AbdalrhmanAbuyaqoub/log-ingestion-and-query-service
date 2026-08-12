import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { Client } from 'pg';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

describe('required API endpoints', () => {
  let container: StartedTestContainer;
  let client: Client;
  let app: Express;
  let closeDb: () => Promise<void>;
  let stopIngestion: () => Promise<void>;

  beforeAll(async () => {
    container = await new GenericContainer('postgres:18-alpine')
      .withEnvironment({ POSTGRES_USER: 'logs', POSTGRES_PASSWORD: 'logs', POSTGRES_DB: 'logs' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    const databaseUrl = `postgres://logs:logs@${container.getHost()}:${container.getMappedPort(5432)}/logs`;
    process.env.DATABASE_URL = databaseUrl;

    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations({ DATABASE_URL: databaseUrl }, 1);

    const [{ buildApp }, db, ingestion] = await Promise.all([
      import('../../src/app.js'),
      import('../../src/db/index.js'),
      import('../../src/ingestion/coordinator.js'),
    ]);
    app = buildApp();
    closeDb = db.close;
    stopIngestion = ingestion.stopIngestionCoordinator;

    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  }, 120_000);

  beforeEach(async () => {
    await client.query('TRUNCATE TABLE logs');
    await client.query('ALTER SEQUENCE logs_id_seq RESTART WITH 1');
  });

  afterAll(async () => {
    await client?.end();
    await stopIngestion?.();
    await closeDb?.();
    await container?.stop();
  });

  it('GET /health reports ready when the migrated database answers', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('supports the required data endpoints through HTTP', async () => {
    const ingestion = await request(app)
      .post('/logs')
      .send({
        logs: [
          logEntry({
            timestamp: '2026-08-10T10:00:30Z',
            message: 'older entry',
            attributes: { retries: 1, confirmed: false },
          }),
          logEntry({
            timestamp: '2026-08-10T10:00:45Z',
            message: 'newer entry',
            attributes: { retries: 2, confirmed: true },
          }),
          logEntry({ level: 'critical', message: 'rejected entry' }),
        ],
      });

    expect(ingestion.status).toBe(200);
    expect(ingestion.body).toEqual({
      accepted: 2,
      rejected: [{ index: 2, reason: "invalid level: 'critical'" }],
    });

    const logs = await request(app).get('/logs');

    expect(logs.status).toBe(200);
    expect(logs.body.next_cursor).toBeNull();
    expect(logs.body.logs).toEqual([
      {
        id: expect.any(String),
        timestamp: '2026-08-10T10:00:45.000Z',
        level: 'info',
        service: 'api',
        message: 'newer entry',
        attributes: { retries: 2, confirmed: true },
      },
      {
        id: expect.any(String),
        timestamp: '2026-08-10T10:00:30.000Z',
        level: 'info',
        service: 'api',
        message: 'older entry',
        attributes: { retries: 1, confirmed: false },
      },
    ]);

    const aggregate = await request(app).get('/logs/aggregate').query({
      since: '2026-08-10T10:00:00Z',
      until: '2026-08-10T10:01:00Z',
      bucket: '1m',
    });

    expect(aggregate.status).toBe(200);
    expect(aggregate.body).toEqual({
      buckets: [{ start: '2026-08-10T10:00:00.000Z', group: null, count: 2 }],
    });

    const partialAggregate = await request(app).get('/logs/aggregate').query({
      since: '2026-08-10T10:00:30Z',
      until: '2026-08-10T10:00:45Z',
      bucket: '1m',
    });
    expect(partialAggregate.status).toBe(200);
    expect(partialAggregate.body).toEqual({
      buckets: [{ start: '2026-08-10T10:00:00.000Z', group: null, count: 1 }],
    });

    const rawFallback = await request(app).get('/logs/aggregate').query({
      since: '2026-08-10T10:00:00Z',
      until: '2026-08-10T10:01:00Z',
      bucket: '1m',
      q: 'newer',
    });
    expect(rawFallback.status).toBe(200);
    expect(rawFallback.body.buckets).toEqual([
      { start: '2026-08-10T10:00:00.000Z', group: null, count: 1 },
    ]);
  });

  it('durably accepts concurrent small requests with per-request accounting', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, requestIndex) =>
        request(app)
          .post('/logs')
          .send({
            logs: [
              logEntry({
                timestamp: `2026-08-10T10:00:${String(requestIndex).padStart(2, '0')}Z`,
                message: `request ${requestIndex}`,
              }),
              logEntry({ level: 'invalid' }),
            ],
          }),
      ),
    );

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body.accepted).toBe(1);
      expect(response.body.rejected).toEqual([{ index: 1, reason: "invalid level: 'invalid'" }]);
    }
    const persisted = await client.query<{ count: string }>('SELECT count(*) FROM logs');
    expect(persisted.rows[0]?.count).toBe('8');
  });

  it('rejects a request larger than the waiting buffer without persisting part of it', async () => {
    const response = await request(app)
      .post('/logs')
      .send({ logs: Array.from({ length: 10_001 }, () => logEntry()) });

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.body).toEqual({ error: 'ingestion buffer full' });
    const persisted = await client.query<{ count: string }>('SELECT count(*) FROM logs');
    expect(persisted.rows[0]?.count).toBe('0');
  });
});

function logEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-08-10T10:00:00Z',
    level: 'info',
    service: 'api',
    message: 'request completed',
    attributes: {},
    ...overrides,
  };
}
