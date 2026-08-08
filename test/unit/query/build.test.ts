import { describe, expect, it } from 'vitest';
import { buildQuery } from '../../../src/query/build.js';
import type { LogQuery } from '../../../src/query/types.js';

function logQuery(overrides: Partial<LogQuery> = {}): LogQuery {
  return { attrs: [], limit: 100, ...overrides };
}

describe('buildQuery', () => {
  it('compares attribute values as parameterized JSON text', () => {
    const built = buildQuery(logQuery({ attrs: [{ key: 'retry_count', values: ['3', '4'] }] }));

    expect(built.text).toContain('(attributes ->> $1 = $2 OR attributes ->> $3 = $4)');
    expect(built.text).not.toContain('@>');
    expect(built.params).toEqual(['retry_count', '3', 'retry_count', '4', 101]);
  });

  it('preserves other predicates and parameter ordering', () => {
    const built = buildQuery(
      logQuery({
        service: 'checkout',
        attrs: [{ key: 'enabled', values: ['true'] }],
      }),
    );

    expect(built.text).toContain('service = $1');
    expect(built.text).toContain('attributes ->> $2 = $3');
    expect(built.params).toEqual(['checkout', 'enabled', 'true', 101]);
  });
});
