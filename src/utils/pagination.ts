import { Request } from 'express';

export interface PaginationParams { page: number; limit: number; offset: number }

export function getPagination(req: Request): PaginationParams {
  const page  = Math.max(1, parseInt(req.query.page  as string || '1',  10));
  const limit = Math.min(50, parseInt(req.query.limit as string || '20', 10));
  return { page, limit, offset: (page - 1) * limit };
}
