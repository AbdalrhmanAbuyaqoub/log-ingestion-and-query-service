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

**Note:** Port 8080 is often occupied locally — if `docker compose up` fails on the port bind, use the workaround in `AGENTS.md` (`docker compose run -p 18080:8080 ...`).
