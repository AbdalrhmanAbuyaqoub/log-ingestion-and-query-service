import { query } from '../db/index.js';
import { buildAggregateQuery } from './build.js';
import type { AggregateBucket, AggregateQuery, AggregateResult, DbAggregateRow } from './types.js';

export async function aggregateLogs(aggregate: AggregateQuery): Promise<AggregateResult> {
  const { text, params } = buildAggregateQuery(aggregate);
  const { rows } = await query<DbAggregateRow>(text, params);
  return { buckets: rows.map(toAggregateBucket) };
}

function toAggregateBucket(row: DbAggregateRow): AggregateBucket {
  const count = Number(row.count);
  if (!/^\d+$/.test(row.count) || !Number.isSafeInteger(count) || count < 0) {
    throw new Error('database returned an invalid aggregate count');
  }

  return {
    start: row.start.toISOString(),
    group: row.group,
    count,
  };
}
