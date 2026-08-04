import type { Request, Response, NextFunction } from 'express';

export async function middlewareLogResponses(req: Request, res: Response, next: NextFunction) {
  res.on('finish', () => {
    let status = 'NOT-OK';
    if (res.statusCode >= 200 && res.statusCode < 300) {
      status = 'OK';
    }
    console.log(`[${status}] ${req.method} ${req.url} - Status: ${res.statusCode}`);
  });
  next();
}
