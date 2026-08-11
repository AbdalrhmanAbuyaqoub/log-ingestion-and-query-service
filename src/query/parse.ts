import type { LogQuery } from './types.js';
import { ValidationError } from '../ingestion/errors.js';
import { decodeCursor } from './cursor.js';
import type { ParsedQs } from 'qs';
import {
  normalizeQuery,
  parseAttrs,
  parseOptionalLevel,
  parseOptionalMessageQuery,
  parseOptionalScalar,
  parseOptionalTimestamp,
  validateTimeRange,
} from './parser-common.js';

export function parseLogsQuery(raw: ParsedQs): LogQuery {
  const query = normalizeQuery(raw);

  const since = parseOptionalTimestamp(query.since, 'since');
  const until = parseOptionalTimestamp(query.until, 'until');
  validateTimeRange(since, until);

  return {
    service: parseOptionalScalar(query.service, 'service'),
    level: parseOptionalLevel(query.level),
    since,
    until,
    attrs: parseAttrs(query),
    q: parseOptionalMessageQuery(query.q),
    limit: parseLimit(query.limit),
    cursor: parseCursor(query.cursor),
  };
}

const LIMIT_RANGE_ERROR = 'limit must be an integer between 1 and 1000';

function parseLimit(rawLimit: string | string[] | undefined): number {
  if (rawLimit === undefined) return 100;
  if (Array.isArray(rawLimit)) throw new ValidationError('limit must not be repeated');
  if (!/^\d+$/.test(rawLimit)) throw new ValidationError(LIMIT_RANGE_ERROR);
  const n = Number.parseInt(rawLimit, 10);
  if (n < 1 || n > 1000) throw new ValidationError(LIMIT_RANGE_ERROR);
  return n;
}

function parseCursor(
  rawCursor: string | string[] | undefined,
): { t: Date; id: string } | undefined {
  if (rawCursor === undefined) return undefined; // first page
  if (Array.isArray(rawCursor)) throw new ValidationError('cursor must not be repeated');
  const payload = decodeCursor(rawCursor);
  return { t: new Date(payload.t), id: payload.id };
}
