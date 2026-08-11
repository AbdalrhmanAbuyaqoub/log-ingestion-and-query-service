import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../src/db/index.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
  close: vi.fn(),
}));

import request from 'supertest';
import { query } from '../../../src/db/index.js';
import { buildApp } from '../../../src/app.js';

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-08-03T09:59:00Z',
    level: 'error',
    service: 'checkout',
    message: 'payment declined',
    attributes: { user_id: '42' },
    ...overrides,
  };
}

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '1',
    timestamp: new Date('2026-08-08T12:00:00.000Z'),
    level: 'info' as const,
    service: 'checkout',
    message: 'payment accepted',
    attributes: { retries: 3, confirmed: true },
    ...overrides,
  };
}

describe('POST /logs', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('returns 200 {accepted, rejected} for a fully valid batch', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 2 } as never);
    const app = buildApp();

    const res = await request(app)
      .post('/logs')
      .send({ logs: [entry(), entry()] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: 2, rejected: [] });
    expect(vi.mocked(query).mock.calls).toHaveLength(1);
  });

  it('returns 200 with rejected[] for a partially valid batch', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as never);
    const app = buildApp();

    const res = await request(app)
      .post('/logs')
      .send({
        logs: [entry(), entry({ level: 'critical' })],
      });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
    expect(res.body.rejected).toEqual([
      { index: 1, reason: expect.stringMatching(/invalid level/) },
    ]);
  });

  it('returns 400 when all entries are rejected', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/logs')
      .send({
        logs: [entry({ level: 'critical' }), entry({ service: '' })],
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'all entries rejected' });
    expect(vi.mocked(query).mock.calls).toHaveLength(0);
  });

  it('returns 400 on {logs: []}', async () => {
    const app = buildApp();

    const res = await request(app).post('/logs').send({ logs: [] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'empty batch' });
  });

  it('returns 400 when logs is not an array', async () => {
    const app = buildApp();

    const res = await request(app).post('/logs').send({ logs: 'foo' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/array/);
  });

  it('returns 400 on malformed JSON body', async () => {
    const app = buildApp();

    const res = await request(app).post('/logs').type('json').send('{');

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 500 when the database query fails', async () => {
    vi.mocked(query).mockRejectedValue(new Error('connection refused'));
    const app = buildApp();

    const res = await request(app)
      .post('/logs')
      .send({ logs: [entry()] });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal server error' });
  });
});

