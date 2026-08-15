import type pg from 'pg';
import { getClient } from '../db/index.js';

const DAY_MS = 86_400_000;
const PARTITION_RE = /^logs_p(\d{4})_(\d{2})_(\d{2})$/;
const ROLLUP_PARTITION_RE = /^log_rollups_1m_p(\d{4})_(\d{2})_(\d{2})$/;
const LEGACY_PARTITION_RE = /^logs_(\d{4})(\d{2})(\d{2})$/;
const RAW_ROTATED_RE = /^logs_default_detached_(\d+)$/;
const ROLLUP_ROTATED_RE = /^log_rollups_1m_default_detached_(\d+)$/;
const ADVISORY_LOCK_KEY = 1_813_047_329;
const knownPartitions = new Set<string>();
const partitionChecks = new Map<string, Promise<number>>();

type Queryable = Pick<pg.PoolClient, 'query'>;

type DetachedDefaults = {
  raw?: string;
  rollup?: string;
};

export type MaintenanceResult = {
  skipped: boolean;
  created: number;
  dropped: number;
  reconciled: number;
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
  if (
    !PARTITION_RE.test(identifier) &&
    !ROLLUP_PARTITION_RE.test(identifier) &&
    !LEGACY_PARTITION_RE.test(identifier) &&
    !RAW_ROTATED_RE.test(identifier) &&
    !ROLLUP_ROTATED_RE.test(identifier)
  ) {
    throw new Error(`unsafe partition identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function bound(day: Date): string {
  return utcDayStart(day).toISOString();
}

function rollupPartitionName(day: Date): string {
  return partitionName(day).replace(/^logs_p/, 'log_rollups_1m_p');
}

async function ensureRollupPartition(client: Queryable, day: Date): Promise<void> {
  const start = utcDayStart(day);
  const end = new Date(start.getTime() + DAY_MS);
  const name = rollupPartitionName(start);
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(name)} PARTITION OF log_rollups_1m
       FOR VALUES FROM ('${bound(start)}') TO ('${bound(end)}')`,
  );
}

async function createPartition(
  client: Queryable,
  day: Date,
  cacheAfterCreate = true,
): Promise<boolean> {
  const start = utcDayStart(day);
  const end = new Date(start.getTime() + DAY_MS);
  const name = partitionName(start);
  if (await partitionExists(client, day)) {
    await ensureRollupPartition(client, day);
    if (cacheAfterCreate) knownPartitions.add(name);
    return false;
  }

  await client.query(
    `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(name)} PARTITION OF logs
       FOR VALUES FROM ('${bound(start)}') TO ('${bound(end)}')`,
  );
  await ensureRollupPartition(client, day);
  if (cacheAfterCreate) knownPartitions.add(name);
  return true;
}

async function partitionExists(client: Queryable, day: Date): Promise<boolean> {
  const canonicalName = partitionName(day);
  if (knownPartitions.has(canonicalName)) return true;
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
      await ensureRollupPartition(client, day);
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
      AND (
        child.relname ~ '^logs_p[0-9]{4}_[0-9]{2}_[0-9]{2}$'
        OR child.relname ~ '^logs_[0-9]{8}$'
      )
  `);
  return result.rows.map((row) => row.name);
}

async function listDatedRollupPartitions(client: Queryable): Promise<string[]> {
  const result = await client.query<{ name: string }>(`
    SELECT child.relname AS name
    FROM pg_inherits i
    JOIN pg_class child ON child.oid = i.inhrelid
    WHERE i.inhparent = 'log_rollups_1m'::regclass
      AND child.relname ~ '^log_rollups_1m_p[0-9]{4}_[0-9]{2}_[0-9]{2}$'
  `);
  return result.rows.map((row) => row.name);
}

function dayFromPartitionName(name: string): Date | undefined {
  const match =
    PARTITION_RE.exec(name) ?? LEGACY_PARTITION_RE.exec(name) ?? ROLLUP_PARTITION_RE.exec(name);
  if (!match) return undefined;
  const day = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime())) return undefined;
  const canonical = partitionName(day);
  const legacy = canonical.replace(/^logs_p(\d{4})_(\d{2})_(\d{2})$/, 'logs_$1$2$3');
  return name === canonical || name === legacy || name === rollupPartitionName(day)
    ? day
    : undefined;
}

async function listDetachedDefaults(client: Queryable): Promise<Map<string, DetachedDefaults>> {
  const result = await client.query<{ name: string }>(`
    SELECT relname AS name
    FROM pg_class
    WHERE relkind IN ('r', 'p')
      AND (
        relname ~ '^logs_default_detached_[0-9]+$'
        OR relname ~ '^log_rollups_1m_default_detached_[0-9]+$'
      )
  `);
  const detached = new Map<string, DetachedDefaults>();
  for (const row of result.rows) {
    const rawMatch = RAW_ROTATED_RE.exec(row.name);
    const rollupMatch = ROLLUP_ROTATED_RE.exec(row.name);
    const suffix = rawMatch?.[1] ?? rollupMatch?.[1];
    if (!suffix) continue;
    const pair = detached.get(suffix) ?? {};
    if (rawMatch) pair.raw = row.name;
    else pair.rollup = row.name;
    detached.set(suffix, pair);
  }
  return detached;
}

async function defaultRows(client: Queryable): Promise<{ raw: boolean; rollup: boolean }> {
  const result = await client.query<{ raw: boolean; rollup: boolean }>(`
    SELECT
      EXISTS (SELECT 1 FROM logs_default LIMIT 1) AS raw,
      EXISTS (SELECT 1 FROM log_rollups_1m_default LIMIT 1) AS rollup
  `);
  return { raw: result.rows[0]?.raw === true, rollup: result.rows[0]?.rollup === true };
}

async function retainedDetachedDays(
  client: Queryable,
  detached: DetachedDefaults,
  cutoff: Date,
): Promise<Date[]> {
  const days = new Map<number, Date>();
  if (detached.raw) {
    const identifier = quoteIdentifier(detached.raw);
    const result = await client.query<{ day: Date }>(
      `SELECT DISTINCT date_trunc('day', "timestamp" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day
       FROM ${identifier}
       WHERE "timestamp" >= $1`,
      [cutoff],
    );
    for (const row of result.rows) {
      const day = utcDayStart(new Date(row.day));
      days.set(day.getTime(), day);
    }
  }
  if (detached.rollup) {
    const identifier = quoteIdentifier(detached.rollup);
    const result = await client.query<{ day: Date }>(
      `SELECT DISTINCT date_trunc('day', bucket_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day
       FROM ${identifier}
       WHERE bucket_start >= $1`,
      [cutoff],
    );
    for (const row of result.rows) {
      const day = utcDayStart(new Date(row.day));
      days.set(day.getTime(), day);
    }
  }
  return [...days.values()];
}

async function moveAndDropDetached(
  client: Queryable,
  detached: DetachedDefaults,
  cutoff: Date,
): Promise<void> {
  if (detached.raw) {
    const identifier = quoteIdentifier(detached.raw);
    await client.query(
      `INSERT INTO logs (id, "timestamp", level, service, message, attributes)
       SELECT id, "timestamp", level, service, message, attributes
       FROM ${identifier}
       WHERE "timestamp" >= $1
       ON CONFLICT ("timestamp", id) DO NOTHING`,
      [cutoff],
    );
  }
  if (detached.rollup) {
    const identifier = quoteIdentifier(detached.rollup);
    await client.query(
      `INSERT INTO log_rollups_1m (bucket_start, service, level, count)
       SELECT bucket_start, service, level, count
       FROM ${identifier}
       WHERE bucket_start >= $1
       ON CONFLICT (bucket_start, service, level)
       DO UPDATE SET count = log_rollups_1m.count + EXCLUDED.count`,
      [cutoff],
    );
  }
  if (detached.raw) await client.query(`DROP TABLE ${quoteIdentifier(detached.raw)}`);
  if (detached.rollup) await client.query(`DROP TABLE ${quoteIdentifier(detached.rollup)}`);
}

async function prepareAndMoveDetached(
  client: Queryable,
  detached: DetachedDefaults,
  cutoff: Date,
): Promise<Date[]> {
  const days = await retainedDetachedDays(client, detached, cutoff);
  for (const day of days) await createPartition(client, day, false);
  await moveAndDropDetached(client, detached, cutoff);
  return days;
}

async function reconcileDetachedDefaults(
  client: Queryable,
  detached: DetachedDefaults,
  cutoff: Date,
): Promise<void> {
  await client.query('BEGIN');
  let days: Date[];
  try {
    days = await prepareAndMoveDetached(client, detached, cutoff);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  for (const day of days) knownPartitions.add(partitionName(day));
}

async function rotateAndReconcileDefaults(client: Queryable, cutoff: Date): Promise<boolean> {
  const initial = await defaultRows(client);
  if (!initial.raw && !initial.rollup) return false;

  await client.query('BEGIN');
  let days: Date[];
  try {
    await client.query('LOCK TABLE logs IN ACCESS EXCLUSIVE MODE');
    await client.query('LOCK TABLE log_rollups_1m IN ACCESS EXCLUSIVE MODE');
    const confirmed = await defaultRows(client);
    if (!confirmed.raw && !confirmed.rollup) {
      await client.query('COMMIT');
      return false;
    }

    const suffix = String(Date.now());
    const rawDetached = `logs_default_detached_${suffix}`;
    const rollupDetached = `log_rollups_1m_default_detached_${suffix}`;
    const detached: DetachedDefaults = {
      raw: rawDetached,
      rollup: rollupDetached,
    };
    await client.query('ALTER TABLE logs DETACH PARTITION logs_default');
    await client.query(`ALTER TABLE logs_default RENAME TO ${quoteIdentifier(rawDetached)}`);
    await client.query('CREATE TABLE logs_default PARTITION OF logs DEFAULT');
    await client.query('ALTER TABLE log_rollups_1m DETACH PARTITION log_rollups_1m_default');
    await client.query(
      `ALTER TABLE log_rollups_1m_default RENAME TO ${quoteIdentifier(rollupDetached)}`,
    );
    await client.query('CREATE TABLE log_rollups_1m_default PARTITION OF log_rollups_1m DEFAULT');

    days = await prepareAndMoveDetached(client, detached, cutoff);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  for (const day of days) knownPartitions.add(partitionName(day));
  return true;
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

    const cutoff = utcDayStart(new Date(now.getTime() - retentionDays * DAY_MS));
    if (await rotateAndReconcileDefaults(client, cutoff)) result.reconciled++;

    for (const detached of (await listDetachedDefaults(client)).values()) {
      await reconcileDetachedDefaults(client, detached, cutoff);
      result.reconciled++;
    }

    const today = utcDayStart(now);
    for (let offset = 0; offset <= futureDays; offset++) {
      const day = new Date(today.getTime() + offset * DAY_MS);
      if (await createPartition(client, day)) result.created++;
    }

    const rawByDay = partitionsByDay(await listDatedRawPartitions(client));
    const rollupByDay = partitionsByDay(await listDatedRollupPartitions(client));
    const partitionDays = new Set([...rawByDay.keys(), ...rollupByDay.keys()]);
    for (const dayTimestamp of partitionDays) {
      const day = new Date(dayTimestamp);
      if (isDayRetained(day, now, retentionDays)) continue;

      await client.query('BEGIN');
      try {
        const raw = rawByDay.get(dayTimestamp);
        const rollup = rollupByDay.get(dayTimestamp);
        if (raw) await client.query(`DROP TABLE ${quoteIdentifier(raw)}`);
        if (rollup) await client.query(`DROP TABLE ${quoteIdentifier(rollup)}`);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      knownPartitions.delete(partitionName(day));
      result.dropped++;
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

function partitionsByDay(names: readonly string[]): Map<number, string> {
  const partitions = new Map<number, string>();
  for (const name of names) {
    const day = dayFromPartitionName(name);
    if (day) partitions.set(day.getTime(), name);
  }
  return partitions;
}
