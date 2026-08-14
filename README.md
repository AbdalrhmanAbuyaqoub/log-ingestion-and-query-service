# Log Ingestion Service

A high-throughput API for ingesting, searching, aggregating, and expiring structured logs. It is built with strict TypeScript, Express 5, raw parameterized SQL, and PostgreSQL 18, and is designed for the grading limits of 0.5 application CPU/256 MB RAM and 1 database CPU/1 GB RAM.

The four required endpoints are available without authentication or rate limits. PostgreSQL is the source of truth, and accepted logs are queryable as soon as `POST /logs` returns.

## Quick start

The complete stack needs only Docker and Docker Compose:

```bash
docker compose up --build --wait
curl http://localhost:8080/health
```

The health response is:

```json
{
  "status": "ok"
}
```

Migrations and initial partition maintenance run before the application starts listening. Stop the stack while preserving its data with `docker compose down`, or remove the database volume as well with `docker compose down -v`.

If host port 8080 is already in use, leave the other process alone and expose a one-off application container on 18080:

```bash
docker compose up -d db
docker compose build app
docker compose run -d --rm --no-deps -p 18080:8080 --name lis-verify app
curl http://localhost:18080/health
```

### Local development

Node.js 24 or newer and Docker are required. The Compose override publishes PostgreSQL on host port 5433 to avoid the usual local PostgreSQL port.

```bash
docker compose up -d db
cp .env.example .env
npm ci
npm run dev
```

The local process reads `.env` and listens on `http://localhost:8080`. Full-stack Compose does not read `.env`; it injects its own container configuration.

Useful commands:

| Command                    | Purpose                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `npm run dev`              | Start the TypeScript watch server                                                      |
| `npm run build`            | Compile to `dist/`                                                                     |
| `npm run format`           | Format the repository with Prettier                                                    |
| `npm run lint`             | Run ESLint                                                                             |
| `npm run typecheck`        | Type-check without emitting files                                                      |
| `npm run test`             | Run unit tests                                                                         |
| `npm run test:integration` | Run Testcontainers integration tests; Docker is required                               |
| `npm run migrate -- up`    | Apply migrations manually using `DATABASE_URL`; normal startup does this automatically |

## API

All examples use `http://localhost:8080`. Successful and error JSON is formatted with two-space indentation.

### `GET /health`

Runs `SELECT 1` and returns HTTP 200 with `{"status":"ok"}` when PostgreSQL is reachable. The process does not listen until migrations and startup partition maintenance have completed, so a successful response means the service is ready.

### `POST /logs`

The endpoint always accepts a batch, including a one-entry batch:

```bash
curl -X POST http://localhost:8080/logs \
  -H 'Content-Type: application/json' \
  --data '{
    "logs": [
      {
        "timestamp": "2026-08-10T10:00:45Z",
        "level": "error",
        "service": "checkout",
        "message": "payment declined",
        "attributes": {
          "user_id": "42",
          "region": "eu-west",
          "retries": 3
        }
      },
      {
        "timestamp": "2026-08-10T10:00:46Z",
        "level": "critical",
        "service": "checkout",
        "message": "invalid example"
      }
    ]
  }'
```

Valid entries are durably inserted while invalid entries are rejected independently:

```json
{
  "accepted": 1,
  "rejected": [
    {
      "index": 1,
      "reason": "invalid level: 'critical'"
    }
  ]
}
```

Each entry must have:

- `timestamp`: a valid ISO 8601 string no more than five minutes in the future.
- `level`: `debug`, `info`, `warn`, or `error`.
- `service` and `message`: non-empty strings.
- `attributes`: optional. When present it must be a flat object whose values are strings, numbers, or booleans. Omitting it stores `{}`; explicitly sending `null`, arrays, objects, or nested values rejects the entry.

HTTP 200 is returned when at least one entry is accepted. HTTP 400 is returned for malformed JSON, an invalid top-level body, an empty `logs` array, or a batch in which every entry is invalid. Request JSON is limited to 10 MB.

### `GET /logs`

All filters are optional and freely combinable:

