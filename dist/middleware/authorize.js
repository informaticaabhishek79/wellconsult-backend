"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorize = authorize;
exports.ownsResource = ownsResource;
const apiResponse_1 = require("../utils/apiResponse");
/**
 * Role guard — pass one or more roles that are allowed.
 * Usage: router.get('/admin/stats', authenticate, authorize('admin'), handler)
 */
function authorize(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            (0, apiResponse_1.sendError)(res, 401, 'NOT_AUTHENTICATED', 'You must be logged in.');
            return;
        }
        if (!roles.includes(req.user.role)) {
            (0, apiResponse_1.sendError)(res, 403, 'FORBIDDEN', `This action requires one of these roles: ${roles.join(', ')}.`);
            return;
        }
        next();
    };
}
/**
 * Resource ownership guard — patient can only touch their own records.
 * Pass the request param that holds the patient/doctor id.
 */
function ownsResource(paramKey, userField) {
    return (req, res, next) => {
        const resourceId = req.params[paramKey];
        const userId = req.user?.[userField];
        if (req.user?.role === 'admin') {
            next();
            return;
        } // admins bypass
        if (!userId || userId !== resourceId) {
            (0, apiResponse_1.sendError)(res, 403, 'FORBIDDEN', 'You do not have access to this resource.');
            return;
        }
        next();
    };
}
//# sourceMappingURL=authorize.js.map