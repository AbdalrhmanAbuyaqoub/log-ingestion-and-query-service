import type { LogFilters } from '../query/types.js';

export const AGGREGATE_BUCKETS = ['1m', '5m', '1h', '1d'] as const;
export type AggregateBucketSize = (typeof AGGREGATE_BUCKETS)[number];

export const AGGREGATE_GROUPS = ['service', 'level'] as const;
export type AggregateGroupBy = (typeof AGGREGATE_GROUPS)[number];

export type AggregateQuery = LogFilters & {
  since: Date;
  until: Date;
  bucket: AggregateBucketSize;
  groupBy?: AggregateGroupBy;
};

export type DbAggregateRow = {
  start: Date;
  group: string | null;
  count: string;
};

export type AggregateBucket = {
  start: string;
  group: string | null;
  count: number;
};

export type AggregateResult = { buckets: AggregateBucket[] };
