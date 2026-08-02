import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Config } from '../config.js';
import { registerErrorHandler } from './error-handler.js';
import { registerHealthRoutes } from './routes/health.js';

export interface ServerDeps {
  pool: pg.Pool;
  config: Config;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: deps.config.LOG_LEVEL },
    // Batches of up to ~1000 entries must fit; Fastify's default is 1MB.
    bodyLimit: 10 * 1024 * 1024,
  });

  registerErrorHandler(app);
  registerHealthRoutes(app, deps.pool);

  return app;
}
