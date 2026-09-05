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
const aws_sdk_1 = __importDefault(require("aws-sdk"));
const router = (0, express_1.Router)();
const r2 = new aws_sdk_1.default.S3({
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    region: 'auto',
    signatureVersion: 'v4',
});
const BUCKET = process.env.R2_BUCKET || 'onlineconsultation';
// Get presigned upload URL
router.post('/upload-url', authenticate_1.authenticate, (0, authorize_1.authorize)('patient'), async (req, res, next) => {
    try {
        const { test_name, category, file_name, content_type } = req.body;
        if (!test_name || !category || !file_name || !content_type) {
            throw new errorHandler_1.AppError(400, 'MISSING_FIELDS', 'All fields required.');
        }
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
        if (!allowed.includes(content_type)) {
            throw new errorHandler_1.AppError(400, 'INVALID_FORMAT', 'Only PDF, JPG, PNG and WebP allowed.');
        }
        const [patient] = await (0, database_1.query)('SELECT id FROM patients WHERE user_id=$1', [req.user.sub]);
        if (!patient)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Patient not found.');
        const safeFileName = file_name.replace(/[^a-zA-Z0-9.-]/g, '_');
        const key = `patient-records/${patient.id}/${category}/${Date.now()}-${safeFileName}`;
        const upload_url = r2.getSignedUrl('putObject', { Bucket: BUCKET, Key: key, ContentType: content_type, Expires: 300 });
        (0, apiResponse_1.sendSuccess)(res, { upload_url, key });
    }
    catch (e) {
        next(e);
    }
});
// Save record metadata
router.post('/', authenticate_1.authenticate, (0, authorize_1.authorize)('patient'), async (req, res, next) => {
    try {
        const { test_name, category, file_key, file_name, file_size, report_date, notes } = req.body;
        const [patient] = await (0, database_1.query)('SELECT id FROM patients WHERE user_id=$1', [req.user.sub]);
        if (!patient)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Patient not found.');
        const [record] = await (0, database_1.query)(`INSERT INTO patient_records (patient_id, test_name, category, file_key, file_name, file_size, report_date, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (patient_id, test_name) DO UPDATE
       SET file_key=$4, file_name=$5, file_size=$6, report_date=$7, notes=$8, updated_at=NOW()
       RETURNING *`, [patient.id, test_name, category, file_key, file_name, file_size || null, report_date || null, notes || null]);
        (0, apiResponse_1.sendCreated)(res, record);
    }
    catch (e) {
        next(e);
    }
});
// Get all records for patient
router.get('/', authenticate_1.authenticate, (0, authorize_1.authorize)('patient'), async (req, res, next) => {
    try {
        const [patient] = await (0, database_1.query)('SELECT id FROM patients WHERE user_id=$1', [req.user.sub]);
        if (!patient) {
            (0, apiResponse_1.sendSuccess)(res, []);
            return;
        }
        const records = await (0, database_1.query)('SELECT * FROM patient_records WHERE patient_id=$1 ORDER BY category, test_name', [patient.id]);
        (0, apiResponse_1.sendSuccess)(res, records);
    }
    catch (e) {
        next(e);
    }
});
// Get signed URL to view a record
router.get('/:id/view', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const record = await (0, database_1.queryOne)('SELECT * FROM patient_records WHERE id=$1', [req.params.id]);
        if (!record)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Record not found.');
        // Verify access - patient owns it or doctor has appointment with patient
        const [patient] = await (0, database_1.query)('SELECT user_id FROM patients WHERE id=$1', [record.patient_id]);
        const isOwner = patient?.user_id === req.user.sub;
        if (!isOwner) {
            const [appt] = await (0, database_1.query)(`SELECT a.id FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         WHERE a.doctor_id=$1 AND p.id=$2 LIMIT 1`, [req.user.doctorId, record.patient_id]);
            if (!appt)
                throw new errorHandler_1.AppError(403, 'FORBIDDEN', 'Access denied.');
        }
        const url = r2.getSignedUrl('getObject', { Bucket: BUCKET, Key: record.file_key, Expires: 300 });
        (0, apiResponse_1.sendSuccess)(res, { url });
    }
    catch (e) {
        next(e);
    }
});
// Delete a record
router.delete('/:id', authenticate_1.authenticate, (0, authorize_1.authorize)('patient'), async (req, res, next) => {
    try {
        const [patient] = await (0, database_1.query)('SELECT id FROM patients WHERE user_id=$1', [req.user.sub]);
        const record = await (0, database_1.queryOne)('SELECT * FROM patient_records WHERE id=$1 AND patient_id=$2', [req.params.id, patient?.id]);
        if (!record)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Record not found.');
        // Delete from R2
        await r2.deleteObject({ Bucket: BUCKET, Key: record.file_key }).promise().catch(() => { });
        await (0, database_1.query)('DELETE FROM patient_records WHERE id=$1', [req.params.id]);
        (0, apiResponse_1.sendSuccess)(res, { message: 'Record deleted.' });
    }
    catch (e) {
        next(e);
    }
});
// Doctor views patient records (with appointment check)
router.get('/patient/:patientId', authenticate_1.authenticate, (0, authorize_1.authorize)('doctor'), async (req, res, next) => {
    try {
        const [appt] = await (0, database_1.query)(`SELECT id FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       WHERE a.doctor_id=$1 AND p.id=$2 LIMIT 1`, [req.user.doctorId, req.params.patientId]);
        if (!appt)
            throw new errorHandler_1.AppError(403, 'FORBIDDEN', 'Access denied.');
        const records = await (0, database_1.query)('SELECT * FROM patient_records WHERE patient_id=$1 ORDER BY category, test_name', [req.params.patientId]);
        (0, apiResponse_1.sendSuccess)(res, records);
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
//# sourceMappingURL=records.routes.js.map