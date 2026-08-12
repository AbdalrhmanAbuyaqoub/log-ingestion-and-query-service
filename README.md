# Log Ingestion Service

High-throughput structured log ingestion and query service (PostgreSQL-backed).

## Run the development server

### Option A — Full stack in Docker (graded config)

```bash
docker compose up --build --wait
```

App on `http://localhost:8080`. Stop with `docker compose down -v`.

### Option B — Local Node with hot reload (npm run dev)

1. Start the database container (override publishes port 5433 to host):

   ```bash
   docker compose up -d db
   ```

2. Copy the env template (one-time):

   ```bash
   cp .env.example .env
   ```

3. Install deps and start the dev server:

   ```bash
   npm install
   npm run dev
   ```

App on `http://localhost:8080` with tsx watch hot reload. Stop with `Ctrl+C`, then `docker compose down -v`.

## Partitioning and retention

Logs are partitioned by their event timestamp into UTC daily PostgreSQL partitions. At startup the service creates today's partition and two days ahead, then performs maintenance hourly. Delayed logs that are still inside `RETENTION_DAYS` cause their daily partition to be created before insertion.

Retention defaults to 30 days and is implemented by dropping complete daily partitions. A partition is removed only after its entire UTC day is older than the cutoff, so effective retention is between 30 and 31 days. Logs already older than retention remain valid API input, briefly land in the default safety partition, and are removed during the next maintenance pass by rotating and dropping that partition; retention never uses row-by-row `DELETE`.

**Note:** Port 8080 is often occupied locally — if `docker compose up` fails on the port bind, use the workaround in `AGENTS.md` (`docker compose run -p 18080:8080 ...`).
