import { describe, expect, it } from 'vitest';
import { buildQuery } from '../../../src/query/build.js';
import type { LogQuery } from '../../../src/query/types.js';

// helper that creates a valid LogQuery with convenient defaults.
// Avoids repeating attrs: [] and limit: 100
function logQuery(overrides: Partial<LogQuery> = {}): LogQuery {
  return { attrs: [], limit: 100, ...overrides };
}

describe('buildQuery', () => {
  it('builds the default ordered query with one extra row for pagination', () => {
    const built = buildQuery(logQuery());

    expect(built.text).toContain('FROM logs AS l');
    expect(built.text).not.toContain('WHERE');
    expect(built.text).toContain('ORDER BY l."timestamp" DESC, l.id DESC');
    expect(built.text).toContain('LIMIT $1');
    expect(built.params).toEqual([101]);
  });

  it('builds inclusive since and exclusive until predicates', () => {
    const since = new Date('2026-07-20T14:00:00Z');
    const until = new Date('2026-07-20T15:00:00Z');
    const built = buildQuery(logQuery({ since, until }));

    expect(built.text).toContain('"timestamp" >= $1');
    expect(built.text).toContain('"timestamp" < $2');
    expect(built.params).toEqual([since, until, 101]);
  });

  it('builds service and level equality predicates', () => {
    const built = buildQuery(logQuery({ service: 'checkout', level: 'error' }));

    expect(built.text).toContain('service = $1');
    expect(built.text).toContain('level = $2');
    expect(built.params).toEqual(['checkout', 'error', 101]);
  });

  it('preserves an explicitly empty service filter', () => {
    const built = buildQuery(logQuery({ service: '' }));

    expect(built.text).toContain('service = $1');
    expect(built.params).toEqual(['', 101]);
  });

  it('builds a parameterized message substring predicate with a LIKE escape clause', () => {
    const built = buildQuery(logQuery({ q: '100\\%\\_done' }));

    expect(built.text).toContain("message ILIKE ('%' || $1 || '%') ESCAPE '\\'");
    expect(built.params).toEqual(['100\\%\\_done', 101]);
  });

  it('compares attribute values as parameterized JSON text', () => {
    const built = buildQuery(logQuery({ attrs: [{ key: 'retry_count', values: ['3', '4'] }] }));

    expect(built.text).toContain('(attributes ->> $1 = $2 OR attributes ->> $3 = $4)');
    expect(built.text).not.toContain('@>');
    expect(built.params).toEqual(['retry_count', '3', 'retry_count', '4', 101]);
  });

  it('combines distinct attribute keys with separate AND predicates', () => {
    const built = buildQuery(
      logQuery({
        attrs: [
          { key: 'region', values: ['eu'] },
          { key: 'enabled', values: ['true'] },
        ],
      }),
    );

    expect(built.text).toContain('(attributes ->> $1 = $2)\n  AND (attributes ->> $3 = $4)');
    expect(built.params).toEqual(['region', 'eu', 'enabled', 'true', 101]);
  });

  it('builds the strict keyset cursor predicate without converting the bigint id', () => {
    const timestamp = new Date('2026-07-20T14:00:00Z');
    const built = buildQuery(logQuery({ cursor: { t: timestamp, id: '9007199254740993' } }));

    expect(built.text).toContain('("timestamp", id) < ($1, $2::bigint)');
    expect(built.params).toEqual([timestamp, '9007199254740993', 101]);
  });

  it('keeps continuous placeholders and parameter order for all filters combined', () => {
    const since = new Date('2026-07-20T14:00:00Z');
    const until = new Date('2026-07-20T15:00:00Z');
    const cursorTime = new Date('2026-07-20T14:30:00Z');
    const built = buildQuery(
      logQuery({
        service: 'checkout',
        level: 'error',
        since,
        until,
        attrs: [{ key: 'region', values: ['eu', 'us'] }],
        q: 'declined',
        cursor: { t: cursorTime, id: '42' },
        limit: 10,
      }),
    );

    for (let placeholder = 1; placeholder <= 11; placeholder += 1) {
      expect(built.text).toContain(`$${placeholder}`);
    }
    expect(built.params).toEqual([
      'checkout',
      'error',
      since,
      until,
      'region',
      'eu',
      'region',
      'us',
      'declined',
      cursorTime,
      '42',
      11,
    ]);
    expect(built.text).toContain('LIMIT $12');
  });

  it('never interpolates user-controlled values into SQL text', () => {
    const attacks = ["checkout'; DROP TABLE logs; --", "%'; SELECT pg_sleep(10); --"];
    const built = buildQuery(
      logQuery({
        service: attacks[0],
        q: attacks[1],
        attrs: [{ key: 'x -> malicious', values: attacks }],
      }),
    );

    for (const value of ['x -> malicious', ...attacks]) {
      expect(built.text).not.toContain(value);
      expect(built.params).toContain(value);
    }
  });
});
