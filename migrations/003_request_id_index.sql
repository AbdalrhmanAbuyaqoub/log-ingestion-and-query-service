-- The load generator verifies accepted logs by their string request_id and a
-- message substring. request_id is highly selective, so this small B-tree
-- finds the candidate rows before applying the unindexed message predicate.
-- Creating it on the partitioned parent propagates it to existing and future
-- daily partitions.
CREATE INDEX logs_request_id_ts_id_idx
ON logs ((attributes ->> 'request_id'), "timestamp" DESC, id DESC);
