import { describe, expect, it } from 'vitest';
import { buildAggregateQuery } from '../../../src/aggregation/build.js';
import type { AggregateQuery } from '../../../src/aggregation/types.js';

function aggregate(overrides: Partial<AggregateQuery> = {}): AggregateQuery {
  return {
    since: new Date('2026-08-10T10:00:30Z'),
    until: new Date('2026-08-10T11:00:20Z'),
    bucket: '1m',
    attrs: [],
    ...overrides,
  };
}

describe('buildAggregateQuery', () => {
  it('maps each public bucket to a parameterized PostgreSQL interval', () => {
    for (const [bucket, interval] of [
      ['1m', '1 minute'],
      ['5m', '5 minutes'],
      ['1h', '1 hour'],
      ['1d', '1 day'],
    ] as const) {
      const built = buildAggregateQuery(aggregate({ bucket }));
      expect(built.text).toContain('date_bin($3::interval');
      expect(built.params).toEqual([aggregate().since, aggregate().until, interval]);
    }
  });

  it('builds UTC-aligned ungrouped aggregation', () => {
    const built = buildAggregateQuery(aggregate());
    expect(built.text).toContain("'1970-01-01T00:00:00Z'::timestamptz");
    expect(built.text).toContain('NULL::text AS "group"');
    expect(built.text).toContain('GROUP BY 1');
    expect(built.text).not.toContain('GROUP BY 1, 2');
    expect(built.text).toContain('ORDER BY start ASC, "group" ASC');
  });

  it('groups only by allowlisted service or level columns', () => {
    for (const groupBy of ['service', 'level'] as const) {
      const built = buildAggregateQuery(aggregate({ groupBy }));
      expect(built.text).toContain(`${groupBy} AS "group"`);
      expect(built.text).toContain('GROUP BY 1, 2');
    }
  });

  it('reuses all filter predicates with continuous placeholders', () => {
    const built = buildAggregateQuery(
      aggregate({
        service: 'checkout',
        level: 'error',
        attrs: [{ key: 'region', values: ['eu', 'us'] }],
        q: 'declined',
        groupBy: 'service',
      }),
    );
    expect(built.text).toContain('service = $1');
    expect(built.text).toContain('level = $2');
    expect(built.text).toContain('"timestamp" >= $3');
    expect(built.text).toContain('"timestamp" < $4');
    expect(built.text).toContain('(attributes ->> $5 = $6 OR attributes ->> $7 = $8)');
    expect(built.text).toContain("message ILIKE ('%' || $9 || '%') ESCAPE '\\'");
    expect(built.text).toContain('date_bin($10::interval');
    expect(built.params).toEqual([
      'checkout',
      'error',
      aggregate().since,
      aggregate().until,
      'region',
      'eu',
      'region',
      'us',
      'declined',
      '1 minute',
    ]);
  });

  it('never interpolates filter values into SQL', () => {
    const attack = "x'; DROP TABLE logs; --";
    const built = buildAggregateQuery(
      aggregate({ service: attack, attrs: [{ key: attack, values: [attack] }], q: attack }),
    );
    expect(built.text).not.toContain(attack);
    expect(built.params.filter((value) => value === attack)).toHaveLength(4);
  });
});
