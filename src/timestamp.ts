import { isValid, parseISO } from 'date-fns';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses only the timestamp shape accepted by the API contract. The regular
 * expression rejects date-only and other broader ISO forms supported by
 * date-fns; parseISO + isValid reject impossible calendar dates and times.
 */
export function parseIsoTimestamp(raw: string): Date | undefined {
  if (!ISO_RE.test(raw)) return undefined;

  const parsed = parseISO(raw);
  return isValid(parsed) ? parsed : undefined;
}
