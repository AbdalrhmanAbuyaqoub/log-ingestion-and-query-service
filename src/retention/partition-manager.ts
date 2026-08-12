import type pg from 'pg';
import { getClient } from '../db/index.js';

const DAY_MS = 86_400_000;
const PARTITION_RE = /^logs_p(\d{4})_(\d{2})_(\d{2})$/;
const LEGACY_PARTITION_RE = /^logs_(\d{4})(\d{2})(\d{2})$/;
const ROTATED_RE = /^logs_default_detached_(\d+)$/;
const ADVISORY_LOCK_KEY = 1_813_047_329;

type Queryable = Pick<pg.PoolClient, 'query'>;

export type MaintenanceResult = {
  skipped: boolean;
  created: number;
  dropped: number;
  reconciled: number;
};

export function utcDayStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

export function partitionName(day: Date): string {
  const start = utcDayStart(day);
  const year = String(start.getUTCFullYear()).padStart(4, '0');
  const month = String(start.getUTCMonth() + 1).padStart(2, '0');
  const date = String(start.getUTCDate()).padStart(2, '0');
  return `logs_p${year}_${month}_${date}`;
}

export function isDayRetained(day: Date, now: Date, retentionDays: number): boolean {
  const upperBound = utcDayStart(day).getTime() + DAY_MS;
  return upperBound > now.getTime() - retentionDays * DAY_MS;
}

function quoteIdentifier(identifier: string): string {
  if (
    !PARTITION_RE.test(identifier) &&
    !LEGACY_PARTITION_RE.test(identifier) &&
    !ROTATED_RE.test(identifier)
  ) {
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
  if (await partitionExists(client, day)) return false;

  await client.query(
    `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(name)} PARTITION OF logs
       FOR VALUES FROM ('${bound(start)}') TO ('${bound(end)}')`,
  );
  return true;
}

async function partitionExists(client: Queryable, day: Date): Promise<boolean> {
  const canonicalName = partitionName(day);
  const legacyName = canonicalName.replace(/^logs_p(\d{4})_(\d{2})_(\d{2})$/, 'logs_$1$2$3');
  const existing = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_inherits i
       JOIN pg_class child ON child.oid = i.inhrelid
       WHERE i.inhparent = 'logs'::regclass AND child.relname = ANY($1::text[])
     ) AS exists`,
    [[canonicalName, legacyName]],
  );
  return existing.rows[0]?.exists === true;
}

export async function ensurePartitionsForTimestamps(
  timestamps: readonly Date[],
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const days = new Map<string, Date>();
  for (const timestamp of timestamps) {
    const day = utcDayStart(timestamp);
    if (isDayRetained(day, now, retentionDays)) days.set(partitionName(day), day);
  }
  if (days.size === 0) return 0;

  const client = await getClient();
  let created = 0;
  let locked = false;
  try {
    const missing: Date[] = [];
    for (const day of days.values()) {
      if (!(await partitionExists(client, day))) missing.push(day);
    }
    if (missing.length === 0) return 0;

    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    locked = true;
    for (const day of missing) {
      if (await createPartition(client, day)) created++;
    }
    return created;
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}

async function listDatedPartitions(client: Queryable): Promise<string[]> {
  const result = await client.query<{ name: string }>(`
    SELECT child.relname AS name
    FROM pg_inherits i
    JOIN pg_class child ON child.oid = i.inhrelid
    WHERE i.inhparent = 'logs'::regclass
      AND (
        child.relname ~ '^logs_p[0-9]{4}_[0-9]{2}_[0-9]{2}$'
        OR child.relname ~ '^logs_[0-9]{8}$'
      )
  `);
  return result.rows.map((row) => row.name);
}

function dayFromPartitionName(name: string): Date | undefined {
  const match = PARTITION_RE.exec(name) ?? LEGACY_PARTITION_RE.exec(name);
  if (!match) return undefined;
  const day = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  return Number.isNaN(day.getTime()) || partitionName(day) !== name ? undefined : day;
}

async function listDetachedDefaults(client: Queryable): Promise<string[]> {
  const result = await client.query<{ name: string }>(`
    SELECT relname AS name
    FROM pg_class
    WHERE relkind IN ('r', 'p') AND relname ~ '^logs_default_detached_[0-9]+$'
  `);
  return result.rows.map((row) => row.name);
}

async function rotateDefaultIfNeeded(client: Queryable): Promise<string | undefined> {
  const count = await client.query<{ has_rows: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM logs_default LIMIT 1) AS has_rows',
  );
  if (!count.rows[0]?.has_rows) return undefined;

  const rotated = `logs_default_detached_${Date.now()}`;
  await client.query('BEGIN');
  try {
    await client.query('LOCK TABLE logs IN ACCESS EXCLUSIVE MODE');
    await client.query('ALTER TABLE logs DETACH PARTITION logs_default');
    await client.query(`ALTER TABLE logs_default RENAME TO ${quoteIdentifier(rotated)}`);
    await client.query('CREATE TABLE logs_default PARTITION OF logs DEFAULT');
    await client.query('COMMIT');
    return rotated;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function reconcileDetached(
  client: Queryable,
  table: string,
  retentionDays: number,
  now: Date,
): Promise<void> {
  const identifier = quoteIdentifier(table);
  const days = await client.query<{ day: Date }>(
    `SELECT DISTINCT date_trunc('day', "timestamp" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day
     FROM ${identifier}`,
  );
  for (const row of days.rows) {
    const day = new Date(row.day);
    if (isDayRetained(day, now, retentionDays)) await createPartition(client, day);
  }

  const cutoff = utcDayStart(new Date(now.getTime() - retentionDays * DAY_MS));
  await client.query(
    `INSERT INTO logs (id, "timestamp", level, service, message, attributes)
     SELECT id, "timestamp", level, service, message, attributes
     FROM ${identifier}
     WHERE "timestamp" >= $1`,
    [cutoff],
  );
  await client.query(`DROP TABLE ${identifier}`);
}

export async function runPartitionMaintenance(
  retentionDays: number,
  now: Date = new Date(),
  futureDays = 2,
  waitForLock = false,
): Promise<MaintenanceResult> {
  const client = await getClient();
  const result: MaintenanceResult = { skipped: false, created: 0, dropped: 0, reconciled: 0 };
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

    const recovered = await listDetachedDefaults(client);
    const rotated = await rotateDefaultIfNeeded(client);
    if (rotated) recovered.push(rotated);

    for (const table of recovered) {
      await reconcileDetached(client, table, retentionDays, now);
      result.reconciled++;
    }

    const today = utcDayStart(now);
    for (let offset = 0; offset <= futureDays; offset++) {
      const day = new Date(today.getTime() + offset * DAY_MS);
      if (await createPartition(client, day)) result.created++;
    }

    for (const name of await listDatedPartitions(client)) {
      const day = dayFromPartitionName(name);
      if (day && !isDayRetained(day, now, retentionDays)) {
        await client.query(`DROP TABLE ${quoteIdentifier(name)}`);
        result.dropped++;
      }
    }
    return result;
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}
