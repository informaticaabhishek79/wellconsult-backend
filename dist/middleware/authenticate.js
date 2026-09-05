"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticate = authenticate;
const jwt_1 = require("../utils/jwt");
const apiResponse_1 = require("../utils/apiResponse");
const redis_1 = require("../config/redis");
async function authenticate(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
        (0, apiResponse_1.sendError)(res, 401, 'MISSING_TOKEN', 'Authorization token is required.');
        return;
    }
    const token = header.slice(7);
    try {
        const payload = (0, jwt_1.verifyAccessToken)(token);
        // Check token blacklist (set on logout)
        const blacklisted = await redis_1.redis.get(`blacklist:${token}`);
        if (blacklisted) {
            (0, apiResponse_1.sendError)(res, 401, 'TOKEN_REVOKED', 'Token has been revoked. Please log in again.');
            return;
        }
        req.user = payload;
        next();
    }
    catch {
        (0, apiResponse_1.sendError)(res, 401, 'INVALID_TOKEN', 'Token is invalid or expired.');
    }
}
//# sourceMappingURL=authenticate.js.map