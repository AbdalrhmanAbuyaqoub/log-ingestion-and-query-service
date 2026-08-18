-- Convert log_rollups_1m from range-partitioned to a flat table.
-- Rollups are a small summary (~430K rows for 30 days) that don't need
-- partition pruning; the PK index handles range scans at this scale.
-- Retention for rollups becomes a simple DELETE (negligible bloat at
-- this scale); raw logs remain strictly DROP-partition based.

CREATE TABLE log_rollups_1m_flat (
    bucket_start timestamptz NOT NULL,
    service      text        NOT NULL,
    level        text        NOT NULL,
    count        bigint      NOT NULL CHECK (count >= 0),
    PRIMARY KEY (bucket_start, service, level)
);

INSERT INTO log_rollups_1m_flat (bucket_start, service, level, count)
SELECT bucket_start, service, level, count FROM log_rollups_1m;

DROP TABLE log_rollups_1m CASCADE;

ALTER TABLE log_rollups_1m_flat RENAME TO log_rollups_1m;
