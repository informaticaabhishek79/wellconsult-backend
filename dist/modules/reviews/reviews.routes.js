"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../../middleware/authenticate");
const authorize_1 = require("../../middleware/authorize");
const database_1 = require("../../config/database");
const apiResponse_1 = require("../../utils/apiResponse");
const errorHandler_1 = require("../../middleware/errorHandler");
const router = (0, express_1.Router)();
// Patient submits a review after completed appointment
router.post('/', authenticate_1.authenticate, (0, authorize_1.authorize)('patient'), async (req, res, next) => {
    try {
        const { appointment_id, rating, review_text } = req.body;
        if (!appointment_id || !rating)
            throw new errorHandler_1.AppError(400, 'MISSING_FIELDS', 'appointment_id and rating are required.');
        if (rating < 1 || rating > 5)
            throw new errorHandler_1.AppError(400, 'INVALID_RATING', 'Rating must be between 1 and 5.');
        const [patient] = await (0, database_1.query)('SELECT id FROM patients WHERE user_id=$1', [req.user.sub]);
        if (!patient)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Patient not found.');
        // Verify appointment belongs to patient and is completed
        const appt = await (0, database_1.queryOne)('SELECT id, doctor_id, status FROM appointments WHERE id=$1 AND patient_id=$2', [appointment_id, patient.id]);
        if (!appt)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Appointment not found.');
        if (appt.status !== 'completed')
            throw new errorHandler_1.AppError(422, 'NOT_COMPLETED', 'You can only review completed consultations.');
        // Check if already reviewed
        const existing = await (0, database_1.queryOne)('SELECT id FROM reviews WHERE appointment_id=$1', [appointment_id]);
        if (existing)
            throw new errorHandler_1.AppError(409, 'ALREADY_REVIEWED', 'You have already reviewed this consultation.');
        // Save review
        const [review] = await (0, database_1.query)(`INSERT INTO reviews (patient_id, doctor_id, appointment_id, rating, review_text)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`, [patient.id, appt.doctor_id, appointment_id, rating, review_text?.trim() || null]);
        // Update doctor avg_rating and total_reviews
        await (0, database_1.query)(`UPDATE doctors SET
         avg_rating = (SELECT AVG(rating) FROM reviews WHERE doctor_id=$1),
         total_reviews = (SELECT COUNT(*) FROM reviews WHERE doctor_id=$1)
       WHERE id=$1`, [appt.doctor_id]);
        (0, apiResponse_1.sendCreated)(res, review);
    }
    catch (e) {
        next(e);
    }
});
// Get reviews for a doctor
router.get('/doctor/:doctorId', async (req, res, next) => {
    try {
        const reviews = await (0, database_1.query)(`SELECT r.*, u.full_name AS patient_name
       FROM reviews r
       JOIN patients p ON p.id = r.patient_id
       JOIN users u ON u.id = p.user_id
       WHERE r.doctor_id = $1
       ORDER BY r.created_at DESC
       LIMIT 20`, [req.params.doctorId]);
        (0, apiResponse_1.sendSuccess)(res, reviews);
    }
    catch (e) {
        next(e);
    }
});
// Get patient's own reviews
router.get('/me', authenticate_1.authenticate, (0, authorize_1.authorize)('patient'), async (req, res, next) => {
    try {
        const [patient] = await (0, database_1.query)('SELECT id FROM patients WHERE user_id=$1', [req.user.sub]);
        if (!patient) {
            (0, apiResponse_1.sendSuccess)(res, []);
            return;
        }
        const reviews = await (0, database_1.query)(`SELECT r.*, u.full_name AS doctor_name
       FROM reviews r
       JOIN doctors d ON d.id = r.doctor_id
       JOIN users u ON u.id = d.user_id
       WHERE r.patient_id = $1
       ORDER BY r.created_at DESC`, [patient.id]);
        (0, apiResponse_1.sendSuccess)(res, reviews);
    }
    catch (e) {
        next(e);
    }
});
// Check if appointment is reviewed
router.get('/check/:appointmentId', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const review = await (0, database_1.queryOne)('SELECT id, rating FROM reviews WHERE appointment_id=$1', [req.params.appointmentId]);
        (0, apiResponse_1.sendSuccess)(res, { reviewed: !!review, review });
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
//# sourceMappingURL=reviews.routes.js.map