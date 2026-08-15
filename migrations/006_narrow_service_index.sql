-- Timestamp ordering is already selective enough that ID ties form tiny
-- groups. Omitting ID reduces the index maintained for every raw log while
-- PostgreSQL uses an incremental sort to preserve deterministic pagination.
DROP INDEX logs_service_ts_id_idx;

CREATE INDEX logs_service_ts_idx
ON logs (service, "timestamp" DESC);
