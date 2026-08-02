import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildServer } from '../../src/http/server.js';
import { loadConfig } from '../../src/config.js';

const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'fatal' });

describe('GET /health', () => {
  it('returns 200 when the database answers', async () => {
    const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
    const app = buildServer({ pool, config });

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('returns 503 when the database is unreachable', async () => {
    const pool = {
      query: async () => {
        throw new Error('connection refused');
      },
    } as unknown as pg.Pool;
    const app = buildServer({ pool, config });

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
    await app.close();
  });
});
