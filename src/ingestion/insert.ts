import { ingestQuery } from '../db/index.js';
import type { ValidLogEntry } from './types.js';
import { ensurePartitionsForTimestamps } from '../retention/partition-manager.js';
import { loadRetentionDays } from '../config.js';

/**
 * Inserts a batch of validated log entries in a single statement via
 * `unnest(...)`. Coordinated requests share this single durable round-trip.
 * Invalid entries should already have been filtered out by the validator;
 * this function receives only accepted entries.
 */
export async function insertLogs(entries: ValidLogEntry[]): Promise<number> {
  if (entries.length === 0) return 0;

  const timestamps: Date[] = [];
  const levels: string[] = [];
  const services: string[] = [];
  const messages: string[] = [];
  const attrs: string[] = [];
  for (const entry of entries) {
    timestamps.push(entry.timestamp);
    levels.push(entry.level);
    services.push(entry.service);
    messages.push(entry.message);
    attrs.push(JSON.stringify(entry.attributes));
  }

  await ensurePartitionsForTimestamps(timestamps, loadRetentionDays());

  const text = `
    WITH inserted AS MATERIALIZED (
      INSERT INTO logs ("timestamp", level, service, message, attributes)
      SELECT t, l, s, m, a
      FROM unnest(
        $1::timestamptz[],
        $2::text[],
        $3::text[],
        $4::text[],
        $5::jsonb[]
      ) AS u(t, l, s, m, a)
      RETURNING "timestamp", service, level
    )
    INSERT INTO log_rollups_1m (bucket_start, service, level, count)
    SELECT
      date_bin('1 minute'::interval, "timestamp", '1970-01-01T00:00:00Z'::timestamptz),
      service,
      level,
      COUNT(*)
    FROM inserted
    GROUP BY 1, 2, 3
    ON CONFLICT (bucket_start, service, level)
    DO UPDATE SET count = log_rollups_1m.count + EXCLUDED.count
  `;

  await ingestQuery(text, [timestamps, levels, services, messages, attrs]);
  return entries.length;
}
