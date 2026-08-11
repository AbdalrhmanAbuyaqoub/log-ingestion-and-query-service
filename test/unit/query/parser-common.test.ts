import { describe, expect, it } from 'vitest';
import type { ParsedQs } from 'qs';
import {
  normalizeQuery,
  parseAttrs,
  parseOptionalMessageQuery,
  parseOptionalScalar,
  parseRequiredScalar,
  parseRequiredTimestamp,
  validateTimeRange,
} from '../../../src/query/parser-common.js';

describe('common query parsing', () => {
  it('normalizes flat string values and repeated string values', () => {
    expect(normalizeQuery({ service: 'checkout', level: ['info', 'error'] } as ParsedQs)).toEqual({
      service: 'checkout',
      level: ['info', 'error'],
    });
  });

  it('rejects nested query values', () => {
    expect(() => normalizeQuery({ service: { nested: 'checkout' } } as ParsedQs)).toThrow(
      'invalid query parameter: service',
    );
  });

  it('distinguishes omitted and empty scalar values', () => {
    expect(parseOptionalScalar(undefined, 'service')).toBeUndefined();
    expect(parseOptionalScalar('', 'service')).toBe('');
  });

  it('enforces required and non-repeated scalar values', () => {
    expect(() => parseRequiredScalar(undefined, 'bucket')).toThrow('bucket is required');
    expect(() => parseOptionalScalar(['one', 'two'], 'service')).toThrow(
      'service must not be repeated',
    );
  });

  it('parses required timestamps and validates half-open ranges', () => {
    const since = parseRequiredTimestamp('2026-08-10T10:00:00Z', 'since');
    const equalUntil = parseRequiredTimestamp('2026-08-10T10:00:00Z', 'until');
    const earlierUntil = parseRequiredTimestamp('2026-08-10T09:59:59Z', 'until');

    expect(() => validateTimeRange(since, equalUntil)).not.toThrow();
    expect(() => validateTimeRange(since, earlierUntil)).toThrow(
      'until must not be earlier than since',
    );
  });

  it('escapes LIKE metacharacters without discarding an empty query', () => {
    expect(parseOptionalMessageQuery('100%_done\\now')).toBe('100\\%\\_done\\\\now');
    expect(parseOptionalMessageQuery('')).toBe('');
    expect(parseOptionalMessageQuery(undefined)).toBeUndefined();
  });

  it('groups repeated attribute values while keeping distinct keys separate', () => {
    expect(parseAttrs({ 'attr.region': ['eu', 'us'], 'attr.enabled': 'true' })).toEqual([
      { key: 'region', values: ['eu', 'us'] },
      { key: 'enabled', values: ['true'] },
    ]);
  });
});
