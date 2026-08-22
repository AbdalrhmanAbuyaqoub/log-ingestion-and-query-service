import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/db/index.js', () => ({
  getClient: vi.fn(),
}));
import {
  RetentionInvariantError,
  ensurePartitionsForTimestamps,
  isDayRetained,
  partitionName,
  dropExpiredPartitions,
  utcDayStart,
} from '../../../src/retention/partition-manager.js';
import { getClient } from '../../../src/db/index.js';

beforeEach(() => vi.mocked(getClient).mockReset());

describe('partition date helpers', () => {
  it('uses UTC day boundaries regardless of timestamp offset', () => {
    expect(utcDayStart(new Date('2026-08-12T00:30:00+03:00')).toISOString()).toBe(
      '2026-08-11T00:00:00.000Z',
    );
  });

  it('generates deterministic partition names across leap days', () => {
    expect(partitionName(new Date('2028-02-29T23:59:59Z'))).toBe('logs_p2028_02_29');
  });

  it('retains a partition until its whole UTC day is expired', () => {
    const now = new Date('2026-08-12T15:00:00Z');
    expect(isDayRetained(new Date('2026-07-13T00:00:00Z'), now, 30)).toBe(true);
    expect(isDayRetained(new Date('2026-07-12T00:00:00Z'), now, 30)).toBe(false);
  });
});

describe('partition operations', () => {
  it('does no database work when every timestamp is fully expired', async () => {
    await expect(
      ensurePartitionsForTimestamps(
        [new Date('2026-06-01T12:00:00Z')],
        30,
        new Date('2026-08-12T15:00:00Z'),
      ),
    ).resolves.toBe(0);
    expect(getClient).not.toHaveBeenCalled();
  });

  it('deduplicates same-day checks and avoids the advisory lock when partitions exist', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ exists: true }] });
    const release = vi.fn();
    vi.mocked(getClient).mockResolvedValue({ query, release } as never);

    await expect(
      ensurePartitionsForTimestamps(
        [new Date('2026-08-10T01:00:00Z'), new Date('2026-08-10T22:00:00Z')],
        30,
        new Date('2026-08-12T15:00:00Z'),
      ),
    ).resolves.toBe(0);

    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).not.toContain('pg_advisory_lock');
    expect(release).toHaveBeenCalledOnce();
  });

  it('caches confirmed partitions and deduplicates concurrent checks', async () => {
    let finishCheck!: () => void;
    const checkBlocked = new Promise<void>((resolve) => {
      finishCheck = resolve;
    });
    const query = vi.fn(async () => {
      await checkBlocked;
      return { rows: [{ exists: true }] };
    });
    const release = vi.fn();
    vi.mocked(getClient).mockResolvedValue({ query, release } as never);
    const timestamp = new Date('2026-09-01T12:00:00Z');
    const now = new Date('2026-09-02T12:00:00Z');

    const first = ensurePartitionsForTimestamps([timestamp], 30, now);
    const second = ensurePartitionsForTimestamps([timestamp], 30, now);
    await vi.waitFor(() => expect(getClient).toHaveBeenCalledOnce());
    finishCheck();

    await expect(Promise.all([first, second])).resolves.toEqual([0, 0]);
    await expect(ensurePartitionsForTimestamps([timestamp], 30, now)).resolves.toBe(0);
    expect(getClient).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledOnce();
  });

  it('skips hourly maintenance when another replica owns the lock', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ locked: false }] });
    const release = vi.fn();
    vi.mocked(getClient).mockResolvedValue({ query, release } as never);

    await expect(dropExpiredPartitions(30)).resolves.toEqual({
      skipped: true,
      dropped: 0,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back all maintenance when the default contains a retained log', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            total_count: '2',
            retained_count: '1',
            earliest_retained: new Date('2026-08-10T10:00:00Z'),
            latest_retained: new Date('2026-08-10T10:00:00Z'),
          },
        ],
      })
      .mockResolvedValue({ rows: [] });
    const release = vi.fn();
    vi.mocked(getClient).mockResolvedValue({ query, release } as never);

    const error = await dropExpiredPartitions(30, new Date('2026-08-12T15:00:00Z')).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(RetentionInvariantError);
    expect(error).toMatchObject({
      code: 'RETENTION_DEFAULT_CONTAINS_RETAINED_LOGS',
      retainedRows: '1',
      cutoff: new Date('2026-07-13T00:00:00Z'),
    });
    expect(query.mock.calls.map(([text]) => String(text))).toEqual([
      expect.stringContaining('pg_try_advisory_lock'),
      'BEGIN',
      'LOCK TABLE logs IN ACCESS EXCLUSIVE MODE',
      expect.stringContaining('FROM logs_default'),
      'ROLLBACK',
      expect.stringContaining('pg_advisory_unlock'),
    ]);
    expect(release).toHaveBeenCalledOnce();
  });
});
