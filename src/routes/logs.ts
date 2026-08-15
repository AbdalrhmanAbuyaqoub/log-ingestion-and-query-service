import { Router } from 'express';
import { validateBatch } from '../ingestion/validate.js';
import { getIngestionCoordinator } from '../ingestion/coordinator.js';
import { parseLogsQuery } from '../query/parse.js';
import { queryLogs } from '../query/index.js';
import { parseAggregateQuery } from '../aggregation/parse.js';
import { aggregateLogs } from '../aggregation/index.js';

export function createLogsRouter(): Router {
  const router = Router();

  router.post('/logs', async (req, res) => {
    const { valid, rejected } = validateBatch(req.body);
    if (valid.length === 0) {
      res.status(400).json({ accepted: 0, rejected });
      return;
    }
    const accepted = await getIngestionCoordinator().enqueue(valid);
    res.status(200).json({ accepted, rejected });
  });

  router.get('/logs', async (req, res) => {
    const log = parseLogsQuery(req.query);
    const { logs, next_cursor } = await queryLogs(log);
    res.status(200).json({ logs, next_cursor });
  });

  router.get('/logs/aggregate', async (req, res) => {
    const aggregate = parseAggregateQuery(req.query);
    const result = await aggregateLogs(aggregate);
    res.status(200).json(result);
  });

  return router;
}
