import { describe, expect, it } from 'vitest';
import {
  buildAggregateQuery,
  buildRollupAggregateQuery,
  canUseRollups,
} from '../../../src/aggregation/build.js';
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

describe('buildRollupAggregateQuery', () => {
  it('uses rollups for supported filters and raw logs only at partial minute boundaries', () => {
    const input = aggregate({ service: 'checkout', level: 'error', groupBy: 'service' });
    expect(canUseRollups(input)).toBe(true);

    const built = buildRollupAggregateQuery(input);

    expect(built.text).toContain('FROM log_rollups_1m r');
    expect(built.text).toContain('FROM logs l');
    expect(built.text).toContain('r.bucket_start >= $3');
    expect(built.text).toContain('r.bucket_start < $4');
    expect(built.text).toContain('l."timestamp" >= $3');
    expect(built.text).toContain('l."timestamp" < $1');
    expect(built.text).toContain('l."timestamp" >= $2');
    expect(built.text).toContain('l."timestamp" < $4');
    expect(built.text).not.toContain('CROSS JOIN bounds');
    expect(built.text).toContain('-1::bigint AS count');
    expect(built.text).toContain('HAVING SUM(count) > 0');
    expect(built.text).toContain('r.service = $5');
    expect(built.text).toContain('l.level = $6');
    expect(built.text).toContain('date_bin($7::interval');
    expect(built.params).toEqual([
      input.since,
      input.until,
      new Date('2026-08-10T10:00:00Z'),
      new Date('2026-08-10T11:01:00Z'),
      'checkout',
      'error',
      '1 minute',
    ]);

    const aligned = buildRollupAggregateQuery(
      aggregate({
        since: new Date('2026-08-10T10:00:00Z'),
        until: new Date('2026-08-10T11:00:00Z'),
      }),
    );
    expect(aligned.params.slice(2, 4)).toEqual([
      new Date('2026-08-10T10:00:00Z'),
      new Date('2026-08-10T11:00:00Z'),
    ]);
  });

  it('falls back to raw aggregation for attribute or message filters', () => {
    expect(canUseRollups(aggregate({ attrs: [{ key: 'region', values: ['eu'] }] }))).toBe(false);
    expect(canUseRollups(aggregate({ q: 'timeout' }))).toBe(false);
  });
});
