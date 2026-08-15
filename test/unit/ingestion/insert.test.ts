import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../src/db/index.js', () => ({
  ingestQuery: vi.fn(),
  getClient: vi.fn(),
  close: vi.fn(),
}));
vi.mock('../../../src/retention/partition-manager.js', () => ({
  ensurePartitionsForTimestamps: vi.fn().mockResolvedValue(0),
}));

import { insertLogs } from '../../../src/ingestion/insert.js';
import { ingestQuery } from '../../../src/db/index.js';
import type { ValidLogEntry } from '../../../src/ingestion/types.js';
import { ensurePartitionsForTimestamps } from '../../../src/retention/partition-manager.js';

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
    vi.mocked(ingestQuery).mockReset();
    vi.mocked(ensurePartitionsForTimestamps).mockClear();
  });

  it('returns 0 and issues no query when entries is empty', async () => {
    const n = await insertLogs([]);
    expect(n).toBe(0);
    expect(vi.mocked(ingestQuery)).not.toHaveBeenCalled();
  });

  it('issues one INSERT via unnest with five arrays', async () => {
    vi.mocked(ingestQuery).mockResolvedValue({ rows: [], rowCount: 2 } as never);
    const entries = [entry(), entry({ level: 'info' })];

    await insertLogs(entries);

    expect(vi.mocked(ensurePartitionsForTimestamps)).toHaveBeenCalledOnce();
    expect(vi.mocked(ingestQuery)).toHaveBeenCalledTimes(1);
    const [text, values] = vi.mocked(ingestQuery).mock.calls[0]!;
    expect(text).toMatch(/INSERT INTO logs/);
    expect(text).toMatch(/unnest/);
    expect(text).toMatch(/INSERT INTO log_rollups_1m/);
    expect(text).toMatch(/ON CONFLICT/);
    expect(text).not.toMatch(/SELECT COUNT\(\*\)::text AS accepted/);
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

  it('returns the input count after the atomic statement succeeds', async () => {
    vi.mocked(ingestQuery).mockResolvedValue({ rows: [], rowCount: 1 } as never);
    const n = await insertLogs(Array.from({ length: 7 }, () => entry()));
    expect(n).toBe(7);
  });

  it('propagates driver errors', async () => {
    vi.mocked(ingestQuery).mockRejectedValue(new Error('boom'));
    await expect(insertLogs([entry()])).rejects.toThrow('boom');
  });
});