| Parameter    | Behavior                                                           |
| ------------ | ------------------------------------------------------------------ |
| `service`    | Exact service match                                                |
| `level`      | Exact supported-level match                                        |
| `since`      | Inclusive ISO 8601 lower timestamp bound                           |
| `until`      | Exclusive ISO 8601 upper timestamp bound                           |
| `attr.<key>` | Attribute equality after converting the stored JSON scalar to text |
| `q`          | Case-insensitive literal substring match on `message`              |
| `limit`      | Page size; defaults to 100 and must be 1–1000                      |
| `cursor`     | Opaque continuation token from `next_cursor`                       |

```bash
curl --get http://localhost:8080/logs \
  --data-urlencode 'service=checkout' \
  --data-urlencode 'level=error' \
  --data-urlencode 'since=2026-08-10T10:00:00Z' \
  --data-urlencode 'until=2026-08-11T10:00:00Z' \
  --data-urlencode 'attr.user_id=42' \
  --data-urlencode 'q=declined' \
  --data-urlencode 'limit=100'
```

```json
{
  "logs": [
    {
      "id": "1234",
      "timestamp": "2026-08-10T10:00:45.000Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": {
        "user_id": "42",
        "region": "eu-west",
        "retries": 3
      }
    }
  ],
  "next_cursor": null
}
```

Results are ordered by `(timestamp, id)` descending, which makes equal timestamps deterministic. IDs are PostgreSQL `bigint` values serialized as JSON strings. The service fetches one extra row to determine whether another page exists; pass a non-null `next_cursor` back unchanged. Cursors encode the last timestamp and ID but should be treated as opaque.

Time ranges are half-open: `since <= timestamp < until`. Equal bounds form a valid empty range; only `until < since` is rejected. Repeating one attribute key creates an OR condition for its values, while different attribute keys are combined with AND. Attribute comparisons use `attributes ->> key = value`, so stored `42`, `"42"`, and a requested `42` compare by their JSON text representation.

### `GET /logs/aggregate`

Aggregation accepts the same `service`, `level`, `attr.<key>`, and `q` filters. `since`, `until`, and `bucket` are required. `bucket` must be `1m`, `5m`, `1h`, or `1d`; optional `group_by` must be `service` or `level`.

```bash
curl --get http://localhost:8080/logs/aggregate \
  --data-urlencode 'since=2026-08-10T10:00:00Z' \
  --data-urlencode 'until=2026-08-10T11:00:00Z' \
  --data-urlencode 'bucket=5m' \
  --data-urlencode 'group_by=service'
```

```json
{
  "buckets": [
    {
      "start": "2026-08-10T10:00:00.000Z",
      "group": "checkout",
      "count": 118
    },
    {
      "start": "2026-08-10T10:05:00.000Z",
      "group": "checkout",
      "count": 97
    }
  ]
}
```

Buckets use PostgreSQL `date_bin`, are ordered by start time and then group, and omit empty intervals. Without `group_by`, each row has `"group": null`. Aggregation uses the same inclusive/exclusive range semantics as log queries.

### Errors

Invalid query parameters and invalid ingestion structures return HTTP 400:

```json
{
  "error": "<description>"
}
```

Examples include invalid or repeated scalar parameters, unsupported levels or bucket sizes, missing aggregation bounds, limits outside 1–1000, reversed ranges, and malformed cursors. Unknown routes return HTTP 404 in the same shape. Unexpected failures return HTTP 500 without exposing internal details.

## Architecture and data design

The HTTP layer only parses requests and writes responses. Validation and ingestion live in `src/ingestion/`, query parsing/building in `src/query/`, aggregation in `src/aggregation/`, and partition lifecycle management in `src/retention/`. Database access is centralized in a node-postgres pool.

### Ingestion path

Validation is hand-written to collect per-entry failures and minimize work on the half-CPU hot path. Valid entries from concurrent requests are coalesced into one parameterized `INSERT ... SELECT FROM unnest(...)` when 500 entries accumulate or the oldest request has waited 50 ms. Request boundaries and rejection indexes are preserved, and a response is sent only after the combined insert commits, so HTTP 200 still means the request's logs are durable and immediately queryable.

