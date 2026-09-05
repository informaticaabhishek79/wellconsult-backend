import { Response } from 'express';
interface Meta {
    page?: number;
    limit?: number;
    total?: number;
}
export declare const sendSuccess: (res: Response, data: unknown, statusCode?: number, meta?: Meta) => Response;
export declare const sendError: (res: Response, statusCode: number, code: string, message: string, details?: unknown) => Response;
export declare const sendCreated: (res: Response, data: unknown) => Response;
export declare const sendNoContent: (res: Response) => Response;
export {};
