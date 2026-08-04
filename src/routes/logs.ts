import { Router } from 'express';
import { validateBatch } from '../ingestion/validate.js';
import { ValidationError } from '../ingestion/errors.js';
import { insertLogs } from '../ingestion/insert.js';

/**
 * Wires the /logs routes. Reserved for both POST /logs (ingestion) and
 * GET /logs (query); only the ingestion route is mounted in this round.
 * Express 5 auto-forwards rejected promises from async handlers to the
 * error middleware.
 */
export function createLogsRouter(): Router {
  const router = Router();

  router.post('/logs', async (req, res) => {
    const { valid, rejected } = validateBatch(req.body);
    if (valid.length === 0) {
      throw new ValidationError('all entries rejected');
    }
    const accepted = await insertLogs(valid);
    res.status(200).json({ accepted, rejected });
  });

  return router;
}
