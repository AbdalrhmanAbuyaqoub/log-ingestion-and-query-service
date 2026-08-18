import type pg from 'pg';
import { getClient } from '../db/index.js';

const DAY_MS = 86_400_000;
const PARTITION_RE = /^logs_p(\d{4})_(\d{2})_(\d{2})$/;
const ADVISORY_LOCK_KEY = 1_813_047_329;
const knownPartitions = new Set<string>();
const partitionChecks = new Map<string, Promise<number>>();

type Queryable = Pick<pg.PoolClient, 'query'>;

export type DropResult = {
  skipped: boolean;
  dropped: number;
};

export function utcDayStart(value: Date): Date {
  return new Date(utcDayStartMs(value));
}

export function partitionName(day: Date): string {
  const start = utcDayStart(day);
  const year = String(start.getUTCFullYear()).padStart(4, '0');
  const month = String(start.getUTCMonth() + 1).padStart(2, '0');
  const date = String(start.getUTCDate()).padStart(2, '0');
  return `logs_p${year}_${month}_${date}`;
}

export function isDayRetained(day: Date, now: Date, retentionDays: number): boolean {
  const upperBound = utcDayStartMs(day) + DAY_MS;
  return upperBound > now.getTime() - retentionDays * DAY_MS;
}

function utcDayStartMs(value: Date): number {
  return Math.floor(value.getTime() / DAY_MS) * DAY_MS;
}

function quoteIdentifier(identifier: string): string {
  if (!PARTITION_RE.test(identifier)) {
    throw new Error(`unsafe partition identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function bound(day: Date): string {
  return utcDayStart(day).toISOString();
}

async function createPartition(client: Queryable, day: Date): Promise<boolean> {
  const start = utcDayStart(day);
  const end = new Date(start.getTime() + DAY_MS);
  const name = partitionName(start);
  if (await partitionExists(client, day)) {
    knownPartitions.add(name);
    return false;
  }

  await client.query(
    `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(name)} PARTITION OF logs
       FOR VALUES FROM ('${bound(start)}') TO ('${bound(end)}')`,
  );
  knownPartitions.add(name);
  return true;
}

async function partitionExists(client: Queryable, day: Date): Promise<boolean> {
  const canonicalName = partitionName(day);
  if (knownPartitions.has(canonicalName)) return true;
  const existing = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_inherits i
       JOIN pg_class child ON child.oid = i.inhrelid
       WHERE i.inhparent = 'logs'::regclass AND child.relname = ANY($1::text[])
     ) AS exists`,
    [[canonicalName]],
  );
  return existing.rows[0]?.exists === true;
}

export async function ensurePartitionsForTimestamps(
  timestamps: readonly Date[],
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  const days = new Map<number, Date>();
  for (const timestamp of timestamps) {
    const dayStart = utcDayStartMs(timestamp);
    if (dayStart + DAY_MS > cutoff && !days.has(dayStart)) {
      days.set(dayStart, new Date(dayStart));
    }
  }
  if (days.size === 0) return 0;

  const results = await Promise.all([...days.values()].map(ensurePartition));
  return results.reduce((sum, created) => sum + created, 0);
}

function ensurePartition(day: Date): Promise<number> {
  const name = partitionName(day);
  if (knownPartitions.has(name)) return Promise.resolve(0);
  const pending = partitionChecks.get(name);
  if (pending) return pending;

  const check = ensurePartitionUncached(day).finally(() => partitionChecks.delete(name));
  partitionChecks.set(name, check);
  return check;
}

async function ensurePartitionUncached(day: Date): Promise<number> {
  const client = await getClient();
  let locked = false;
  try {
    if (await partitionExists(client, day)) {
      knownPartitions.add(partitionName(day));
      return 0;
    }
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    locked = true;
    return (await createPartition(client, day)) ? 1 : 0;
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}

async function listDatedRawPartitions(client: Queryable): Promise<string[]> {
  const result = await client.query<{ name: string }>(`
    SELECT child.relname AS name
    FROM pg_inherits i
    JOIN pg_class child ON child.oid = i.inhrelid
    WHERE i.inhparent = 'logs'::regclass
      AND child.relname ~ '^logs_p[0-9]{4}_[0-9]{2}_[0-9]{2}$'
  `);
  return result.rows.map((row) => row.name);
}

function dayFromPartitionName(name: string): Date | undefined {
  const match = PARTITION_RE.exec(name);
  if (!match) return undefined;
  const day = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime())) return undefined;
  return name === partitionName(day) ? day : undefined;
}

export async function dropExpiredPartitions(
  retentionDays: number,
  now: Date = new Date(),
  waitForLock = false,
): Promise<DropResult> {
  const client = await getClient();
  const result: DropResult = { skipped: false, dropped: 0 };
  let locked = false;
  try {
    if (waitForLock) {
      await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
      locked = true;
    } else {
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [ADVISORY_LOCK_KEY],
      );
      locked = lock.rows[0]?.locked === true;
      if (!locked) return { ...result, skipped: true };
    }

    const rawByDay = partitionsByDay(await listDatedRawPartitions(client));
    for (const dayTimestamp of rawByDay.keys()) {
      const day = new Date(dayTimestamp);
      if (isDayRetained(day, now, retentionDays)) continue;

      await client.query('BEGIN');
      try {
        const raw = rawByDay.get(dayTimestamp);
        if (raw) await client.query(`DROP TABLE ${quoteIdentifier(raw)}`);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      knownPartitions.delete(partitionName(day));
      result.dropped++;
    }

    const cutoff = utcDayStart(new Date(now.getTime() - retentionDays * DAY_MS));
    await client.query('DELETE FROM log_rollups_1m WHERE bucket_start < $1', [cutoff]);

    return result;
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}

function partitionsByDay(names: readonly string[]): Map<number, string> {
  const partitions = new Map<number, string>();
  for (const name of names) {
    const day = dayFromPartitionName(name);
    if (day) partitions.set(day.getTime(), name);
  }
  return partitions;
}
