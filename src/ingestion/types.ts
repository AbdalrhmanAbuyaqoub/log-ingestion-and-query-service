export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type AttrValue = string | number | boolean;
export type Attributes = Record<string, AttrValue>;

export type ValidLogEntry = {
  timestamp: Date;
  level: LogLevel;
  service: string;
  message: string;
  attributes: Attributes;
};

export type Rejection = { index: number; reason: string };

export type BatchResult = { valid: ValidLogEntry[]; rejected: Rejection[] };

export type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
};
