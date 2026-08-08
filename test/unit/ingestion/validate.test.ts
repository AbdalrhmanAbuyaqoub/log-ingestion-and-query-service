import { describe, expect, it } from 'vitest';
import { validateBatch, validateEntry } from '../../../src/ingestion/validate.js';
import { ValidationError } from '../../../src/ingestion/errors.js';

const NOW = Date.parse('2026-08-03T10:00:00Z');

function validEntry() {
  return {
    timestamp: '2026-08-03T09:59:00Z',
    level: 'error',
    service: 'checkout',
    message: 'payment declined',
    attributes: { user_id: '42', region: 'eu-west', retries: 3 },
  };
}

describe('validateEntry', () => {
  it('accepts a fully valid entry', () => {
    const out = validateEntry(validEntry(), NOW);
    expect(out).not.toEqual(expect.any(String));
    expect(typeof out).toBe('object');
  });

  it('defaults missing attributes to {}', () => {
    const { attributes: _a, ...rest } = validEntry();
    void _a;
    const out = validateEntry(rest, NOW) as { attributes: object };
    expect(out.attributes).toEqual({});
  });

  it('preserves string / number / boolean attribute values', () => {
    const out = validateEntry(validEntry(), NOW) as { attributes: Record<string, unknown> };
    expect(out.attributes).toEqual({ user_id: '42', region: 'eu-west', retries: 3 });
  });

  it('rejects explicit attributes: null', () => {
    const out = validateEntry({ ...validEntry(), attributes: null }, NOW);
    expect(out).toMatch(/invalid attributes/);
  });

  it('rejects non-object attributes', () => {
    expect(validateEntry({ ...validEntry(), attributes: 'foo' }, NOW)).toMatch(/attributes/);
    expect(validateEntry({ ...validEntry(), attributes: 42 }, NOW)).toMatch(/attributes/);
  });

  it('rejects nested object attribute values', () => {
    const out = validateEntry({ ...validEntry(), attributes: { nested: { a: 1 } } }, NOW);
    expect(out).toMatch(/flat object/);
  });

  it('rejects array attribute values', () => {
    const out = validateEntry({ ...validEntry(), attributes: { arr: [1, 2] } }, NOW);
    expect(out).toMatch(/flat object/);
  });

  it('rejects array used as attributes', () => {
    expect(validateEntry({ ...validEntry(), attributes: [] }, NOW)).toMatch(/attributes/);
  });

  it('rejects missing timestamp', () => {
    const { timestamp: _ts, ...rest } = validEntry();
    void _ts;
    expect(validateEntry(rest, NOW)).toMatch(/timestamp/);
  });

  it('rejects non-string timestamp', () => {
    expect(validateEntry({ ...validEntry(), timestamp: 123 }, NOW)).toMatch(/timestamp/);
  });

  it('rejects unparseable timestamp', () => {
    expect(validateEntry({ ...validEntry(), timestamp: 'not-a-date' }, NOW)).toMatch(/timestamp/);
  });

  it('rejects non-contract timestamp formats and impossible calendar dates', () => {
    for (const timestamp of [
      '2026-08-03',
      'Mon, 03 Aug 2026 09:59:00 GMT',
      '2026-02-30T09:59:00Z',
      '2026-13-01T09:59:00Z',
      '2026-08-03T25:00:00Z',
    ]) {
      expect(validateEntry({ ...validEntry(), timestamp }, NOW)).toMatch(/timestamp/);
    }
  });

  it('accepts a valid leap-day timestamp', () => {
    const leapDay = '2024-02-29T09:59:00Z';
    const result = validateEntry({ ...validEntry(), timestamp: leapDay }, NOW);

    expect(result).not.toEqual(expect.any(String));
    expect((result as { timestamp: Date }).timestamp).toEqual(new Date(leapDay));
  });

  it('rejects timestamps more than 5 minutes in the future', () => {
    const future = new Date(NOW + 6 * 60_000).toISOString();
    expect(validateEntry({ ...validEntry(), timestamp: future }, NOW)).toMatch(/future/);
  });

  it('accepts timestamps exactly 5 minutes in the future', () => {
    const future = new Date(NOW + 5 * 60_000).toISOString();
    expect(typeof validateEntry({ ...validEntry(), timestamp: future }, NOW)).toBe('object');
  });

  it('accepts arbitrary past timestamps (no lower bound)', () => {
    const past = new Date(NOW - 365 * 24 * 60 * 60_000).toISOString();
    expect(typeof validateEntry({ ...validEntry(), timestamp: past }, NOW)).toBe('object');
  });

  it('rejects invalid level', () => {
    expect(validateEntry({ ...validEntry(), level: 'critical' }, NOW)).toMatch(/invalid level/);
  });

  it('rejects missing level', () => {
    const { level: _level, ...rest } = validEntry();
    void _level;
    expect(validateEntry(rest, NOW)).toMatch(/invalid level/);
  });

  it('rejects empty service', () => {
    expect(validateEntry({ ...validEntry(), service: '' }, NOW)).toMatch(/service/);
  });

  it('rejects whitespace-only service', () => {
    expect(validateEntry({ ...validEntry(), service: '   ' }, NOW)).toMatch(/service/);
  });

  it('rejects non-string service', () => {
    expect(validateEntry({ ...validEntry(), service: 42 }, NOW)).toMatch(/service/);
  });

  it('rejects empty message', () => {
    expect(validateEntry({ ...validEntry(), message: '' }, NOW)).toMatch(/message/);
  });

  it('rejects whitespace-only message', () => {
    expect(validateEntry({ ...validEntry(), message: '  ' }, NOW)).toMatch(/message/);
  });

  it('rejects non-object entry', () => {
    expect(validateEntry('foo', NOW)).toMatch(/object/);
    expect(validateEntry(42, NOW)).toMatch(/object/);
    expect(validateEntry(null, NOW)).toMatch(/object/);
    expect(validateEntry([], NOW)).toMatch(/object/);
  });
});

