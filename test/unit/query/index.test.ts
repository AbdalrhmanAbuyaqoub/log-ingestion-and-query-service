import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/db/index.js', () => ({ query: vi.fn() }));

import { query } from '../../../src/db/index.js';
import { decodeCursor } from '../../../src/query/cursor.js';
import { queryLogs } from '../../../src/query/index.js';
import type { LogQuery } from '../../../src/query/types.js';

function logQuery(overrides: Partial<LogQuery> = {}): LogQuery {
  return { attrs: [], limit: 2, ...overrides };
}

function row(overrides: Record<string, unknown> = {}) {
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

describe('queryLogs', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('returns an empty page without a cursor', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);

    await expect(queryLogs(logQuery())).resolves.toEqual({ logs: [], next_cursor: null });
  });

  it('maps a partial page without changing typed attributes', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [row()] } as never);

    await expect(queryLogs(logQuery())).resolves.toEqual({
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
  });

  it('uses the last returned row as the cursor boundary', async () => {
    const rows = [
      row({ id: '3', timestamp: new Date('2026-08-08T12:02:00.000Z') }),
      row({ id: '2', timestamp: new Date('2026-08-08T12:01:00.000Z') }),
      row({ id: '1', timestamp: new Date('2026-08-08T12:00:00.000Z') }),
    ];
    vi.mocked(query).mockResolvedValue({ rows } as never);

    const result = await queryLogs(logQuery());

    expect(result.logs.map((log) => log.id)).toEqual(['3', '2']);
    expect(decodeCursor(result.next_cursor!)).toEqual({
      t: '2026-08-08T12:01:00.000Z',
      id: '2',
    });
  });
});
