import { isValid, parseISO } from 'date-fns';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * Parses only the timestamp shape accepted by the API contract. The regular
 * expression rejects date-only and other broader ISO forms supported by
 * date-fns; parseISO + isValid reject impossible calendar dates and times.
 */
export function parseIsoTimestamp(raw: string): Date | undefined {
  // This canonical shape is emitted by the official generator. Component
  // checks reject normalized impossible dates while avoiding both date-fns
  // and an allocated ISO round-trip string on the per-entry hot path.
  if (hasCanonicalUtcMillisShape(raw)) {
    const milliseconds = Date.parse(raw);
    if (!Number.isFinite(milliseconds) || !hasValidCanonicalComponents(raw)) return undefined;
    return new Date(milliseconds);
  }

  if (!ISO_RE.test(raw)) return undefined;
  const parsed = parseISO(raw);
  return isValid(parsed) ? parsed : undefined;
}

function hasCanonicalUtcMillisShape(raw: string): boolean {
  return (
    raw.length === 24 &&
    raw.charCodeAt(4) === 45 &&
    raw.charCodeAt(7) === 45 &&
    raw.charCodeAt(10) === 84 &&
    raw.charCodeAt(13) === 58 &&
    raw.charCodeAt(16) === 58 &&
    raw.charCodeAt(19) === 46 &&
    raw.charCodeAt(23) === 90
  );
}

function hasValidCanonicalComponents(raw: string): boolean {
  const year =
    (raw.charCodeAt(0) - 48) * 1000 +
    (raw.charCodeAt(1) - 48) * 100 +
    (raw.charCodeAt(2) - 48) * 10 +
    raw.charCodeAt(3) -
    48;
  const month = twoDigitsAt(raw, 5);
  const day = twoDigitsAt(raw, 8);
  const hour = twoDigitsAt(raw, 11);
  const minute = twoDigitsAt(raw, 14);
  const second = twoDigitsAt(raw, 17);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;

  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]!;
  return day >= 1 && day <= maxDay;
}

function twoDigitsAt(raw: string, offset: number): number {
  return (raw.charCodeAt(offset) - 48) * 10 + raw.charCodeAt(offset + 1) - 48;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
