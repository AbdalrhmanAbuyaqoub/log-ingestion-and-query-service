import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

/**
 * Reports 200 only when the database answers. The process starts listening
 * after migrations have been applied, so a 200 implies: DB reachable,
 * schema migrated, service ready to accept traffic.
 */
export function registerHealthRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get('/health', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return reply.code(200).send({ status: 'ok' });
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
}
