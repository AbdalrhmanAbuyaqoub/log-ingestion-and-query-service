export type Config = {
  PORT: number;
  DATABASE_URL: string;
  RETENTION_DAYS: number;
  INGEST_FLUSH_INTERVAL_MS: number;
  INGEST_FLUSH_BATCH_SIZE: number;
  INGEST_BUFFER_MAX: number;
};

export function loadRetentionDays(env: Record<string, string | undefined> = process.env): number {
  const rawRetention = env.RETENTION_DAYS;
  const retentionDays =
    rawRetention === undefined || rawRetention === ''
      ? 30
      : parseInt32(rawRetention, 'RETENTION_DAYS');
  if (retentionDays < 1) {
    throw new Error(`config: RETENTION_DAYS must be a positive integer, got ${retentionDays}`);
  }
  return retentionDays;
}

function parseInt32(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new Error(`config: ${name} must be an integer, got '${raw}'`);
  }
  return n;
}

function parsePort(raw: string, name: string): number {
  const n = parseInt32(raw, name);
  if (n < 1 || n > 65535) {
    throw new Error(`config: ${name} must be between 1 and 65535, got ${n}`);
  }
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const DATABASE_URL = env.DATABASE_URL;
  if (!DATABASE_URL) {
    throw new Error('config: DATABASE_URL is required');
  }

  const PORT = env.PORT === undefined || env.PORT === '' ? 8080 : parsePort(env.PORT, 'PORT');

  const RETENTION_DAYS = loadRetentionDays(env);
  const INGEST_FLUSH_INTERVAL_MS = parsePositiveInt(
    env.INGEST_FLUSH_INTERVAL_MS,
    'INGEST_FLUSH_INTERVAL_MS',
    50,
  );
  const INGEST_FLUSH_BATCH_SIZE = parsePositiveInt(
    env.INGEST_FLUSH_BATCH_SIZE,
    'INGEST_FLUSH_BATCH_SIZE',
    500,
  );
  const INGEST_BUFFER_MAX = parsePositiveInt(env.INGEST_BUFFER_MAX, 'INGEST_BUFFER_MAX', 50_000);

  return {
    PORT,
    DATABASE_URL,
    RETENTION_DAYS,
    INGEST_FLUSH_INTERVAL_MS,
    INGEST_FLUSH_BATCH_SIZE,
    INGEST_BUFFER_MAX,
  };
}

function parsePositiveInt(raw: string | undefined, name: string, defaultValue: number): number {
  if (raw === undefined || raw === '') return defaultValue;
  const value = parseInt32(raw, name);
  if (value < 1) throw new Error(`config: ${name} must be a positive integer, got ${value}`);
  return value;
}
