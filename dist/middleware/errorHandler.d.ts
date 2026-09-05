import { Request, Response, NextFunction } from 'express';
export declare class AppError extends Error {
    statusCode: number;
    code: string;
    details?: unknown | undefined;
    constructor(statusCode: number, code: string, message: string, details?: unknown | undefined);
}
export declare function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void;
export declare function notFound(_req: Request, res: Response): void;
