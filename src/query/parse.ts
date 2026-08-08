import type { AttrFilter, LogQuery } from './types.js';
import { ValidationError } from '../ingestion/errors.js';
import { LOG_LEVELS, type LogLevel } from '../ingestion/types.js';
import { decodeCursor } from './cursor.js';
import { parseIsoTimestamp } from '../timestamp.js';
import type { ParsedQs } from 'qs';

export type RawLogQuery = Record<string, string | string[] | undefined>;

export function parseLogsQuery(raw: ParsedQs): LogQuery {
  const query = normalizeQuery(raw);
  const since = parseTimestamp(query.since, 'since');
  const until = parseTimestamp(query.until, 'until');
  if (since && until && until < since) {
    throw new ValidationError('until must not be earlier than since');
  }
  return {
    service: query.service as string | undefined,
    level: parseLevel(query.level),
    since,
    until,
    attrs: parseAttrs(query),
    q: parseQ(query.q),
    limit: parseLimit(query.limit),
    cursor: parseCursor(query.cursor),
  };
}

function normalizeQuery(raw: ParsedQs): RawLogQuery {
  const flat: RawLogQuery = {};

  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;

    if (typeof value === 'string') {
      flat[key] = value;
      continue;
    }

    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      flat[key] = value;
      continue;
    }

    throw new ValidationError(`invalid query parameter: ${key}`);
  }

  return flat;
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

function parseLevel(rawLevel: string | string[] | undefined): LogLevel | undefined {
  if (rawLevel === undefined) return undefined; // optional → no filter
  if (Array.isArray(rawLevel)) throw new ValidationError('level must not be repeated');
  if (!LOG_LEVELS.includes(rawLevel as LogLevel)) {
    throw new ValidationError(`invalid level: '${rawLevel}'`);
  }
  return rawLevel as LogLevel;
}

function parseTimestamp(
  rawTs: string | string[] | undefined,
  field: 'since' | 'until',
): Date | undefined {
  if (rawTs === undefined) return undefined;
  if (Array.isArray(rawTs)) throw new ValidationError(`${field} must not be repeated`);
  const parsed = parseIsoTimestamp(rawTs);
  if (!parsed) throw new ValidationError(`invalid ${field}`);
  return parsed;
}

function parseQ(rawQ: string | string[] | undefined): string | undefined {
  if (rawQ === undefined) return undefined;
  if (Array.isArray(rawQ)) throw new ValidationError('q must not be repeated');
  return escapeLikePattern(rawQ);
}

function escapeLikePattern(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function parseAttrs(raw: RawLogQuery): AttrFilter[] {
  const byKey = new Map<string, string[]>();

  // * Express/qs already decoded the URL, so attr.region=eu arrives as { 'attr.region': 'eu' }
  //   and attr.region=eu&attr.region=us arrives as { 'attr.region': ['eu', 'us'] }.
  //   One pass over the raw query collects everything.
  // * k.slice(5) strips the attr. prefix (5 chars: a,t,t,r,.).
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith('attr.')) continue;
    const key = k.slice(5);
    if (v === undefined) continue;

    const values = Array.isArray(v) ? v : [v];
    const existing = byKey.get(key);
    if (existing) existing.push(...values);
    else byKey.set(key, values);
  }

  //This line converts the Map byKey into an array of plain objects.
  //he result is an array like [{ key: k1, values: v1 }, { key: k2, values: v2 }, ...]
  return [...byKey.entries()].map(([key, values]) => ({ key, values }));
}

function parseCursor(
  rawCursor: string | string[] | undefined,
): { t: Date; id: string } | undefined {
  if (rawCursor === undefined) return undefined; // first page
  if (Array.isArray(rawCursor)) throw new ValidationError('cursor must not be repeated');
  const payload = decodeCursor(rawCursor);
  return { t: new Date(payload.t), id: payload.id };
}
