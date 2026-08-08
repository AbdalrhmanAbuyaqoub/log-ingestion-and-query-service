import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../../src/ingestion/errors.js';
import { decodeCursor, encodeCursor } from '../../../src/query/cursor.js';

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('query cursor', () => {
  it('round-trips a timestamp and bigint id without precision loss', () => {
    const timestamp = new Date('2026-07-20T14:32:01.123Z');
    const id = '9007199254740993';

    expect(decodeCursor(encodeCursor(timestamp, id))).toEqual({
      t: timestamp.toISOString(),
      id,
    });
  });

  it('produces an unpadded URL-safe base64 value', () => {
    const cursor = encodeCursor(new Date('2026-07-20T14:32:01.123Z'), '42');

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain('=');
  });

  // independently verifies the actual encoded format. Without it,
  // matching bugs in both functions could potentially make the round-trip test pass.
  it('preserves the cursor payload as JSON with string fields', () => {
    const timestamp = new Date('2026-07-20T14:32:01.123Z');
    const cursor = encodeCursor(timestamp, '42');
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

    expect(payload).toEqual({ t: timestamp.toISOString(), id: '42' });
  });

  it('rejects empty, non-JSON, and incorrectly shaped cursors', () => {
    const malformed = [
      '',
      Buffer.from('not json', 'utf8').toString('base64url'),
      encoded(null),
      encoded([]),
      encoded({}),
      encoded({ t: '2026-07-20T14:32:01.123Z' }),
      encoded({ id: '42' }),
      encoded({ t: 123, id: '42' }),
      encoded({ t: '2026-07-20T14:32:01.123Z', id: 42 }),
    ];

    for (const cursor of malformed) {
      expect(() => decodeCursor(cursor)).toThrow(ValidationError);
      expect(() => decodeCursor(cursor)).toThrow('malformed cursor');
    }
  });

  it('rejects invalid timestamps and non-decimal ids', () => {
    const malformed = [
      encoded({ t: 'not-a-date', id: '42' }),
      encoded({ t: '2026-07-20', id: '42' }),
      encoded({ t: '2026-02-30T12:00:00Z', id: '42' }),
      encoded({ t: '2026-13-01T12:00:00Z', id: '42' }),
      encoded({ t: '2026-07-20T25:00:00Z', id: '42' }),
      encoded({ t: '2026-07-20T14:32:01.123Z', id: '' }),
      encoded({ t: '2026-07-20T14:32:01.123Z', id: '-1' }),
      encoded({ t: '2026-07-20T14:32:01.123Z', id: '1.5' }),
      encoded({ t: '2026-07-20T14:32:01.123Z', id: 'abc' }),
    ];

    for (const cursor of malformed) {
      expect(() => decodeCursor(cursor)).toThrow('malformed cursor');
    }
  });
});
