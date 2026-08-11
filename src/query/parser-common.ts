import type { ParsedQs } from 'qs';
import { ValidationError } from '../ingestion/errors.js';
import { LOG_LEVELS, type LogLevel } from '../ingestion/types.js';
import { parseIsoTimestamp } from '../timestamp.js';
import type { AttrFilter } from './types.js';

export type RawQuery = Record<string, string | string[] | undefined>;
export type TimeField = 'since' | 'until';

export function normalizeQuery(raw: ParsedQs): RawQuery {
  const flat: RawQuery = {};

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

export function parseOptionalScalar(
  raw: string | string[] | undefined,
  field: string,
): string | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) throw new ValidationError(`${field} must not be repeated`);
  return raw;
}

export function parseRequiredScalar(raw: string | string[] | undefined, field: string): string {
  const value = parseOptionalScalar(raw, field);
  if (value === undefined) throw new ValidationError(`${field} is required`);
  return value;
}

export function parseOptionalLevel(raw: string | string[] | undefined): LogLevel | undefined {
  const value = parseOptionalScalar(raw, 'level');
  if (value === undefined) return undefined;
  if (!LOG_LEVELS.includes(value as LogLevel)) {
    throw new ValidationError(`invalid level: '${value}'`);
  }
  return value as LogLevel;
}

export function parseOptionalTimestamp(
  raw: string | string[] | undefined,
  field: TimeField,
): Date | undefined {
  const value = parseOptionalScalar(raw, field);
  if (value === undefined) return undefined;
  return parseTimestampValue(value, field);
}

export function parseRequiredTimestamp(raw: string | string[] | undefined, field: TimeField): Date {
  return parseTimestampValue(parseRequiredScalar(raw, field), field);
}

export function validateTimeRange(since: Date | undefined, until: Date | undefined): void {
  if (since && until && until < since) {
    throw new ValidationError('until must not be earlier than since');
  }
}

export function parseOptionalMessageQuery(raw: string | string[] | undefined): string | undefined {
  const value = parseOptionalScalar(raw, 'q');
  return value === undefined ? undefined : escapeLikePattern(value);
}

export function parseAttrs(raw: RawQuery): AttrFilter[] {
  const byKey = new Map<string, string[]>();

  for (const [name, rawValue] of Object.entries(raw)) {
    if (!name.startsWith('attr.') || rawValue === undefined) continue;

    const key = name.slice(5);
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const existing = byKey.get(key);
    if (existing) existing.push(...values);
    else byKey.set(key, [...values]);
  }

  return [...byKey.entries()].map(([key, values]) => ({ key, values }));
}

function parseTimestampValue(value: string, field: TimeField): Date {
  const parsed = parseIsoTimestamp(value);
  if (!parsed) throw new ValidationError(`invalid ${field}`);
  return parsed;
}

function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
