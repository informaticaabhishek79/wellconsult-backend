"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestLogger = requestLogger;
const logger_1 = require("../utils/logger");
function requestLogger(req, res, next) {
    const start = Date.now();
    res.on('finish', () => {
        logger_1.logger.info('HTTP', {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            duration: `${Date.now() - start}ms`,
            ip: req.ip,
            userId: req.user?.sub,
        });
    });
    next();
}
//# sourceMappingURL=requestLogger.js.map