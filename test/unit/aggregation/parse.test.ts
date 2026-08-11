import { describe, expect, it } from 'vitest';
import type { ParsedQs } from 'qs';
import { parseAggregateQuery } from '../../../src/aggregation/parse.js';

function parse(query: Record<string, unknown>) {
  return parseAggregateQuery(query as ParsedQs);
}

const required = {
  since: '2026-08-10T10:00:00Z',
  until: '2026-08-10T11:00:00Z',
  bucket: '1m',
};

describe('parseAggregateQuery', () => {
  it('parses every supported bucket and grouping dimension', () => {
    for (const bucket of ['1m', '5m', '1h', '1d'] as const) {
      expect(parse({ ...required, bucket }).bucket).toBe(bucket);
    }
    for (const groupBy of ['service', 'level'] as const) {
      expect(parse({ ...required, group_by: groupBy }).groupBy).toBe(groupBy);
    }
  });

  it('parses freely combined filters', () => {
    expect(
      parse({
        ...required,
        service: 'checkout',
        level: 'error',
        q: '100%_done',
        'attr.region': ['eu', 'us'],
      }),
    ).toEqual({
      service: 'checkout',
      level: 'error',
      since: new Date(required.since),
      until: new Date(required.until),
      attrs: [{ key: 'region', values: ['eu', 'us'] }],
      q: '100\\%\\_done',
      bucket: '1m',
      groupBy: undefined,
    });
  });

  it('preserves explicitly empty optional string filters', () => {
    const result = parse({ ...required, service: '', q: '', 'attr.region': '' });
    expect(result.service).toBe('');
    expect(result.q).toBe('');
    expect(result.attrs).toEqual([{ key: 'region', values: [''] }]);
  });

  it('requires since, until, and bucket', () => {
    for (const field of ['since', 'until', 'bucket'] as const) {
      const query: Record<string, unknown> = { ...required };
      delete query[field];
      expect(() => parse(query)).toThrow(`${field} is required`);
    }
  });

  it('rejects repeated scalar parameters', () => {
    for (const field of ['since', 'until', 'bucket', 'group_by', 'service', 'level', 'q']) {
      expect(() => parse({ ...required, [field]: ['one', 'two'] })).toThrow(
        `${field} must not be repeated`,
      );
    }
  });

  it('rejects unsupported buckets, groups, and levels', () => {
    expect(() => parse({ ...required, bucket: '10m' })).toThrow("invalid bucket: '10m'");
    expect(() => parse({ ...required, group_by: 'message' })).toThrow(
      "invalid group_by: 'message'",
    );
    expect(() => parse({ ...required, level: 'critical' })).toThrow("invalid level: 'critical'");
  });

  it('rejects invalid and reversed ranges but accepts equality', () => {
    expect(() => parse({ ...required, since: 'invalid' })).toThrow('invalid since');
    expect(() =>
      parse({ ...required, since: '2026-08-10T12:00:00Z', until: required.until }),
    ).toThrow('until must not be earlier than since');
    expect(parse({ ...required, until: required.since }).until).toEqual(new Date(required.since));
  });

  it('rejects nested query values', () => {
    expect(() => parse({ ...required, service: { nested: 'checkout' } })).toThrow(
      'invalid query parameter: service',
    );
  });
});
