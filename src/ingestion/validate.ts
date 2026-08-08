import {
  LOG_LEVELS,
  type AttrValue,
  type Attributes,
  type LogLevel,
  type ValidLogEntry,
} from './types.js';
import { ValidationError } from './errors.js';
import { parseIsoTimestamp } from '../timestamp.js';

const MAX_FUTURE_MS = 5 * 60_000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isAttrValue(v: unknown): v is AttrValue {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * Validates a single raw log entry. Returns the validated entry, or a reason
 * string on failure. Does not throw — collect-all-rejections is the contract.
 */
export function validateEntry(raw: unknown, now: number = Date.now()): ValidLogEntry | string {
  if (!isPlainObject(raw)) return 'entry must be an object';

  const r = raw as Record<string, unknown>;

  const tsRaw = r['timestamp'];
  if (typeof tsRaw !== 'string') return 'timestamp must be an ISO 8601 string';
  const timestamp = parseIsoTimestamp(tsRaw);
  if (!timestamp) return 'timestamp must be a valid ISO 8601 timestamp';
  const tsMs = timestamp.getTime();
  if (tsMs > now + MAX_FUTURE_MS) return 'timestamp must not be more than 5 minutes in the future';

  const level = r['level'];
  if (typeof level !== 'string' || !LOG_LEVELS.includes(level as LogLevel)) {
    return `invalid level: '${String(level)}'`;
  }

  const service = r['service'];
  if (typeof service !== 'string' || service.trim().length === 0) {
    return 'service must be a non-empty string';
  }

  const message = r['message'];
  if (typeof message !== 'string' || message.trim().length === 0) {
    return 'message must be a non-empty string';
  }

  if (!('attributes' in r)) {
    return {
      timestamp,
      level: level as LogLevel,
      service,
      message,
      attributes: {},
    };
  }

  const attrsRaw = r['attributes'];
  if (attrsRaw === null) return 'invalid attributes: null is not allowed';
  if (!isPlainObject(attrsRaw)) {
    return 'attributes must be a flat object with string, number, or boolean values';
  }

  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(attrsRaw)) {
    if (!isAttrValue(value)) {
      return 'attributes must be a flat object with string, number, or boolean values';
    }
    attributes[key] = value;
  }

  return { timestamp, level: level as LogLevel, service, message, attributes };
}

/**
 * Validates the top-level batch shape (throws ValidationError → 400) then
 * per-entry validates, collecting all rejections with their array index.
 */
export function validateBatch(body: unknown, now: number = Date.now()) {
  if (!isPlainObject(body)) throw new ValidationError('request body must be an object');

  const logs = (body as Record<string, unknown>)['logs'];
  if (!Array.isArray(logs)) throw new ValidationError('logs must be an array');
  if (logs.length === 0) throw new ValidationError('empty batch');

  const valid: ValidLogEntry[] = [];
  const rejected: { index: number; reason: string }[] = [];

  for (let i = 0; i < logs.length; i++) {
    const result = validateEntry(logs[i], now);
    if (typeof result === 'string') {
      rejected.push({ index: i, reason: result });
    } else {
      valid.push(result);
    }
  }

  return { valid, rejected };
}
