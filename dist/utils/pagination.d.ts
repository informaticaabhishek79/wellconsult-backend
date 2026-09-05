import { Request } from 'express';
export interface PaginationParams {
    page: number;
    limit: number;
    offset: number;
}
export declare function getPagination(req: Request): PaginationParams;
