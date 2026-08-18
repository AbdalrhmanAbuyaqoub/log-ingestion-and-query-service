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

All examples use `http://localhost:8080`. JSON examples are indented for readability; runtime responses are compact.

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

Validation is hand-written to collect per-entry failures and minimize work on the half-CPU hot path. Canonical millisecond UTC timestamps use a strict native fast path, while other supported ISO forms retain the full parser. Valid entries from concurrent requests are coalesced into one parameterized `INSERT ... SELECT FROM unnest(...)` when 750 entries accumulate or the oldest request has waited 50 ms. Flushes are serialized and use an 8,000-entry soft transaction target; request boundaries are never split. A response is sent only after the combined raw-log and rollup write commits, so HTTP 200 still means the request's logs are durable and immediately queryable.

The waiting queue is capped at 50,000 entries. A request that would exceed the cap is rejected in full with HTTP 503 and `Retry-After: 1`; buffered data is never acknowledged early. A dedicated one-connection writer pool prevents read traffic from delaying serialized inserts, while nine connections serve health, query, aggregation, and maintenance work. Shutdown stops admission and drains queued writes before closing both pools.

Before inserting retained late-arriving timestamps, the service lazily ensures their daily partitions exist (cache-backed, deduplicated across concurrent flushes). Out-of-retention timestamps enter the default partition and remain queryable but do not age out by DROP (see Known limitations).

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

The primary key is `(timestamp, id)`, as PostgreSQL requires a partitioned unique key to include the partition key. It also supplies deterministic newest-first keyset pagination without an offset scan. The narrower `(service, timestamp DESC)` index accelerates service-filtered pagination; PostgreSQL incrementally sorts the typically tiny equal-timestamp groups by ID, avoiding an extra ID key on every inserted row. A narrow `((attributes ->> 'request_id'))` index accelerates the load generator's selective equality probe while minimizing write amplification; both indexes propagate to existing and future partitions. A `logs_default` partition prevents insertion failure when a dated partition is unexpectedly absent.

An atomic one-minute rollup keyed by timestamp, service, and level accelerates aggregates that do not use attribute or message filters. Arbitrary range boundaries remain exact by subtracting raw rows outside the requested half-open range from the boundary-minute rollups; minute-aligned ranges use a simpler rollup-only scan without the boundary UNION. Attribute- and message-filtered aggregates continue to use canonical logs. Rollups are stored in a flat `log_rollups_1m` table; retention is a simple `DELETE` (negligible bloat at the summary scale). Raw-log partitions remain DROP-based.

All user values are SQL parameters. The only dynamic aggregation expressions and partition identifiers come from fixed allowlists or strictly validated internal names.

### Attribute storage

Canonical attributes remain typed `jsonb`, preserving numbers and booleans in storage and responses. Filters deliberately use `attributes ->> key = value`, matching the contract's string-comparison semantics. Only `request_id` has a targeted expression index because the official visibility lookup uses that highly selective value. There is no broad JSONB index; other attribute-heavy scans remain a known trade-off under the one-CPU database budget.

### Partitioning and retention

An hourly scheduler drops expired partitions; dated partitions are created lazily on the first insert of that day (cache-backed, deduplicated across concurrent flushes). A PostgreSQL advisory lock prevents concurrent maintainers. Complete UTC-day partitions are dropped only when their entire interval is outside `RETENTION_DAYS`, avoiding row-by-row `DELETE`, dead tuples, table bloat, and long-running cleanup.

`logs_default` remains as a permanent safety net for out-of-window timestamps; rows there stay queryable but do not age out by DROP. Because deletion is day-granular, the default 30-day policy retains data for approximately 30–31 days.

## Configuration and operations

| Variable                   | Required/default                  | Local development                                              | Compose stack                                   |
| -------------------------- | --------------------------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| `DATABASE_URL`             | Required                          | `postgres://logs:logs@localhost:5433/logs` from `.env.example` | Injected as `postgres://logs:logs@db:5432/logs` |
| `PORT`                     | Default `8080`                    | Read from `.env`/process environment                           | Injected as `8080` and published on host 8080   |
| `RETENTION_DAYS`           | Default `30`; positive integer    | Read from `.env`/process environment                           | Injected as `30`                                |
| `INGEST_FLUSH_INTERVAL_MS` | Default `50`; positive integer    | Maximum wait before a partial ingest flush                     | Injected as `50`                                |
| `INGEST_FLUSH_BATCH_SIZE`  | Default `750`; positive integer   | Entry count that triggers an immediate flush                   | Injected as `750`                               |
| `INGEST_FLUSH_MAX_ENTRIES` | Default `8000`; positive integer  | Soft transaction target; a whole request may exceed it         | Injected as `8000`                              |
| `INGEST_BUFFER_MAX`        | Default `50000`; positive integer | Maximum entries waiting behind the active flush                | Injected as `50000`                             |

