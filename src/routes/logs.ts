import { Router } from 'express';
import { validateBatch } from '../ingestion/validate.js';
import { ValidationError } from '../ingestion/errors.js';
import { insertLogs } from '../ingestion/insert.js';
import { parseLogsQuery } from '../query/parse.js';
import { queryLogs } from '../query/index.js';

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

  router.get('/logs', async (req, res) => {
    const log = parseLogsQuery(req.query);
    const { logs, next_cursor } = await queryLogs(log);
    res.status(200).json({ logs, next_cursor });
  });

  return router;
}