The waiting queue is capped at 50,000 entries. A request that would exceed the cap is rejected in full with HTTP 503 and `Retry-After: 1`; buffered data is never acknowledged early. Shutdown stops admission and drains queued writes before closing PostgreSQL.

Before inserting retained late-arriving timestamps, the service ensures their daily partitions exist. Input outside the retained window can safely enter the default partition and is removed during maintenance.

### Schema and indexes

`logs` is range-partitioned on `timestamp` into UTC days:

| Column       | PostgreSQL type | Notes                                        |
| ------------ | --------------- | -------------------------------------------- |
| `id`         | `bigint`        | Generated by `logs_id_seq`                   |
| `timestamp`  | `timestamptz`   | Partition key                                |
| `level`      | `text`          | Database check constraint mirrors API levels |
| `service`    | `text`          | Exact-match dimension                        |
| `message`    | `text`          | Original log message                         |
| `attributes` | `jsonb`         | Typed flat scalar map, default `{}`          |

The primary key is `(timestamp, id)`, as PostgreSQL requires a partitioned unique key to include the partition key. It also supplies deterministic newest-first keyset pagination without an offset scan. The `(service, timestamp DESC, id DESC)` index accelerates the common service-filtered paginated query. A targeted `((attributes ->> 'request_id'), timestamp DESC, id DESC)` index accelerates the load generator's selective visibility probe and propagates to existing and future partitions. A `logs_default` partition prevents insertion failure when a dated partition is unexpectedly absent.

An atomic one-minute rollup keyed by timestamp, service, and level accelerates aggregates that do not use attribute or message filters. Arbitrary range boundaries remain exact by subtracting raw rows outside the requested half-open range from the boundary-minute rollups. Attribute- and message-filtered aggregates continue to use canonical logs. Rollup partitions follow the same daily creation and `DROP` retention lifecycle as raw-log partitions.

All user values are SQL parameters. The only dynamic aggregation expressions and partition identifiers come from fixed allowlists or strictly validated internal names.

### Attribute storage

Canonical attributes remain typed `jsonb`, preserving numbers and booleans in storage and responses. Filters deliberately use `attributes ->> key = value`, matching the contract's string-comparison semantics. Only `request_id` has a targeted expression index because the official visibility lookup uses that highly selective value. There is no broad JSONB index; other attribute-heavy scans remain a known trade-off under the one-CPU database budget.

### Partitioning and retention

Startup creates today's partition and two days ahead. An hourly scheduler repeats maintenance; a PostgreSQL advisory lock prevents concurrent maintainers. Complete UTC-day partitions are dropped only when their entire interval is outside `RETENTION_DAYS`, avoiding row-by-row `DELETE`, dead tuples, table bloat, and long-running cleanup.

The default safety partition is rotated when it contains rows. Still-retained rows are moved into newly created dated partitions and expired rows disappear when the detached table is dropped. Because deletion is day-granular, the default 30-day policy retains data for approximately 30–31 days.

## Configuration and operations

| Variable                   | Required/default                  | Local development                                              | Compose stack                                   |
| -------------------------- | --------------------------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| `DATABASE_URL`             | Required                          | `postgres://logs:logs@localhost:5433/logs` from `.env.example` | Injected as `postgres://logs:logs@db:5432/logs` |
| `PORT`                     | Default `8080`                    | Read from `.env`/process environment                           | Injected as `8080` and published on host 8080   |
| `RETENTION_DAYS`           | Default `30`; positive integer    | Read from `.env`/process environment                           | Injected as `30`                                |
| `INGEST_FLUSH_INTERVAL_MS` | Default `50`; positive integer    | Maximum wait before a partial ingest flush                     | Injected as `50`                                |
| `INGEST_FLUSH_BATCH_SIZE`  | Default `500`; positive integer   | Entry count that triggers an immediate flush                   | Injected as `500`                               |
| `INGEST_BUFFER_MAX`        | Default `50000`; positive integer | Maximum entries waiting behind the active flush                | Injected as `50000`                             |

