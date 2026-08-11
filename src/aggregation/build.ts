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

function getGroupExpression(groupBy: AggregateGroupBy | undefined): string {
  if (groupBy === undefined) return 'NULL::text';
  const column = GROUP_COLUMNS[groupBy];
  if (!column) throw new Error('invalid aggregate grouping');
  return column;
}