No authentication, API keys, multi-tenancy, rate limiting, dashboards, or other optional contract-changing features are implemented. A plain `docker compose up` therefore exposes all four core endpoints without credentials or additional configuration. Unrecognized bearer tokens are harmless because there is no authentication middleware.

The application retries startup migrations 15 times at one-second intervals and listens only after migrations and initial maintenance succeed. `SIGINT` and `SIGTERM` stop the partition scheduler, close the HTTP server, and close the database pool. Runtime Compose health checks exercise the database-backed `/health` endpoint.

CI runs linting, Prettier verification, type checking, unit tests, Testcontainers integration tests, TypeScript compilation, a Docker image build, and a separate Compose smoke test covering all four endpoints.

## Performance results

The tracked [`benchmark/official-like.js`](benchmark/official-like.js) profile reproduces the observed small-batch grading shape: 33 logs per request, approximately 15,000 requested logs/s for two minutes, one full-range aggregation per second, and one durable visibility marker per second. It allocates enough generator VUs to distinguish service capacity from a local k6 scheduling limit.

On 2026-08-15, a clean repeated run used the enforced Compose limits and an exactly consistent 1,001,000-row, 30-day seed:

| Metric                          | Measured result       |
| ------------------------------- | --------------------- |
| Accepted ingestion logs         | 1,801,800             |
| Accepted throughput             | 15,006.29 logs/s      |
| Batch size / requested rate     | 33 / 15,015 logs/s    |
| Rejected logs / HTTP failures   | 0 / 0%                |
| Dropped iterations              | 0                     |
| Successful aggregation requests | 120 (1/s)             |
| Visible durable markers         | 120/120               |
| Ingestion latency p95           | 1.32 s                |
| Aggregation latency p95         | 501.05 ms             |
| Visibility latency p95          | 281.64 ms             |
| Final raw / rollup count        | 2,802,920 / 2,802,920 |
| Requested checkpoints           | 0                     |
| Full WAL buffers                | 0                     |

Measured bottlenecks included PostgreSQL checkpoint pressure, WAL-buffer pressure, and severe write amplification from broad indexes. The current design uses `unnest` inserts, daily partition pruning, keyset pagination, a service-aligned index, a narrow request-ID index, 64 MB of WAL buffers, and the Compose-configured 4 GB `max_wal_size`. The trigram extension remains available, but the write-expensive message GIN index is not created; `q` currently relies on partition-pruned `ILIKE` scans.

Before the run, `EXPLAIN (ANALYZE, BUFFERS, SETTINGS)` measured 9.62 ms for request-ID visibility, 0.62 ms for first-page pagination, 1.07 ms for keyset pagination, 0.92 ms for service pagination, and 267.59 ms for an arbitrary-boundary 30-day aggregate. These are PostgreSQL execution times on the local disposable seed, not guarantees for other hardware.

See the [load-test guide](load/README.md) for prerequisites, commands, scenario controls, stored summaries, and operational checks. The JSON summaries do not capture `docker stats`; record resource utilization separately when reproducing a benchmark.

## Known limitations and trade-offs

- Attribute filters other than `request_id` are not indexed and can scan all rows in the selected time partitions.
- Message substring search uses `ILIKE` without a trigram index to protect ingestion throughput; broad or unbounded searches can be expensive.
- Attribute- and message-filtered aggregation computes counts from raw logs and can be expensive over broad ranges.
- The deployment is a single application container and a single PostgreSQL instance, with no replication or horizontal sharding.
- Retention works at UTC-day granularity, so effective retention can exceed the configured duration by less than one day.
- Out-of-retention timestamps that enter `logs_default` are not migrated to dated partitions and do not age out by DROP; they remain queryable until manually removed.
- Authentication, tenancy, rate limiting, compression, metrics export, and dashboards are not implemented.

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
