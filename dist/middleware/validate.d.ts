import { Request, Response, NextFunction } from 'express';
import { AnyZodObject } from 'zod';
/**
 * Zod schema validation middleware.
 * Usage: router.post('/register', validate(registerSchema), handler)
 */
export declare function validate(schema: AnyZodObject): (req: Request, res: Response, next: NextFunction) => Promise<void>;
