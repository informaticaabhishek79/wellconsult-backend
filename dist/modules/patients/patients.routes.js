"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../../middleware/authenticate");
const authorize_1 = require("../../middleware/authorize");
const database_1 = require("../../config/database");
const apiResponse_1 = require("../../utils/apiResponse");
const errorHandler_1 = require("../../middleware/errorHandler");
const router = (0, express_1.Router)();
// GET patient's own appointments
router.get('/me/appointments', authenticate_1.authenticate, (0, authorize_1.authorize)('patient'), async (req, res, next) => {
    try {
        const [patient] = await (0, database_1.query)('SELECT id FROM patients WHERE user_id=$1', [req.user.sub]);
        if (!patient) {
            (0, apiResponse_1.sendSuccess)(res, []);
            return;
        }
        const appts = await (0, database_1.query)(`SELECT a.id, a.appt_date, a.appt_time, a.consult_type, a.status,
              d.medical_system, d.specialization,
              u.full_name AS doctor_name
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN users u ON u.id = d.user_id
       WHERE a.patient_id = $1
       ORDER BY a.appt_date DESC, a.appt_time DESC`, [patient.id]);
        (0, apiResponse_1.sendSuccess)(res, appts);
    }
    catch (e) {
        next(e);
    }
});
// GET patient's medical history
router.get('/me/history', authenticate_1.authenticate, (0, authorize_1.authorize)('patient'), async (req, res, next) => {
    try {
        const [patient] = await (0, database_1.query)('SELECT id FROM patients WHERE user_id=$1', [req.user.sub]);
        if (!patient) {
            (0, apiResponse_1.sendSuccess)(res, null);
            return;
        }
        const history = await (0, database_1.queryOne)('SELECT * FROM patient_medical_history WHERE patient_id=$1', [patient.id]);
        (0, apiResponse_1.sendSuccess)(res, history || null);
    }
    catch (e) {
        next(e);
    }
});
// PUT patient's medical history
router.put('/me/history', authenticate_1.authenticate, (0, authorize_1.authorize)('patient'), async (req, res, next) => {
    try {
        const [patient] = await (0, database_1.query)('SELECT id FROM patients WHERE user_id=$1', [req.user.sub]);
        if (!patient)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Patient not found.');
        const { blood_group, height_cm, weight_kg, chronic_conditions, allergies, current_medications, past_surgeries, family_history, smoking, alcohol, emergency_contact_name, emergency_contact_phone, } = req.body;
        const existing = await (0, database_1.queryOne)('SELECT id FROM patient_medical_history WHERE patient_id=$1', [patient.id]);
        if (existing) {
            await (0, database_1.query)(`UPDATE patient_medical_history SET
           blood_group=$1, height_cm=$2, weight_kg=$3,
           chronic_conditions=$4, allergies=$5,
           current_medications=$6, past_surgeries=$7, family_history=$8,
           smoking=$9, alcohol=$10,
           emergency_contact_name=$11, emergency_contact_phone=$12,
           updated_at=NOW()
         WHERE patient_id=$13`, [blood_group, height_cm || null, weight_kg || null,
                JSON.stringify(chronic_conditions || []), JSON.stringify(allergies || []),
                current_medications, past_surgeries, family_history,
                smoking, alcohol,
                emergency_contact_name, emergency_contact_phone, patient.id]);
        }
        else {
            await (0, database_1.query)(`INSERT INTO patient_medical_history
           (patient_id, blood_group, height_cm, weight_kg, chronic_conditions, allergies,
            current_medications, past_surgeries, family_history, smoking, alcohol,
            emergency_contact_name, emergency_contact_phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [patient.id, blood_group, height_cm || null, weight_kg || null,
                JSON.stringify(chronic_conditions || []), JSON.stringify(allergies || []),
                current_medications, past_surgeries, family_history,
                smoking, alcohol,
                emergency_contact_name, emergency_contact_phone]);
        }
        const history = await (0, database_1.queryOne)('SELECT * FROM patient_medical_history WHERE patient_id=$1', [patient.id]);
        (0, apiResponse_1.sendSuccess)(res, history);
    }
    catch (e) {
        next(e);
    }
});
// Doctor views patient history (only if they have/had an appointment together)
router.get('/:patientId/history', authenticate_1.authenticate, (0, authorize_1.authorize)('doctor'), async (req, res, next) => {
    try {
        // Verify doctor has appointment with this patient
        const [appt] = await (0, database_1.query)(`SELECT a.id FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       WHERE a.doctor_id=$1 AND p.id=$2 LIMIT 1`, [req.user.doctorId, req.params.patientId]);
        if (!appt)
            throw new errorHandler_1.AppError(403, 'FORBIDDEN', 'You do not have access to this patient\'s history.');
        const history = await (0, database_1.queryOne)('SELECT * FROM patient_medical_history WHERE patient_id=$1', [req.params.patientId]);
        const patient = await (0, database_1.queryOne)(`SELECT u.full_name, u.email FROM patients p JOIN users u ON u.id=p.user_id WHERE p.id=$1`, [req.params.patientId]);
        (0, apiResponse_1.sendSuccess)(res, { ...history, patient_name: patient?.full_name });
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
//# sourceMappingURL=patients.routes.js.map