No authentication, API keys, multi-tenancy, rate limiting, dashboards, or other optional contract-changing features are implemented. A plain `docker compose up` therefore exposes all four core endpoints without credentials or additional configuration. Unrecognized bearer tokens are harmless because there is no authentication middleware.

The application retries startup migrations 15 times at one-second intervals and listens only after migrations and initial maintenance succeed. `SIGINT` and `SIGTERM` stop the partition scheduler, close the HTTP server, and close the database pool. Runtime Compose health checks exercise the database-backed `/health` endpoint.

CI runs linting, Prettier verification, type checking, unit tests, Testcontainers integration tests, TypeScript compilation, a Docker image build, and a separate Compose smoke test covering all four endpoints.

## Performance results

The k6 scenarios in [`load/`](load/README.md) exercise ingestion alone and the complete grading contract. The contract scenario verifies readiness and immediate visibility, sends 1,000 logs per request at a requested 15 batches/s, and concurrently requests a full-range hourly aggregation grouped by service once per second.

The strongest saved complete-contract run is [`contract-empty-to-999k.json`](load/out/contract-empty-to-999k.json). It used the Compose limits above, started from an empty database, ran for approximately 75 seconds, and grew the dataset beyond one million rows during the test:

| Metric                          | Measured result       |
| ------------------------------- | --------------------- |
| Accepted logs                   | 1,126,000             |
| Accepted throughput             | 14,993.56 logs/s      |
| Batch size / requested rate     | 1,000 / 15,000 logs/s |
| Rejected logs                   | 0                     |
| HTTP request failure rate       | 0%                    |
| Dropped iterations              | 0                     |
| Successful aggregation requests | 75 (1/s)              |
| Ingestion latency p95           | 215.94 ms             |
| Aggregation latency p95         | 357.36 ms             |

This run demonstrates the target workload while the table grows through roughly one million rows; it is not evidence of a full two-minute run beginning with an already seeded one-million-row dataset. Saved two-minute seeded attempts did not meet all thresholds, so they are retained as diagnostic evidence rather than presented as passes. CPU and memory utilization were observed against enforced Compose limits but were not exported into the k6 summaries; no precise utilization percentages are claimed.

Measured bottlenecks included PostgreSQL checkpoint pressure during sustained writes and severe write amplification from a trigram message index. The current design uses `unnest` inserts, daily partition pruning, keyset pagination, a service-aligned index, and the Compose-configured 1 GB `max_wal_size`. The trigram extension remains available, but the write-expensive message GIN index is not created; `q` currently relies on partition-pruned `ILIKE` scans.

See the [load-test guide](load/README.md) for prerequisites, commands, scenario controls, stored summaries, and operational checks. The JSON summaries do not capture `docker stats`; record resource utilization separately when reproducing a benchmark.

## Known limitations and trade-offs

- Attribute filters other than `request_id` are not indexed and can scan all rows in the selected time partitions.
- Message substring search uses `ILIKE` without a trigram index to protect ingestion throughput; broad or unbounded searches can be expensive.
- Attribute- and message-filtered aggregation computes counts from raw logs and can be expensive over broad ranges.
- The deployment is a single application container and a single PostgreSQL instance, with no replication or horizontal sharding.
- Retention works at UTC-day granularity, so effective retention can exceed the configured duration by less than one day.
- Authentication, tenancy, rate limiting, compression, metrics export, and dashboards are not implemented.
- The saved passing mixed-workload result is approximately 75 seconds from an empty database. A passing two-minute run starting from one million rows has not been captured.

## Repository layout

```text
src/           application, ingestion, query, aggregation, and retention code
migrations/    startup-applied SQL migrations
test/unit/     isolated behavior and SQL-builder tests
test/integration/ PostgreSQL/Testcontainers API and retention tests
load/          k6 workloads, SQL setup helpers, and saved result summaries
scripts/       endpoint EXPLAIN ANALYZE queries
docs/          project requirements and design plan
```

## License

MIT, as declared in `package.json`.
