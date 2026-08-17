import express from 'express';
import { mountRoutes } from './routes/index.js';
import { errorMiddleware } from './middleware/error-handler.js';
import { notFoundMiddleware } from './middleware/not-found.js';

/**
 * Builds the Express app without listening. Routers are mounted by
 * `mountRoutes`, the 404 catch-all is mounted after routes, and the error
 * middleware is mounted last (Express error middleware arity-4 + ordering
 * rule). Database access is handled by the singleton `src/db/index.ts`
 * module — no pool is threaded in.
 */
export function buildApp(): express.Express {
  const app = express();

  // Batches of up to ~1000 entries must fit; Express's default is 1MB.
  app.use(express.json({ limit: '10mb' }));

  mountRoutes(app);

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}
