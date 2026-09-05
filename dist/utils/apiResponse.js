"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendNoContent = exports.sendCreated = exports.sendError = exports.sendSuccess = void 0;
const sendSuccess = (res, data, statusCode = 200, meta) => res.status(statusCode).json({ success: true, data, ...(meta ? { meta } : {}) });
exports.sendSuccess = sendSuccess;
const sendError = (res, statusCode, code, message, details) => res.status(statusCode).json({ success: false, error: { code, message, ...(details ? { details } : {}) } });
exports.sendError = sendError;
const sendCreated = (res, data) => (0, exports.sendSuccess)(res, data, 201);
exports.sendCreated = sendCreated;
const sendNoContent = (res) => res.status(204).send();
exports.sendNoContent = sendNoContent;
//# sourceMappingURL=apiResponse.js.map