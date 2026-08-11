import type { LogLevel } from '../ingestion/types.js';

export type AttrFilter = { key: string; values: string[] };

export type BuiltQuery = { text: string; params: unknown[] };

export type LogFilters = {
  service?: string;
  level?: LogLevel;
  since?: Date;
  until?: Date;
  attrs: AttrFilter[];
  q?: string;
};

export type LogQuery = LogFilters & {
  limit: number;
  cursor?: { t: Date; id: string };
};

export type BuiltFilters = {
  whereClause: string;
  params: unknown[];
  nextPlaceholder: number;
};
