"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppError = void 0;
exports.errorHandler = errorHandler;
exports.notFound = notFound;
const logger_1 = require("../utils/logger");
const apiResponse_1 = require("../utils/apiResponse");
const env_1 = require("../config/env");
class AppError extends Error {
    constructor(statusCode, code, message, details) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        this.name = 'AppError';
        Error.captureStackTrace(this, this.constructor);
    }
}
exports.AppError = AppError;
function errorHandler(err, _req, res, _next) {
    if (err instanceof AppError) {
        (0, apiResponse_1.sendError)(res, err.statusCode, err.code, err.message, err.details);
        return;
    }
    // Postgres unique violation
    if (err.code === '23505') {
        (0, apiResponse_1.sendError)(res, 409, 'DUPLICATE_ENTRY', 'A record with this value already exists.');
        return;
    }
    logger_1.logger.error('Unhandled error', {
        message: err.message,
        stack: env_1.env.NODE_ENV === 'development' ? err.stack : undefined,
    });
    (0, apiResponse_1.sendError)(res, 500, 'INTERNAL_ERROR', env_1.env.NODE_ENV === 'production'
        ? 'Something went wrong. Please try again.'
        : err.message);
}
function notFound(_req, res) {
    (0, apiResponse_1.sendError)(res, 404, 'NOT_FOUND', 'The requested endpoint does not exist.');
}
//# sourceMappingURL=errorHandler.js.map