"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../../middleware/authenticate");
const authorize_1 = require("../../middleware/authorize");
const database_1 = require("../../config/database");
const apiResponse_1 = require("../../utils/apiResponse");
const errorHandler_1 = require("../../middleware/errorHandler");
const questions_routes_1 = __importDefault(require("./questions.routes"));
const router = (0, express_1.Router)();
// Mount questions routes (without authenticate middleware at top level)
router.use('/questions', questions_routes_1.default);
router.use(authenticate_1.authenticate);
// GET /consultations/:id
router.get('/:id', async (req, res, next) => {
    try {
        const c = await (0, database_1.queryOne)(`SELECT c.*, u.full_name AS patient_name, du.full_name AS doctor_name
       FROM consultations c
       JOIN patients p ON p.id = c.patient_id
       JOIN users u ON u.id = p.user_id
       JOIN doctors d ON d.id = c.doctor_id
       JOIN users du ON du.id = d.user_id
       WHERE c.id=$1`, [req.params.id]);
        // Try appointment lookup if not found as consultation id
        if (!c) {
            const a = await (0, database_1.queryOne)(`SELECT a.id, a.doctor_id, a.patient_id, a.consult_type,
                a.appt_date, a.appt_time, a.status AS session_status,
                du.full_name AS doctor_name, pu.full_name AS patient_name
         FROM appointments a
         JOIN doctors d ON d.id = a.doctor_id
         JOIN users du ON du.id = d.user_id
         JOIN patients p ON p.id = a.patient_id
         JOIN users pu ON pu.id = p.user_id
         WHERE a.id=$1`, [req.params.id]);
            if (!a)
                throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Consultation not found.');
            (0, apiResponse_1.sendSuccess)(res, a);
            return;
        }
        (0, apiResponse_1.sendSuccess)(res, c);
    }
    catch (e) {
        next(e);
    }
});
// PUT /consultations/:id/notes (doctor only)
router.put('/:id/notes', (0, authorize_1.authorize)('doctor'), async (req, res, next) => {
    try {
        const { clinical_notes, diagnosis, follow_up_notes, follow_up_days } = req.body;
        // Find or create consultation from appointment
        let c = await (0, database_1.queryOne)('SELECT id FROM consultations WHERE appointment_id=$1', [req.params.id]);
        if (!c) {
            const appt = await (0, database_1.queryOne)('SELECT doctor_id, patient_id FROM appointments WHERE id=$1', [req.params.id]);
            if (!appt)
                throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Appointment not found.');
            const [newC] = await (0, database_1.query)(`INSERT INTO consultations (appointment_id, doctor_id, patient_id, session_status)
         VALUES ($1,$2,$3,'scheduled') RETURNING id`, [req.params.id, appt.doctor_id, appt.patient_id]);
            c = newC;
        }
        await (0, database_1.query)(`UPDATE consultations SET clinical_notes=$1, diagnosis=$2,
       follow_up_notes=$3, follow_up_days=$4 WHERE id=$5`, [clinical_notes, diagnosis, follow_up_notes, follow_up_days, c.id]);
        (0, apiResponse_1.sendSuccess)(res, { message: 'Notes saved.' });
    }
    catch (e) {
        next(e);
    }
});
// GET /consultations/:id/session-token
router.get('/:id/session-token', async (req, res, next) => {
    try {
        (0, apiResponse_1.sendSuccess)(res, {
            provider: 'daily.co',
            room_url: `https://deemona-doctors.daily.co/session-${req.params.id}`,
            token: `dev_token_${Date.now()}`,
            expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
//# sourceMappingURL=consultations.routes.js.map