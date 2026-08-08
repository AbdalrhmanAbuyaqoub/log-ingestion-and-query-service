// SELECT id::text, "timestamp", level, service, message, attributes
// FROM logs
// WHERE
//   [since]      "timestamp" >= $1                              -- timestamptz
//   [until]      AND "timestamp" < $2                           -- timestamptz
//   [service]    AND service = $3
//   [level]      AND level = $4
//   [q]          AND message ILIKE ('%' || $5 || '%') ESCAPE '\'
//   [attr.k1]    AND (attributes ->> $6 = $7 OR attributes ->> $8 = $9)
//   [attr.k2]    AND ( ... )
//   ...
//   [cursor]     AND ("timestamp", id) < ($n, $m::bigint)
// ORDER BY "timestamp" DESC, id DESC
// LIMIT $k

import type { BuiltQuery, LogQuery } from './types.js';

export function buildQuery(log: LogQuery): BuiltQuery {
  const where: string[] = [];
  const params: unknown[] = [];
  let n = 1;

  // helper function for building parameterized SQL queries $1, $2,
  // It returns the fragment with %P% replaced by real $n placeholders.
  const push = (fragment: string, ...values: unknown[]): string => {
    const placeholders: string[] = [];
    for (const v of values) {
      placeholders.push(`$${n++}`);
      params.push(v);
    }
    return fragment.replaceAll('%P%', () => placeholders.shift() ?? '?');
  };

  if (log.service !== undefined) where.push(push('service = %P%', log.service));
  if (log.level) where.push(push('level = %P%', log.level));
  if (log.since) where.push(push('"timestamp" >= %P%', log.since));
  if (log.until) where.push(push('"timestamp" < %P%', log.until));
  for (const attr of log.attrs) {
    where.push(buildAttrFragment(attr.key, attr.values, push));
  }
  if (log.q !== undefined) where.push(push("message ILIKE ('%' || %P% || '%') ESCAPE '\\'", log.q));
  if (log.cursor) {
    where.push(push('("timestamp", id) < (%P%, %P%::bigint)', log.cursor.t, log.cursor.id));
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join('\n  AND ')}` : '';
  const text = `
SELECT id::text, "timestamp", level, service, message, attributes
FROM logs
${whereClause}
ORDER BY "timestamp" DESC, id DESC
LIMIT ${'$' + n}
`.trim();
  params.push(log.limit + 1);

  return { text, params };
}

function buildAttrFragment(
  key: string,
  values: string[],
  push: (fragment: string, ...values: unknown[]) => string,
): string {
  const branches: string[] = [];
  for (const v of values) {
    branches.push(push('attributes ->> %P% = %P%', key, v));
  }
  return `(${branches.join(' OR ')})`;
}
