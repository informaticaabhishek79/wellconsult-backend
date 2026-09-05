"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../../middleware/authenticate");
const authorize_1 = require("../../middleware/authorize");
const database_1 = require("../../config/database");
const apiResponse_1 = require("../../utils/apiResponse");
const errorHandler_1 = require("../../middleware/errorHandler");
const router = (0, express_1.Router)();
// Patient submits a question
router.post('/', authenticate_1.authenticate, (0, authorize_1.authorize)('patient'), async (req, res, next) => {
    try {
        const { specialty, question, patient_age, patient_gender } = req.body;
        if (!specialty || !question)
            throw new errorHandler_1.AppError(400, 'MISSING_FIELDS', 'Specialty and question are required.');
        if (question.length < 20)
            throw new errorHandler_1.AppError(400, 'TOO_SHORT', 'Please provide more details (minimum 20 characters).');
        const [patient] = await (0, database_1.query)('SELECT id FROM patients WHERE user_id=$1', [req.user.sub]);
        if (!patient)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Patient profile not found.');
        const [q] = await (0, database_1.query)(`INSERT INTO doctor_questions (patient_id, specialty, question, patient_age, patient_gender, status)
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`, [patient.id, specialty, question, patient_age || null, patient_gender || null]);
        (0, apiResponse_1.sendCreated)(res, q);
    }
    catch (e) {
        next(e);
    }
});
// Patient gets their questions
router.get('/', authenticate_1.authenticate, (0, authorize_1.authorize)('patient'), async (req, res, next) => {
    try {
        const [patient] = await (0, database_1.query)('SELECT id FROM patients WHERE user_id=$1', [req.user.sub]);
        if (!patient) {
            (0, apiResponse_1.sendSuccess)(res, []);
            return;
        }
        const questions = await (0, database_1.query)(`SELECT dq.*, u.full_name AS doctor_name
       FROM doctor_questions dq
       LEFT JOIN doctors d ON d.id = dq.doctor_id
       LEFT JOIN users u ON u.id = d.user_id
       WHERE dq.patient_id = $1
       ORDER BY dq.created_at DESC`, [patient.id]);
        (0, apiResponse_1.sendSuccess)(res, questions);
    }
    catch (e) {
        next(e);
    }
});
// Doctor gets pending questions for their specialty
router.get('/pending', authenticate_1.authenticate, (0, authorize_1.authorize)('doctor'), async (req, res, next) => {
    try {
        const [doctor] = await (0, database_1.query)('SELECT id, medical_system FROM doctors WHERE id=$1', [req.user.doctorId]);
        const questions = await (0, database_1.query)(`SELECT dq.*, u.full_name AS patient_name
       FROM doctor_questions dq
       JOIN patients p ON p.id = dq.patient_id
       JOIN users u ON u.id = p.user_id
       WHERE dq.specialty = $1 AND dq.status = 'pending'
       ORDER BY dq.created_at ASC
       LIMIT 20`, [doctor?.medical_system || 'allopathy']);
        (0, apiResponse_1.sendSuccess)(res, questions);
    }
    catch (e) {
        next(e);
    }
});
// Doctor answers a question
router.patch('/:id/answer', authenticate_1.authenticate, (0, authorize_1.authorize)('doctor'), async (req, res, next) => {
    try {
        const { answer } = req.body;
        if (!answer || answer.trim().length < 10)
            throw new errorHandler_1.AppError(400, 'TOO_SHORT', 'Please provide a detailed answer.');
        const q = await (0, database_1.queryOne)('SELECT * FROM doctor_questions WHERE id=$1', [req.params.id]);
        if (!q)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Question not found.');
        if (q.status !== 'pending')
            throw new errorHandler_1.AppError(422, 'ALREADY_ANSWERED', 'This question has already been answered.');
        const [updated] = await (0, database_1.query)(`UPDATE doctor_questions SET answer=$1, doctor_id=$2, status='answered', answered_at=NOW()
       WHERE id=$3 RETURNING *`, [answer.trim(), req.user.doctorId, req.params.id]);
        (0, apiResponse_1.sendSuccess)(res, updated);
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
//# sourceMappingURL=questions.routes.js.map