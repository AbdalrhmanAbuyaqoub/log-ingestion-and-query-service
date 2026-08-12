-- Exact one-minute rollups for the common aggregation path. The dimensions
-- are deliberately limited to service and level; attribute and message
-- filters continue to query canonical raw logs.
CREATE TABLE log_rollups_1m (
    bucket_start timestamptz NOT NULL,
    service      text        NOT NULL,
    level        text        NOT NULL,
    count        bigint      NOT NULL CHECK (count >= 0),
    PRIMARY KEY (bucket_start, service, level)
) PARTITION BY RANGE (bucket_start);

CREATE TABLE log_rollups_1m_default PARTITION OF log_rollups_1m DEFAULT;

-- Create matching daily partitions for existing retained data before the
-- backfill so the default partition remains only a safety net.
DO $block$
DECLARE
    day_start timestamptz;
    child_name text;
BEGIN
    FOR day_start IN
        SELECT DISTINCT date_trunc('day', "timestamp") FROM logs
    LOOP
        child_name := 'log_rollups_1m_p' || to_char(day_start AT TIME ZONE 'UTC', 'YYYY_MM_DD');
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF log_rollups_1m FOR VALUES FROM (%L) TO (%L)',
            child_name,
            day_start,
            day_start + interval '1 day'
        );
    END LOOP;
END
$block$;

INSERT INTO log_rollups_1m (bucket_start, service, level, count)
SELECT date_bin('1 minute'::interval, "timestamp", '1970-01-01T00:00:00Z'::timestamptz),
       service,
       level,
       COUNT(*)
FROM logs
GROUP BY 1, 2, 3;
