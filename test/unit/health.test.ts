import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/index.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
  close: vi.fn(),
}));

import request from 'supertest';
import { query } from '../../src/db/index.js';
import { buildApp } from '../../src/app.js';

describe('GET /health', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('returns 200 when the database answers', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as never);
    const app = buildApp();

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('returns 503 when the database is unreachable', async () => {
    vi.mocked(query).mockRejectedValue(new Error('connection refused'));
    const app = buildApp();

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable' });
  });
});

describe('malformed JSON body', () => {
  it('returns 400 with err.message on invalid JSON', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as never);
    const app = buildApp();

    const res = await request(app).post('/health').type('json').send('{');

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });
});

describe('POST /logs with only invalid entries', () => {
  it('returns every rejection with an accepted count of zero', async () => {
    vi.mocked(query).mockReset();
    const app = buildApp();

    const res = await request(app)
      .post('/logs')
      .send({
        logs: [
          {
            timestamp: '2026-08-10T10:00:00Z',
            level: 'critical',
            service: 'api',
            message: 'first invalid entry',
          },
          {
            timestamp: '2026-08-10T10:00:00Z',
            level: 'fatal',
            service: 'api',
            message: 'second invalid entry',
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      accepted: 0,
      rejected: [
        { index: 0, reason: "invalid level: 'critical'" },
        { index: 1, reason: "invalid level: 'fatal'" },
      ],
    });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('unknown route', () => {
  it('returns 404 with { error: "not found" }', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as never);
    const app = buildApp();

    const res = await request(app).get('/unknown');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });
});
