export class ValidationError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class IngestionUnavailableError extends Error {
  statusCode = 503;
  retryAfter = '1';

  constructor(message = 'ingestion temporarily unavailable') {
    super(message);
    this.name = 'IngestionUnavailableError';
  }
}
