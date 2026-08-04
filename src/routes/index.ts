import type { Express } from 'express';
import { createHealthRouter } from './health.js';
import { createLogsRouter } from './logs.js';

/**
 * Mounts all route routers onto the Express app. Per the node-postgres
 * "Express with Async/Await" guide, route mounting is centralized here so
 * `app.ts` stays focused on middleware wiring and app-level concerns.
 */
export function mountRoutes(app: Express): void {
  app.use(createHealthRouter());
  app.use(createLogsRouter());
}
