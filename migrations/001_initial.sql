-- Initial schema for the log ingestion service.
--
-- Design notes:
-- * logs is range-partitioned by day on "timestamp". Retention is implemented
--   by dropping whole partitions (instant, no bloat) instead of DELETEs.
-- * The PRIMARY KEY must include the partition key; (timestamp, id) doubles as
--   the keyset-pagination index (ORDER BY "timestamp" DESC, id DESC).
-- * attributes remains typed JSONB. Attribute filters use JSONB text
--   extraction (`attributes ->> key = value`) without an attribute index.
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


-- Purpose: the common query shape GET /logs?service=foo&before=… — filter by service, paginate newest-first.
-- Why three columns: with service first the planner can seek to the right service constant,
-- then walk ("timestamp" DESC, id DESC) in already-sorted order → no sort step, straight index-only scan for the page.
-- he (service, before) keyset is (service, timestamp, id) < ($1, $2, $3), which maps exactly onto the index ordering.
CREATE INDEX logs_service_ts_id_idx ON logs (service, "timestamp" DESC, id DESC);
