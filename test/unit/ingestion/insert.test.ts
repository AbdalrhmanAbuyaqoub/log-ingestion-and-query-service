import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../src/db/index.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
  close: vi.fn(),
}));

import { insertLogs } from '../../../src/ingestion/insert.js';
import { query } from '../../../src/db/index.js';
import type { ValidLogEntry } from '../../../src/ingestion/types.js';

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

describe('insertLogs', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('returns 0 and issues no query when entries is empty', async () => {
    const n = await insertLogs([]);
    expect(n).toBe(0);
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });

  it('issues one INSERT via unnest with five arrays', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 2 } as never);
    const entries = [entry(), entry({ level: 'info' })];

    await insertLogs(entries);

    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
    const [text, values] = vi.mocked(query).mock.calls[0]!;
    expect(text).toMatch(/INSERT INTO logs/);
    expect(text).toMatch(/unnest/);
    expect(text).toMatch(/\$1::timestamptz\[\]/);
    expect(text).toMatch(/\$5::jsonb\[\]/);
    expect(values).toHaveLength(5);
    const params = values!;
    expect(params[0]).toEqual([entries[0]!.timestamp, entries[1]!.timestamp]);
    expect(params[1]).toEqual(['error', 'info']);
    expect(params[2]).toEqual(['checkout', 'checkout']);
    expect(params[3]).toEqual(['payment declined', 'payment declined']);
    expect(params[4]).toEqual(['{"retries":3}', '{"retries":3}']);
  });

  it('returns rowCount when the driver reports it', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 7 } as never);
    const n = await insertLogs(Array.from({ length: 7 }, () => entry()));
    expect(n).toBe(7);
  });

  it('falls back to entries.length when rowCount is undefined', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);
    const n = await insertLogs([entry(), entry(), entry()]);
    expect(n).toBe(3);
  });

  it('propagates driver errors', async () => {
    vi.mocked(query).mockRejectedValue(new Error('boom'));
    await expect(insertLogs([entry()])).rejects.toThrow('boom');
  });
});
