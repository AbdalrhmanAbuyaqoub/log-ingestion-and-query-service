-- * logs is range-partitioned by day on "timestamp". Retention is implemented
--   by dropping whole partitions (instant, no bloat) instead of DELETEs.

-- * The PRIMARY KEY must include the partition key; (timestamp, id) doubles as
--   the keyset-pagination index (ORDER BY "timestamp" DESC, id DESC).

-- * attributes remains typed JSONB. Attribute filters use JSONB text
--   extraction (`attributes ->> key = value`) without an attribute index.

-- * pg_trgm backs case-insensitive substring search on message (q=...).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- IDs only need to be unique, not contiguous. Reserving sequence values per
-- database connection avoids sequence-page work for every ingested log; gaps
-- after a restart are harmless and expected.
CREATE SEQUENCE IF NOT EXISTS logs_id_seq CACHE 1000;

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

-- Purpose: the common query shape GET /logs?service=foo&before=… — filter by
-- service, paginate newest-first.
-- Timestamp ordering is already selective enough that ID ties form tiny
-- groups. Omitting ID reduces the index maintained for every raw log while
-- PostgreSQL uses an incremental sort to preserve deterministic pagination.
CREATE INDEX logs_service_ts_idx ON logs (service, "timestamp" DESC);

-- Exact one-minute rollups for the common aggregation path. The dimensions
-- are deliberately limited to service and level; attribute and message
-- filters continue to query canonical raw logs.
CREATE TABLE log_rollups_1m (
    bucket_start timestamptz NOT NULL,
    service      text        NOT NULL,
    level        text        NOT NULL,
    count        bigint      NOT NULL CHECK (count >= 0),
    PRIMARY KEY (bucket_start, service, level)
);

INSERT INTO log_rollups_1m (bucket_start, service, level, count)
SELECT date_bin('1 minute'::interval, "timestamp", '1970-01-01T00:00:00Z'::timestamptz),
       service,
       level,
       COUNT(*)
FROM logs
GROUP BY 1, 2, 3;