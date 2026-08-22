import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError } from 'zod';
import { sendError } from '../utils/apiResponse';

/**
 * Zod schema validation middleware.
 * Usage: router.post('/register', validate(registerSchema), handler)
 */
export function validate(schema: AnyZodObject) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await schema.parseAsync({
        body:   req.body,
        query:  req.query,
        params: req.params,
      });
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const details = err.errors.map((e) => ({
          field:   e.path.slice(1).join('.'),
          message: e.message,
        }));
        sendError(res, 400, 'VALIDATION_ERROR', 'Request validation failed.', details);
        return;
      }
      next(err);
    }
  };
}
