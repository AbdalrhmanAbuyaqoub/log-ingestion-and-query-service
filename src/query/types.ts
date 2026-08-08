import type { LogLevel } from '../ingestion/types.js';

export type AttrFilter = { key: string; values: string[] };

export type BuiltQuery = { text: string; params: unknown[] };

export type LogQuery = {
  service?: string;
  level?: LogLevel;
  since?: Date;
  until?: Date;
  attrs: AttrFilter[];
  q?: string;
  limit: number;
  cursor?: { t: Date; id: string };
};
