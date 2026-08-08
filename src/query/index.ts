import { query } from '../db/index.js';
import { buildQuery } from './build.js';
import { encodeCursor } from './cursor.js';
import type { ApiLog, DbLogRow, QueryLogsResult } from '../ingestion/types.js';
import type { LogQuery } from './types.js';

export async function queryLogs(log: LogQuery): Promise<QueryLogsResult> {
  const { text, params } = buildQuery(log);
  const { rows } = await query<DbLogRow>(text, params);

  const hasNextPage = rows.length > log.limit;
  const page = rows.slice(0, log.limit);
  const boundary = hasNextPage ? page.at(-1)! : undefined;

  return {
    logs: page.map(toApiLog),
    next_cursor: boundary ? encodeCursor(boundary.timestamp, boundary.id) : null,
  };
}

function toApiLog(row: DbLogRow): ApiLog {
  return {
    ...row,
    timestamp: row.timestamp.toISOString(),
  };
}
