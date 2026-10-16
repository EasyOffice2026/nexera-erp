import { apiError } from '@nexera/shared';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../lib/http-errors';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json(apiError('NOT_FOUND', 'Route not found'));
};

// Errors from the JSON body parser carry a "type" and a status of their own.
function bodyParserError(err: unknown): { status: number; type: string } | null {
  if (typeof err !== 'object' || err === null) return null;
  const { type, status } = err as { type?: unknown; status?: unknown };
  return typeof type === 'string' && typeof status === 'number' ? { type, status } : null;
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof AppError) {
    if (err.headers) res.set(err.headers);
    res.status(err.status).json(apiError(err.code, err.message, err.details));
    return;
  }

  const parserError = bodyParserError(err);
  if (parserError?.type === 'entity.parse.failed') {
    res.status(400).json(apiError('INVALID_JSON', 'The request body is not valid JSON'));
    return;
  }
  if (parserError?.type === 'entity.too.large') {
    res.status(413).json(apiError('PAYLOAD_TOO_LARGE', 'The request body is too large'));
    return;
  }

  console.error(`Request ${String(res.locals.requestId ?? '-')} failed:`, err);
  res.status(500).json(apiError('INTERNAL_ERROR', 'Something went wrong'));
};
