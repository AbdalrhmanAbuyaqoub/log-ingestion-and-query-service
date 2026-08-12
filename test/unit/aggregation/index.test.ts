import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/db/index.js', () => ({ query: vi.fn() }));

import { query } from '../../../src/db/index.js';
import { aggregateLogs } from '../../../src/aggregation/index.js';
import type { AggregateQuery } from '../../../src/aggregation/types.js';

const aggregate: AggregateQuery = {
  since: new Date('2026-08-10T10:00:00Z'),
  until: new Date('2026-08-10T11:00:00Z'),
  bucket: '1m',
  attrs: [],
};

describe('aggregateLogs', () => {
  beforeEach(() => vi.mocked(query).mockReset());

  it('returns an empty buckets envelope', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);
    await expect(aggregateLogs(aggregate)).resolves.toEqual({ buckets: [] });
    expect(vi.mocked(query).mock.calls[0]?.[0]).toContain('log_rollups_1m');
  });

  it('uses canonical logs when a filter cannot be represented by rollups', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);
    await aggregateLogs({ ...aggregate, q: 'timeout' });
    expect(vi.mocked(query).mock.calls[0]?.[0]).not.toContain('log_rollups_1m');
  });

  it('maps timestamps, nullable groups, and numeric counts', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [
        { start: new Date('2026-08-10T10:00:00Z'), group: null, count: '2' },
        { start: new Date('2026-08-10T10:01:00Z'), group: 'checkout', count: '3' },
      ],
    } as never);
    await expect(aggregateLogs(aggregate)).resolves.toEqual({
      buckets: [
        { start: '2026-08-10T10:00:00.000Z', group: null, count: 2 },
        { start: '2026-08-10T10:01:00.000Z', group: 'checkout', count: 3 },
      ],
    });
  });

  it('rejects invalid or unsafe database counts', async () => {
    for (const count of ['', '-1', '1.5', 'not-a-number', '9007199254740992']) {
      vi.mocked(query).mockResolvedValue({
        rows: [{ start: new Date('2026-08-10T10:00:00Z'), group: null, count }],
      } as never);
      await expect(aggregateLogs(aggregate)).rejects.toThrow(
        'database returned an invalid aggregate count',
      );
    }
  });
});
