import { z } from 'zod';

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('warn'),
  RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  INGEST_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().default(150),
  INGEST_FLUSH_BATCH_SIZE: z.coerce.number().int().positive().default(500),
  INGEST_BUFFER_MAX: z.coerce.number().int().positive().default(50_000),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return configSchema.parse(env);
}
