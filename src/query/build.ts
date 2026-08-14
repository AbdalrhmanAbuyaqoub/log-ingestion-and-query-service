import type { BuiltFilters, BuiltQuery, LogFilters, LogQuery } from './types.js';

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

export function buildQuery(log: LogQuery): BuiltQuery {
  const filters = buildFilterWhere(log);
  const params = [...filters.params];
  let n = filters.nextPlaceholder;
  let whereClause = filters.whereClause;

  if (log.cursor) {
    const cursorPredicate = `("timestamp", id) < ($${n++}, $${n++}::bigint)`;
    params.push(log.cursor.t, log.cursor.id);
    whereClause = whereClause
      ? `${whereClause}\n  AND ${cursorPredicate}`
      : `WHERE ${cursorPredicate}`;
  }

  const text = `
SELECT l.id::text, l."timestamp", l.level, l.service, l.message, l.attributes
FROM logs AS l
${whereClause}
ORDER BY l."timestamp" DESC, l.id DESC
LIMIT ${'$' + n}
`.trim();
  params.push(log.limit + 1);

  return { text, params };
}

export function buildFilterWhere(filters: LogFilters): BuiltFilters {
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

  if (filters.service !== undefined) where.push(push('service = %P%', filters.service));
  if (filters.level) where.push(push('level = %P%', filters.level));
  if (filters.since) where.push(push('"timestamp" >= %P%', filters.since));
  if (filters.until) where.push(push('"timestamp" < %P%', filters.until));
  for (const attr of filters.attrs) {
    where.push(buildAttrFragment(attr.key, attr.values, push));
  }
  if (filters.q !== undefined) {
    where.push(push("message ILIKE ('%' || %P% || '%') ESCAPE '\\'", filters.q));
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join('\n  AND ')}` : '';
  return { whereClause, params, nextPlaceholder: n };
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
