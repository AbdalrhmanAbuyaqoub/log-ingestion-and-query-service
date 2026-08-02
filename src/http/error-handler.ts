import type { FastifyError, FastifyInstance } from 'fastify';

/**
 * Maps framework errors (e.g. malformed JSON bodies, statusCode 400) to the
 * API contract's error shape: { "error": "<description>" }.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: error.message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'internal server error' });
  });
}