describe('validateBatch', () => {
  it('throws ValidationError when body is not an object', () => {
    expect(() => validateBatch('foo', NOW)).toThrow(ValidationError);
    expect(() => validateBatch(null, NOW)).toThrow(ValidationError);
  });

  it('throws ValidationError when logs is missing / not array / null', () => {
    expect(() => validateBatch({}, NOW)).toThrow(ValidationError);
    expect(() => validateBatch({ logs: 'foo' }, NOW)).toThrow(ValidationError);
    expect(() => validateBatch({ logs: null }, NOW)).toThrow(ValidationError);
  });

  it('throws ValidationError on empty batch', () => {
    expect(() => validateBatch({ logs: [] }, NOW)).toThrow(ValidationError);
    expect(() => validateBatch({ logs: [] }, NOW)).toThrow(/empty batch/);
  });

  it('returns valid + empty rejected for a fully valid batch', () => {
    const { valid, rejected } = validateBatch({ logs: [validEntry(), validEntry()] }, NOW);
    expect(valid).toHaveLength(2);
    expect(rejected).toEqual([]);
  });

  it('collects all rejections with their array index', () => {
    const bad = { ...validEntry(), level: 'critical' };
    const { valid, rejected } = validateBatch(
      { logs: [validEntry(), bad, validEntry(), { ...validEntry(), service: '' }] },
      NOW,
    );
    expect(valid).toHaveLength(2);
    expect(rejected).toEqual([
      { index: 1, reason: expect.stringMatching(/invalid level/) },
      { index: 3, reason: expect.stringMatching(/service/) },
    ]);
  });

  it('returns empty valid when all entries rejected', () => {
    const { valid, rejected } = validateBatch(
      {
        logs: [
          { ...validEntry(), level: 'x' },
          { ...validEntry(), message: '' },
        ],
      },
      NOW,
    );
    expect(valid).toHaveLength(0);
    expect(rejected).toHaveLength(2);
  });
});
