import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type pg from 'pg';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

const config = loadConfig({ DATABASE_URL: 'postgres://unused' });

describe('GET /health', () => {
  it('returns 200 when the database answers', async () => {
    const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
    const app = buildApp({ pool, config });

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('returns 503 when the database is unreachable', async () => {
    const pool = {
      query: async () => {
        throw new Error('connection refused');
      },
    } as unknown as pg.Pool;
    const app = buildApp({ pool, config });

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable' });
  });
});

describe('malformed JSON body', () => {
  it('returns 400 with err.message on invalid JSON', async () => {
    const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
    const app = buildApp({ pool, config });

    const res = await request(app).post('/health').type('json').send('{');

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });
});

describe('unknown route', () => {
  it('returns 404 with { error: "not found" }', async () => {
    const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
    const app = buildApp({ pool, config });

    const res = await request(app).get('/unknown');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });
});
