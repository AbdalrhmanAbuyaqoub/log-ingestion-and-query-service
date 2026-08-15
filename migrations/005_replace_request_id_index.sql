-- Equality on request_id identifies a tiny candidate set. Timestamp and ID
-- ordering can be applied after that lookup without paying to maintain the
-- wider composite key for every ingested log.
DROP INDEX logs_request_id_ts_id_idx;

CREATE INDEX logs_request_id_idx
ON logs ((attributes ->> 'request_id'));
