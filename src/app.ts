import express from 'express';
import type pg from 'pg';
import type { Config } from './config.js';
import { createHealthRouter } from './routes/health.js';
import { createLogsRouter } from './routes/logs.js';
import { errorMiddleware } from './middleware/error-handler.js';
import { notFoundMiddleware } from './middleware/not-found.js';
import { middlewareLogResponses } from './middleware/middlwareLogResponses.js';

export type ServerDeps = {
  pool: pg.Pool;
  config: Config;
};

/**
 * Builds the Express app without listening. Routers are mounted under their
 * path prefixes, the 404 catch-all is mounted after routes, and the error
 * middleware is mounted last (Express error middleware arity-4 + ordering rule).
 */
export function buildApp(deps: ServerDeps): express.Express {
  const app = express();

  app.use(middlewareLogResponses);

  // Batches of up to ~1000 entries must fit; Express's default is 1MB.
  app.use(express.json({ limit: '10mb' }));

  app.use(createHealthRouter(deps.pool));
  app.use(createLogsRouter(deps.pool));

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}
