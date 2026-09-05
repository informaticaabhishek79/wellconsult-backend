"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../../middleware/authenticate");
const notifications_service_1 = require("./notifications.service");
const apiResponse_1 = require("../../utils/apiResponse");
const pagination_1 = require("../../utils/pagination");
const router = (0, express_1.Router)();
router.get('/', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const { page, limit } = (0, pagination_1.getPagination)(req);
        const data = await notifications_service_1.NotificationService.listForUser(req.user.sub, page, limit);
        (0, apiResponse_1.sendSuccess)(res, data.rows, 200, { page, limit, total: data.total });
    }
    catch (e) {
        next(e);
    }
});
router.patch('/:id/read', authenticate_1.authenticate, async (req, res, next) => {
    try {
        await notifications_service_1.NotificationService.markRead(req.params.id, req.user.sub);
        (0, apiResponse_1.sendSuccess)(res, { message: 'Marked as read.' });
    }
    catch (e) {
        next(e);
    }
});
router.patch('/read-all', authenticate_1.authenticate, async (req, res, next) => {
    try {
        await notifications_service_1.NotificationService.markAllRead(req.user.sub);
        (0, apiResponse_1.sendNoContent)(res);
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
//# sourceMappingURL=notifications.routes.js.map