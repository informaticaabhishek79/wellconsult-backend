import { Response } from 'express';

interface Meta { page?: number; limit?: number; total?: number }

export const sendSuccess = (
  res: Response,
  data: unknown,
  statusCode = 200,
  meta?: Meta
): Response =>
  res.status(statusCode).json({ success: true, data, ...(meta ? { meta } : {}) });

export const sendError = (
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown
): Response =>
  res.status(statusCode).json({ success: false, error: { code, message, ...(details ? { details } : {}) } });

export const sendCreated = (res: Response, data: unknown): Response =>
  sendSuccess(res, data, 201);

export const sendNoContent = (res: Response): Response =>
  res.status(204).send();
