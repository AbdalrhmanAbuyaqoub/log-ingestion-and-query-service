import { describe, expect, it } from 'vitest';
import { loadConfig, loadRetentionDays } from '../../src/config.js';

describe('loadConfig', () => {
  it('applies defaults when only DATABASE_URL is provided', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://localhost/logs' });
    expect(config.PORT).toBe(8080);
    expect(config.RETENTION_DAYS).toBe(30);
  });

  it('coerces numeric strings from the environment', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://x',
      PORT: '9090',
      RETENTION_DAYS: '7',
    });
    expect(config.PORT).toBe(9090);
    expect(config.RETENTION_DAYS).toBe(7);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow();
  });

  it('rejects non-numeric ports', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', PORT: 'abc' })).toThrow();
  });

  it('rejects out-of-range ports', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', PORT: '0' })).toThrow();
    expect(() => loadConfig({ DATABASE_URL: 'x', PORT: '99999' })).toThrow();
  });

  it('rejects non-positive retention days', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', RETENTION_DAYS: '0' })).toThrow();
  });
});

describe('loadRetentionDays', () => {
  it('does not require unrelated database configuration', () => {
    expect(loadRetentionDays({ RETENTION_DAYS: '14' })).toBe(14);
  });
});
