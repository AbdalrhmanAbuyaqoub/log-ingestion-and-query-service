-- Initial schema for the log ingestion service.
--
-- Design notes:
-- * logs is range-partitioned by day on "timestamp". Retention is implemented
--   by dropping whole partitions (instant, no bloat) instead of DELETEs.
-- * The PRIMARY KEY must include the partition key; (timestamp, id) doubles as
--   the keyset-pagination index (ORDER BY "timestamp" DESC, id DESC).
-- * attributes is JSONB indexed with jsonb_path_ops, which serves the
--   containment queries (@>) used for attr.<key>=value filters.
-- * pg_trgm backs case-insensitive substring search on message (q=...).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SEQUENCE IF NOT EXISTS logs_id_seq;

CREATE TABLE logs (
    id          bigint      NOT NULL DEFAULT nextval('logs_id_seq'),
    "timestamp" timestamptz NOT NULL,
    level       text        NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
    service     text        NOT NULL,
    message     text        NOT NULL,
    attributes  jsonb       NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY ("timestamp", id)
) PARTITION BY RANGE ("timestamp");

-- Safety net for rows whose timestamp has no dedicated partition yet
-- (late arrivals, clock skew). The partition manager creates dated
-- partitions ahead of time; this default partition must never hold
-- meaningful volume.
CREATE TABLE logs_default PARTITION OF logs DEFAULT;

CREATE INDEX logs_service_ts_id_idx ON logs (service, "timestamp" DESC, id DESC);

CREATE INDEX logs_attributes_gin_idx ON logs USING gin (attributes jsonb_path_ops);

CREATE INDEX logs_message_trgm_idx ON logs USING gin (message gin_trgm_ops);
