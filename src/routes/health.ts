import { Router } from 'express';
import { query } from '../db/index.js';

/**
 * Reports 200 only when the database answers. The process starts listening
 * after migrations have been applied, so a 200 implies: DB reachable,
 * schema migrated, service ready to accept traffic.
 */
export function createHealthRouter(): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    try {
      await query('SELECT 1');
      return res.status(200).json({ status: 'ok' });
    } catch {
      return res.status(503).json({ status: 'unavailable' });
    }
  });

  return router;
}
