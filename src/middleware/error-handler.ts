import type { ErrorRequestHandler } from 'express';

/**
 * Maps framework errors (e.g. malformed JSON bodies, statusCode 400) to the
 * API contract's error shape: { "error": "<description>" }.
 *
 * Express error middleware: arity 4, registered last. Rejected promises from
 * async route handlers reach here automatically on Express 5.
 */

type ExpressJsonError = SyntaxError & { type?: string; statusCode?: number };
type HttpError = Error & { statusCode?: number; type?: string };

export const errorMiddleware: ErrorRequestHandler = (err: HttpError, _req, res, _next) => {
  // express.json() syntax errors carry a `type` of 'entity.parse.failed'.
  if (err instanceof SyntaxError && (err as ExpressJsonError).type === 'entity.parse.failed') {
    return res.status(400).json({ error: err.message });
  }
  // PayloadTooLargeError from express.json() when body exceeds the 10MB limit.
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload too large' });
  }

  const statusCode: number = err.statusCode ?? 500;
  if (statusCode >= 400 && statusCode < 500) {
    return res.status(statusCode).json({ error: err.message });
  }

  console.error(err);
  return res.status(500).json({ error: 'internal server error' });
};
