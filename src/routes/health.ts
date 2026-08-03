import { Router } from 'express';
import type pg from 'pg';

/**
 * Reports 200 only when the database answers. The process starts listening
 * after migrations have been applied, so a 200 implies: DB reachable,
 * schema migrated, service ready to accept traffic.
 */
export function createHealthRouter(pool: pg.Pool): Router {
  const router = Router();
  router.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      return res.status(200).json({ status: 'ok' });
    } catch {
      return res.status(503).json({ status: 'unavailable' });
    }
  });
  return router;
}
