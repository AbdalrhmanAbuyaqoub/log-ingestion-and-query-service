import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { encodeCursor } from '../../../src/query/cursor.js';
import { parseLogsQuery } from '../../../src/query/parse.js';
import type { ParsedQs } from 'qs';

function parse(query: Record<string, unknown> = {}) {
  return parseLogsQuery(query as ParsedQs);
}

describe('parseLogsQuery', () => {
  describe('defaults', () => {
    it('returns the default limit and no filters', () => {
      expect(parse()).toEqual({
        service: undefined,
        level: undefined,
        since: undefined,
        until: undefined,
        attrs: [],
        q: undefined,
        limit: 100,
        cursor: undefined,
      });
    });
  });

  describe('limit', () => {
    it('accepts values at and within the supported boundaries', () => {
      for (const [raw, expected] of [
        ['1', 1],
        ['500', 500],
        ['1000', 1000],
      ] as const) {
        expect(parse({ limit: raw }).limit).toBe(expected);
      }
    });

    it('rejects empty, out-of-range, and non-integer values', () => {
      for (const limit of ['', '0', '1001', '1.5', 'abc', '-5']) {
        expect(() => parse({ limit })).toThrow('limit must be an integer between 1 and 1000');
      }
    });

    it('rejects repeated values', () => {
      expect(() => parse({ limit: ['10', '20'] })).toThrow('limit must not be repeated');
    });
  });

  describe('level', () => {
    it('accepts every supported level', () => {
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        expect(parse({ level }).level).toBe(level);
      }
    });

    it('rejects unsupported and empty levels', () => {
      for (const level of ['critical', '', '1234']) {
        expect(() => parse({ level })).toThrow(`invalid level: '${level}'`);
      }
    });

    it('rejects repeated values', () => {
      expect(() => parse({ level: ['info', 'error'] })).toThrow('level must not be repeated');
    });
  });

  describe('time range', () => {
    it('parses valid ISO timestamps with offsets and milliseconds', () => {
      const result = parse({
        since: '2026-07-20T14:00:00.123Z',
        until: '2026-07-20T16:00:00+01:00',
      });

      expect(result.since).toEqual(new Date('2026-07-20T14:00:00.123Z'));
      expect(result.until).toEqual(new Date('2026-07-20T16:00:00+01:00'));
    });

    it('rejects non-ISO and invalid timestamps', () => {
      for (const [field, value] of [
        ['since', '2026-07-20'],
        ['since', 'Mon, 20 Jul 2026 14:00:00 GMT'],
        ['since', 'not-a-date'],
        ['until', '2026-07-20'],
        ['until', 'not-a-date'],
      ] as const) {
        expect(() => parse({ [field]: value })).toThrow(`invalid ${field}`);
      }
    });

    it('rejects an impossible calendar date instead of normalizing it', () => {
      expect(() => parse({ since: '2026-02-30T12:00:00Z' })).toThrow('invalid since');
    });

    it('accepts a valid leap day', () => {
      expect(parse({ since: '2028-02-29T12:00:00Z' }).since).toEqual(
        new Date('2028-02-29T12:00:00Z'),
      );
    });

    it('rejects a reversed range', () => {
      expect(() =>
        parse({
          since: '2026-07-20T15:00:00Z',
          until: '2026-07-20T14:00:00Z',
        }),
      ).toThrow(/until/);
    });

    it('accepts an equal range as an empty half-open interval', () => {
      const result = parse({
        since: '2026-07-20T14:00:00Z',
        until: '2026-07-20T14:00:00Z',
      });

      expect(result.since).toEqual(result.until);
    });

    it('rejects repeated time boundaries', () => {
      for (const field of ['since', 'until']) {
        expect(() => parse({ [field]: ['2026-07-20T14:00:00Z', '2026-07-20T15:00:00Z'] })).toThrow(
          `${field} must not be repeated`,
        );
      }
    });
  });

  describe('service and message search', () => {
    it('preserves service values, including an explicit empty value', () => {
      expect(parse({ service: 'checkout' }).service).toBe('checkout');
      expect(parse({ service: '' }).service).toBe('');
    });

    it('escapes LIKE metacharacters and preserves ordinary or empty searches', () => {
      for (const [raw, expected] of [
        ['declined', 'declined'],
        ['%', '\\%'],
        ['_', '\\_'],
        ['\\', '\\\\'],
        ['', ''],
        ['100%_done\\now', '100\\%\\_done\\\\now'],
      ]) {
        expect(parse({ q: raw }).q).toBe(expected);
      }
    });

    it('rejects repeated q values', () => {
      expect(() => parse({ q: ['one', 'two'] })).toThrow('q must not be repeated');
    });
  });

  describe('attribute filters', () => {
    it('parses one attribute', () => {
      expect(parse({ 'attr.region': 'eu' }).attrs).toEqual([{ key: 'region', values: ['eu'] }]);
    });

    it('groups repeated values for the same key as OR values', () => {
      expect(parse({ 'attr.region': ['eu', 'us'] }).attrs).toEqual([
        { key: 'region', values: ['eu', 'us'] },
      ]);
    });

    it('keeps distinct keys as separate AND filters', () => {
      expect(parse({ 'attr.region': 'eu', 'attr.user_id': '42' }).attrs).toEqual([
        { key: 'region', values: ['eu'] },
        { key: 'user_id', values: ['42'] },
      ]);
    });

    it('preserves an empty attribute value', () => {
      expect(parse({ 'attr.region': '' }).attrs).toEqual([{ key: 'region', values: [''] }]);
    });
  });

  describe('cursor', () => {
    it('leaves the cursor absent on the first page', () => {
      expect(parse().cursor).toBeUndefined();
    });

    it('decodes a valid cursor without coercing the bigint id', () => {
      const timestamp = new Date('2026-07-20T14:00:00.123Z');
      const cursor = encodeCursor(timestamp, '9007199254740993');

      expect(parse({ cursor }).cursor).toEqual({
        t: timestamp,
        id: '9007199254740993',
      });
    });

    it('rejects malformed encoding, JSON, payloads, timestamps, and ids', () => {
      const malformed = [
        'not-a-cursor',
        Buffer.from('not json').toString('base64url'),
        Buffer.from(JSON.stringify({})).toString('base64url'),
        Buffer.from(JSON.stringify({ t: 'not-a-date', id: '1' })).toString('base64url'),
        Buffer.from(JSON.stringify({ t: '2026-07-20T14:00:00Z', id: 'abc' })).toString('base64url'),
      ];

      for (const cursor of malformed) {
        expect(() => parse({ cursor })).toThrow('malformed cursor');
      }
    });

    it('rejects repeated cursors', () => {
      expect(() => parse({ cursor: ['one', 'two'] })).toThrow('cursor must not be repeated');
    });
  });

  it('rejects nested query values produced by qs', () => {
    expect(() => parse({ service: { nested: 'checkout' } })).toThrow(
      'invalid query parameter: service',
    );
  });
});
