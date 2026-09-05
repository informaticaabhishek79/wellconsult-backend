"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validate = validate;
const zod_1 = require("zod");
const apiResponse_1 = require("../utils/apiResponse");
/**
 * Zod schema validation middleware.
 * Usage: router.post('/register', validate(registerSchema), handler)
 */
function validate(schema) {
    return async (req, res, next) => {
        try {
            await schema.parseAsync({
                body: req.body,
                query: req.query,
                params: req.params,
            });
            next();
        }
        catch (err) {
            if (err instanceof zod_1.ZodError) {
                const details = err.errors.map((e) => ({
                    field: e.path.slice(1).join('.'),
                    message: e.message,
                }));
                (0, apiResponse_1.sendError)(res, 400, 'VALIDATION_ERROR', 'Request validation failed.', details);
                return;
            }
            next(err);
        }
    };
}
//# sourceMappingURL=validate.js.map