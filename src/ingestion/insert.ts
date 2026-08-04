import type { Queryable, ValidLogEntry } from './types.js';

/**
 * Inserts a batch of validated log entries in a single statement via
 * `unnest(...)`. One round-trip per request — no buffering, no flusher.
 * Invalid entries should already have been filtered out by the validator;
 * this function receives only accepted entries.
 */
export async function insertLogs(db: Queryable, entries: ValidLogEntry[]): Promise<number> {
  if (entries.length === 0) return 0;

  const timestamps = entries.map((e) => e.timestamp);
  const levels = entries.map((e) => e.level);
  const services = entries.map((e) => e.service);
  const messages = entries.map((e) => e.message);
  const attrs = entries.map((e) => JSON.stringify(e.attributes));

  const text = `
    INSERT INTO logs ("timestamp", level, service, message, attributes)
    SELECT t, l, s, m, a
    FROM unnest(
      $1::timestamptz[],
      $2::text[],
      $3::text[],
      $4::text[],
      $5::jsonb[]
    ) AS u(t, l, s, m, a)
  `;

  const result = await db.query(text, [timestamps, levels, services, messages, attrs]);
  return result.rowCount ?? entries.length;
}
