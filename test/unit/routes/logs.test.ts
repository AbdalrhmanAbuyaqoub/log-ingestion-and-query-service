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
