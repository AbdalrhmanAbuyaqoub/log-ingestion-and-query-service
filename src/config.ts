export type Config = {
  PORT: number;
  DATABASE_URL: string;
  RETENTION_DAYS: number;
};

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

  const rawRetention = env.RETENTION_DAYS;
  const RETENTION_DAYS =
    rawRetention === undefined || rawRetention === ''
      ? 30
      : parseInt32(rawRetention, 'RETENTION_DAYS');
  if (RETENTION_DAYS < 1) {
    throw new Error(`config: RETENTION_DAYS must be a positive integer, got ${RETENTION_DAYS}`);
  }

  return { PORT, DATABASE_URL, RETENTION_DAYS };
}
