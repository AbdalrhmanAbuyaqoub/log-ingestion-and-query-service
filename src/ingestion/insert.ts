import { query } from '../db/index.js';
import type { ValidLogEntry } from './types.js';
import { ensurePartitionsForTimestamps } from '../retention/partition-manager.js';
import { loadRetentionDays } from '../config.js';

/**
 * Inserts a batch of validated log entries in a single statement via
 * `unnest(...)`. One round-trip per request — no buffering, no flusher.
 * Invalid entries should already have been filtered out by the validator;
 * this function receives only accepted entries.
 */
export async function insertLogs(entries: ValidLogEntry[]): Promise<number> {
  if (entries.length === 0) return 0;

  await ensurePartitionsForTimestamps(
    entries.map((entry) => entry.timestamp),
    loadRetentionDays(),
  );

  const timestamps = entries.map((e) => e.timestamp);
  const levels = entries.map((e) => e.level);
  const services = entries.map((e) => e.service);
  const messages = entries.map((e) => e.message);
  const attrs = entries.map((e) => JSON.stringify(e.attributes));

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
    ), rolled_up AS (
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
    )
    SELECT COUNT(*)::text AS accepted FROM inserted
  `;

  const result = await query<{ accepted: string }>(text, [
    timestamps,
    levels,
    services,
    messages,
    attrs,
  ]);
  const accepted = Number(result.rows[0]?.accepted);
  if (!Number.isSafeInteger(accepted) || accepted < 0) {
    throw new Error('database returned an invalid accepted count');
  }
  return accepted;
}
