import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { sendError } from '../utils/apiResponse';
import { env } from '../config/env';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    sendError(res, err.statusCode, err.code, err.message, err.details);
    return;
  }

  // Postgres unique violation
  if ((err as NodeJS.ErrnoException).code === '23505') {
    sendError(res, 409, 'DUPLICATE_ENTRY', 'A record with this value already exists.');
    return;
  }

  logger.error('Unhandled error', {
    message: err.message,
    stack:   env.NODE_ENV === 'development' ? err.stack : undefined,
  });

  sendError(
    res, 500, 'INTERNAL_ERROR',
    env.NODE_ENV === 'production'
      ? 'Something went wrong. Please try again.'
      : err.message
  );
}

export function notFound(_req: Request, res: Response): void {
  sendError(res, 404, 'NOT_FOUND', 'The requested endpoint does not exist.');
}
