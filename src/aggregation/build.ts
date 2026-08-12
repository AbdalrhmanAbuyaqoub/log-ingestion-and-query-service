import { buildFilterWhere } from '../query/build.js';
import type { BuiltQuery } from '../query/types.js';
import type { AggregateBucketSize, AggregateGroupBy, AggregateQuery } from './types.js';

// SELECT
//   date_bin($bucket::interval, "timestamp", '1970-01-01T00:00:00Z'::timestamptz) AS start,
//   [service | level | NULL::text] AS "group",
//   COUNT(*) AS count
// FROM logs
// WHERE
//   [service]   service = $n
//   [level]     AND level = $n
//   [since]     AND "timestamp" >= $n
//   [until]     AND "timestamp" < $n
//   [attr.key]  AND attributes ->> $n = $n
//   [q]         AND message ILIKE ('%' || $n || '%') ESCAPE '\'
// GROUP BY 1 [, 2]
// ORDER BY start ASC, "group" ASC

const BUCKET_INTERVALS: Record<AggregateBucketSize, string> = {
  '1m': '1 minute',
  '5m': '5 minutes',
  '1h': '1 hour',
  '1d': '1 day',
};

const GROUP_COLUMNS: Record<AggregateGroupBy, string> = {
  service: 'service',
  level: 'level',
};

export function buildAggregateQuery(aggregate: AggregateQuery): BuiltQuery {
  const filters = buildFilterWhere(aggregate);
  const intervalPlaceholder = `$${filters.nextPlaceholder}`;
  const groupExpression = getGroupExpression(aggregate.groupBy);
  const groupBy = aggregate.groupBy ? 'GROUP BY 1, 2' : 'GROUP BY 1';

  const text = `
SELECT
  date_bin(${intervalPlaceholder}::interval, "timestamp", '1970-01-01T00:00:00Z'::timestamptz) AS start,
  ${groupExpression} AS "group",
  COUNT(*) AS count
FROM logs
${filters.whereClause}
${groupBy}
ORDER BY start ASC, "group" ASC
`.trim();

  return {
    text,
    params: [...filters.params, BUCKET_INTERVALS[aggregate.bucket]],
  };
}

export function canUseRollups(aggregate: AggregateQuery): boolean {
  return aggregate.attrs.length === 0 && aggregate.q === undefined;
}

export function buildRollupAggregateQuery(aggregate: AggregateQuery): BuiltQuery {
  const params: unknown[] = [aggregate.since, aggregate.until];
  const rawFilters: string[] = [];
  const rollupFilters: string[] = [];

  if (aggregate.service !== undefined) {
    params.push(aggregate.service);
    const placeholder = `$${params.length}`;
    rawFilters.push(`l.service = ${placeholder}`);
    rollupFilters.push(`r.service = ${placeholder}`);
  }
  if (aggregate.level !== undefined) {
    params.push(aggregate.level);
    const placeholder = `$${params.length}`;
    rawFilters.push(`l.level = ${placeholder}`);
    rollupFilters.push(`r.level = ${placeholder}`);
  }

  params.push(BUCKET_INTERVALS[aggregate.bucket]);
  const intervalPlaceholder = `$${params.length}`;
  const groupExpression = getGroupExpression(aggregate.groupBy);
  const rawSuffix = rawFilters.length > 0 ? `\n    AND ${rawFilters.join('\n    AND ')}` : '';
  const rollupSuffix =
    rollupFilters.length > 0 ? `\n    AND ${rollupFilters.join('\n    AND ')}` : '';

  const text = `
WITH bounds AS (
  SELECT
    date_trunc('minute', $1::timestamptz) AS rollup_start,
    CASE
      WHEN $2::timestamptz = date_trunc('minute', $2::timestamptz)
        THEN $2::timestamptz
      ELSE date_trunc('minute', $2::timestamptz) + interval '1 minute'
    END AS rollup_end
), source AS (
  SELECT r.bucket_start AS event_timestamp, r.service, r.level, r.count
  FROM log_rollups_1m r
  CROSS JOIN bounds b
  WHERE r.bucket_start >= b.rollup_start
    AND r.bucket_start < b.rollup_end${rollupSuffix}

  UNION ALL

  SELECT l."timestamp" AS event_timestamp, l.service, l.level, -1::bigint AS count
  FROM logs l
  CROSS JOIN bounds b
  WHERE l."timestamp" >= b.rollup_start
    AND l."timestamp" < $1${rawSuffix}

  UNION ALL

  SELECT l."timestamp" AS event_timestamp, l.service, l.level, -1::bigint AS count
  FROM logs l
  CROSS JOIN bounds b
  WHERE l."timestamp" >= $2
    AND l."timestamp" < b.rollup_end${rawSuffix}
)
SELECT
  date_bin(${intervalPlaceholder}::interval, event_timestamp, '1970-01-01T00:00:00Z'::timestamptz) AS start,
  ${groupExpression} AS "group",
  SUM(count) AS count
FROM source
GROUP BY 1${aggregate.groupBy ? ', 2' : ''}
HAVING SUM(count) > 0
ORDER BY start ASC, "group" ASC
`.trim();

  return { text, params };
}

function getGroupExpression(groupBy: AggregateGroupBy | undefined): string {
  if (groupBy === undefined) return 'NULL::text';
  const column = GROUP_COLUMNS[groupBy];
  if (!column) throw new Error('invalid aggregate grouping');
  return column;
}
