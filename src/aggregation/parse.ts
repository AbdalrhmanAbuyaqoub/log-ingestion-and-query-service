import type { ParsedQs } from 'qs';
import { ValidationError } from '../ingestion/errors.js';
import {
  normalizeQuery,
  parseAttrs,
  parseOptionalLevel,
  parseOptionalMessageQuery,
  parseOptionalScalar,
  parseRequiredScalar,
  parseRequiredTimestamp,
  validateTimeRange,
} from '../query/parser-common.js';
import {
  AGGREGATE_BUCKETS,
  AGGREGATE_GROUPS,
  type AggregateBucketSize,
  type AggregateGroupBy,
  type AggregateQuery,
} from './types.js';

export function parseAggregateQuery(raw: ParsedQs): AggregateQuery {
  const query = normalizeQuery(raw);
  const since = parseRequiredTimestamp(query.since, 'since');
  const until = parseRequiredTimestamp(query.until, 'until');
  validateTimeRange(since, until);

  return {
    service: parseOptionalScalar(query.service, 'service'),
    level: parseOptionalLevel(query.level),
    since,
    until,
    attrs: parseAttrs(query),
    q: parseOptionalMessageQuery(query.q),
    bucket: parseBucket(query.bucket),
    groupBy: parseGroupBy(query.group_by),
  };
}

function parseBucket(raw: string | string[] | undefined): AggregateBucketSize {
  const value = parseRequiredScalar(raw, 'bucket');
  if (!AGGREGATE_BUCKETS.includes(value as AggregateBucketSize)) {
    throw new ValidationError(`invalid bucket: '${value}'`);
  }
  return value as AggregateBucketSize;
}

function parseGroupBy(raw: string | string[] | undefined): AggregateGroupBy | undefined {
  const value = parseOptionalScalar(raw, 'group_by');
  if (value === undefined) return undefined;
  if (!AGGREGATE_GROUPS.includes(value as AggregateGroupBy)) {
    throw new ValidationError(`invalid group_by: '${value}'`);
  }
  return value as AggregateGroupBy;
}
