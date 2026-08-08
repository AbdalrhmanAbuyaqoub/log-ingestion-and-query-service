import { Buffer } from 'node:buffer';
import { ValidationError } from '../ingestion/errors.js';
import { parseIsoTimestamp } from '../timestamp.js';

export type CursorPayload = { t: string; id: string };

const ID_RE = /^\d+$/;

export function encodeCursor(t: Date, id: string): string {
  const payload: CursorPayload = { t: t.toISOString(), id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): CursorPayload {
  if (!raw) throw new ValidationError('malformed cursor');

  let json: string;
  try {
    json = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new ValidationError('malformed cursor');
  }

  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new ValidationError('malformed cursor');
  }

  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new ValidationError('malformed cursor');
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.t !== 'string' || typeof o.id !== 'string') {
    throw new ValidationError('malformed cursor');
  }
  if (!parseIsoTimestamp(o.t)) throw new ValidationError('malformed cursor');
  if (!ID_RE.test(o.id)) throw new ValidationError('malformed cursor');

  return { t: o.t, id: o.id };
}
