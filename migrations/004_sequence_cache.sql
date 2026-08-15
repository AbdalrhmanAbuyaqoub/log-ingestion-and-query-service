-- IDs only need to be unique, not contiguous. Reserving sequence values per
-- database connection avoids sequence-page work for every ingested log; gaps
-- after a restart are harmless and expected.
ALTER SEQUENCE logs_id_seq CACHE 1000;
