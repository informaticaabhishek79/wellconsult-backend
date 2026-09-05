"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadLimiter = exports.otpLimiter = exports.authLimiter = exports.apiLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const env_1 = require("../config/env");
const apiResponse_1 = require("../utils/apiResponse");
const handler = (_req, res) => (0, apiResponse_1.sendError)(res, 429, 'TOO_MANY_REQUESTS', 'Too many requests. Please try again later.');
/** General API rate limiter — 100 req / 15 min per IP */
exports.apiLimiter = (0, express_rate_limit_1.default)({
    windowMs: env_1.env.rateLimit.windowMs,
    max: env_1.env.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler,
});
/** Auth endpoints — stricter: 10 req / 15 min */
exports.authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler,
    keyGenerator: (req) => req.body?.email || req.ip || 'unknown',
});
/** OTP send — 5 req / 10 min */
exports.otpLimiter = (0, express_rate_limit_1.default)({
    windowMs: 10 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler,
});
/** File upload — 20 req / hour */
exports.uploadLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler,
});
//# sourceMappingURL=rateLimiter.js.map