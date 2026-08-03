import type { RequestHandler } from 'express';

/**
 * Catch-all for unknown routes. Express's default 404 response is an HTML body;
 * this returns the API-contract shape `{ "error": "not found" }` instead.
 * Mounted after routers, before the error middleware.
 */
export const notFoundMiddleware: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'not found' });
};