describe('GET /logs', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('returns the required empty response envelope', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);

    const res = await request(buildApp()).get('/logs');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ logs: [], next_cursor: null });
  });

  it('returns a partial final page with string ids and typed attributes', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [dbRow()] } as never);

    const res = await request(buildApp()).get('/logs?limit=2');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      logs: [
        {
          id: '1',
          timestamp: '2026-08-08T12:00:00.000Z',
          level: 'info',
          service: 'checkout',
          message: 'payment accepted',
          attributes: { retries: 3, confirmed: true },
        },
      ],
      next_cursor: null,
    });
    expect(typeof res.body.logs[0].id).toBe('string');
  });

  it('returns a cursor when the database supplies the lookahead row', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [
        dbRow({ id: '3', timestamp: new Date('2026-08-08T12:02:00.000Z') }),
        dbRow({ id: '2', timestamp: new Date('2026-08-08T12:01:00.000Z') }),
        dbRow({ id: '1', timestamp: new Date('2026-08-08T12:00:00.000Z') }),
      ],
    } as never);

    const res = await request(buildApp()).get('/logs?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.logs.map((log: { id: string }) => log.id)).toEqual(['3', '2']);
    expect(res.body.next_cursor).toEqual(expect.any(String));
  });

  it('accepts freely combined filters and parameterizes their values', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);

    const res = await request(buildApp()).get(
      '/logs?service=checkout&level=error&since=2026-08-08T11%3A00%3A00Z&until=2026-08-08T13%3A00%3A00Z&attr.region=eu&attr.region=us&q=declined&limit=25',
    );

    expect(res.status).toBe(200);
    const [text, params] = vi.mocked(query).mock.calls[0]!;
    expect(text).toContain('service = $1');
    expect(text).toContain('(attributes ->> $5 = $6 OR attributes ->> $7 = $8)');
    expect(params).toEqual([
      'checkout',
      'error',
      new Date('2026-08-08T11:00:00Z'),
      new Date('2026-08-08T13:00:00Z'),
      'region',
      'eu',
      'region',
      'us',
      'declined',
      26,
    ]);
  });

  it('preserves explicit empty filters and escapes message metacharacters', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);

    const res = await request(buildApp()).get('/logs').query({ service: '', q: '%_' });

    expect(res.status).toBe(200);
    expect(vi.mocked(query).mock.calls[0]![1]).toEqual(['', '\\%\\_', 101]);
  });

  it('accepts equal time boundaries as an empty half-open range', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);

    const res = await request(buildApp()).get('/logs').query({
      since: '2026-08-08T12:00:00Z',
      until: '2026-08-08T12:00:00Z',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ logs: [], next_cursor: null });
  });

  it('returns 400 without querying the database for invalid parameters', async () => {
    const invalidQueries = [
      ['/logs?level=critical', 'level'],
      ['/logs?limit=0', 'limit'],
      ['/logs?limit=abc', 'limit'],
      ['/logs?since=not-a-date', 'since'],
      ['/logs?since=2026-08-08T13%3A00%3A00Z&until=2026-08-08T12%3A00%3A00Z', 'until'],
      ['/logs?cursor=not-a-cursor', 'cursor'],
    ] as const;

    for (const [path, error] of invalidQueries) {
      const res = await request(buildApp()).get(path);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.stringMatching(error) });
    }
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });

  it('returns 500 when the database query fails', async () => {
    vi.mocked(query).mockRejectedValue(new Error('connection refused'));

    const res = await request(buildApp()).get('/logs');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal server error' });
  });
});

describe('GET /logs/aggregate', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  const path =
    '/logs/aggregate?since=2026-08-10T10%3A00%3A00Z&until=2026-08-10T11%3A00%3A00Z&bucket=1m';

  it('returns the exact empty response envelope', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);
    const res = await request(buildApp()).get(path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ buckets: [] });
  });

  it('returns grouped buckets with numeric counts', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [{ start: new Date('2026-08-10T10:00:00Z'), group: 'checkout', count: '4' }],
    } as never);
    const res = await request(buildApp()).get(`${path}&group_by=service`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      buckets: [{ start: '2026-08-10T10:00:00.000Z', group: 'checkout', count: 4 }],
    });
  });

  it('accepts equal boundaries and still issues the half-open query', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);
    const equalPath =
      '/logs/aggregate?since=2026-08-10T10%3A00%3A00Z&until=2026-08-10T10%3A00%3A00Z&bucket=1m';
    const res = await request(buildApp()).get(equalPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ buckets: [] });
    expect(vi.mocked(query).mock.calls[0]![0]).toContain('"timestamp" < $2');
  });

  it('combines and parameterizes aggregation filters', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);
    const res = await request(buildApp()).get(
      `${path}&service=checkout&level=error&attr.region=eu&q=declined&group_by=level`,
    );
    expect(res.status).toBe(200);
    const [text, params] = vi.mocked(query).mock.calls[0]!;
    expect(text).toContain('level AS "group"');
    expect(params).toEqual([
      'checkout',
      'error',
      new Date('2026-08-10T10:00:00Z'),
      new Date('2026-08-10T11:00:00Z'),
      'region',
      'eu',
      'declined',
      '1 minute',
    ]);
  });

  it('returns 400 without querying for invalid parameters', async () => {
    for (const invalidPath of [
      '/logs/aggregate?until=2026-08-10T11%3A00%3A00Z&bucket=1m',
      '/logs/aggregate?since=2026-08-10T10%3A00%3A00Z&until=2026-08-10T11%3A00%3A00Z&bucket=10m',
      `${path}&group_by=message`,
    ]) {
      const res = await request(buildApp()).get(invalidPath);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String) });
    }
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });

  it('returns 500 when aggregation fails', async () => {
    vi.mocked(query).mockRejectedValue(new Error('connection refused'));
    const res = await request(buildApp()).get(path);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal server error' });
  });
});
