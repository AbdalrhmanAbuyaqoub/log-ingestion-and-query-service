import { Router } from 'express';
import type pg from 'pg';
import { validateBatch } from '../ingestion/validate.js';
import { ValidationError } from '../ingestion/errors.js';
import { insertLogs } from '../ingestion/insert.js';

/**
 * Wires the /logs routes. The pool is threaded in (DI) so tests can pass a
 * mock. Reserved for both POST /logs (ingestion) and GET /logs (query); only
 * the ingestion route is mounted in this round. Express 5 auto-forwards
 * rejected promises from async handlers to the error middleware.
 */
export function createLogsRouter(pool: pg.Pool): Router {
  const router = Router();

  router.post('/logs', async (req, res) => {
    const { valid, rejected } = validateBatch(req.body);
    if (valid.length === 0) {
      throw new ValidationError('all entries rejected');
    }
    const accepted = await insertLogs(pool, valid);
    res.status(200).json({ accepted, rejected });
  });

  return router;
}
