import { describe, expect, it, vi } from 'vitest';
import { insertLogs } from '../../../src/ingestion/insert.js';
import type { Queryable, ValidLogEntry } from '../../../src/ingestion/types.js';

function entry(overrides: Partial<ValidLogEntry> = {}): ValidLogEntry {
  return {
    timestamp: new Date('2026-08-03T09:59:00Z'),
    level: 'error',
    service: 'checkout',
    message: 'payment declined',
    attributes: { retries: 3 },
    ...overrides,
  };
}

type MockedQuery = Queryable & { query: ReturnType<typeof vi.fn> };

function mockDb(): MockedQuery {
  const query = vi.fn(async () => ({ rows: [], rowCount: 2 }));
  return { query } as MockedQuery;
}

describe('insertLogs', () => {
  it('returns 0 and issues no query when entries is empty', async () => {
    const db = mockDb();
    const n = await insertLogs(db, []);
    expect(n).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('issues one INSERT via unnest with five arrays', async () => {
    const db = mockDb();
    const entries = [entry(), entry({ level: 'info' })];

    await insertLogs(db, entries);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [text, values] = db.query.mock.calls[0]!;
    expect(text).toMatch(/INSERT INTO logs/);
    expect(text).toMatch(/unnest/);
    expect(text).toMatch(/\$1::timestamptz\[\]/);
    expect(text).toMatch(/\$5::jsonb\[\]/);
    expect(values).toHaveLength(5);
    expect(values[0]).toEqual([entries[0]!.timestamp, entries[1]!.timestamp]);
    expect(values[1]).toEqual(['error', 'info']);
    expect(values[2]).toEqual(['checkout', 'checkout']);
    expect(values[3]).toEqual(['payment declined', 'payment declined']);
    expect(values[4]).toEqual(['{"retries":3}', '{"retries":3}']);
  });

  it('returns rowCount when the driver reports it', async () => {
    const db: Queryable = {
      query: vi.fn(async () => ({ rows: [], rowCount: 7 })),
    };
    const n = await insertLogs(
      db,
      Array.from({ length: 7 }, () => entry()),
    );
    expect(n).toBe(7);
  });

  it('falls back to entries.length when rowCount is undefined', async () => {
    const db: Queryable = { query: vi.fn(async () => ({ rows: [] })) };
    const n = await insertLogs(db, [entry(), entry(), entry()]);
    expect(n).toBe(3);
  });

  it('propagates driver errors', async () => {
    const db: Queryable = { query: vi.fn(async () => Promise.reject(new Error('boom'))) };
    await expect(insertLogs(db, [entry()])).rejects.toThrow('boom');
  });
});
