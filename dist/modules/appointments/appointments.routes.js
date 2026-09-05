"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../../middleware/authenticate");
const authorize_1 = require("../../middleware/authorize");
const appointments_service_1 = require("./appointments.service");
const apiResponse_1 = require("../../utils/apiResponse");
const database_1 = require("../../config/database");
const errorHandler_1 = require("../../middleware/errorHandler");
const router = (0, express_1.Router)();
router.post('/', authenticate_1.authenticate, (0, authorize_1.authorize)('patient'), async (req, res, next) => {
    try {
        const [patient] = await (0, database_1.query)('SELECT id FROM patients WHERE user_id=$1', [req.user.sub]);
        if (!patient)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Patient profile not found.');
        const data = await appointments_service_1.AppointmentsService.book(patient.id, req.body);
        (0, apiResponse_1.sendCreated)(res, data);
    }
    catch (e) {
        next(e);
    }
});
router.get('/:id', authenticate_1.authenticate, async (req, res, next) => {
    try {
        (0, apiResponse_1.sendSuccess)(res, await appointments_service_1.AppointmentsService.getById(req.params.id));
    }
    catch (e) {
        next(e);
    }
});
router.patch('/:id/cancel', authenticate_1.authenticate, async (req, res, next) => {
    try {
        (0, apiResponse_1.sendSuccess)(res, await appointments_service_1.AppointmentsService.cancel(req.params.id, req.body.reason));
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
//# sourceMappingURL=appointments.routes.js.map