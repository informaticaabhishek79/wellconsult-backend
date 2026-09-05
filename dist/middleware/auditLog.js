"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditLog = auditLog;
const database_1 = require("../config/database");
const logger_1 = require("../utils/logger");
// Sensitive endpoints that need audit logging
const SENSITIVE_PATHS = [
    '/patients',
    '/prescriptions',
    '/medical-history',
    '/consultations',
    '/video',
];
function auditLog(req, res, next) {
    const isSensitive = SENSITIVE_PATHS.some(p => req.path.includes(p));
    if (!isSensitive || !req.user)
        return next();
    const originalSend = res.json.bind(res);
    res.json = (body) => {
        // Log async - don't block response
        setImmediate(async () => {
            try {
                await (0, database_1.query)(`INSERT INTO audit_logs (user_id, action, resource, ip_address, user_agent, status_code)
           VALUES ($1, $2, $3, $4, $5, $6)`, [
                    req.user.sub,
                    `${req.method} ${req.path}`,
                    req.params.patientId || req.params.appointmentId || 'self',
                    req.ip || req.headers['x-forwarded-for'] || 'unknown',
                    req.headers['user-agent'] || 'unknown',
                    res.statusCode,
                ]);
            }
            catch (err) {
                logger_1.logger.warn('Audit log failed', { error: err.message });
            }
        });
        return originalSend(body);
    };
    next();
}
//# sourceMappingURL=auditLog.js.map