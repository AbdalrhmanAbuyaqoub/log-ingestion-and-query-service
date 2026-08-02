import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('applies defaults when only DATABASE_URL is provided', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://localhost/logs' });
    expect(config.PORT).toBe(8080);
    expect(config.LOG_LEVEL).toBe('warn');
    expect(config.RETENTION_DAYS).toBe(30);
    expect(config.INGEST_FLUSH_INTERVAL_MS).toBe(150);
    expect(config.INGEST_FLUSH_BATCH_SIZE).toBe(500);
    expect(config.INGEST_BUFFER_MAX).toBe(50_000);
  });

  it('coerces numeric strings from the environment', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://x',
      PORT: '9090',
      RETENTION_DAYS: '7',
      INGEST_BUFFER_MAX: '1000',
    });
    expect(config.PORT).toBe(9090);
    expect(config.RETENTION_DAYS).toBe(7);
    expect(config.INGEST_BUFFER_MAX).toBe(1000);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow();
  });

  it('rejects invalid log levels', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', LOG_LEVEL: 'verbose' })).toThrow();
  });

  it('rejects non-numeric ports', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', PORT: 'abc' })).toThrow();
  });
});
