"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../../middleware/authenticate");
const authorize_1 = require("../../middleware/authorize");
const database_1 = require("../../config/database");
const apiResponse_1 = require("../../utils/apiResponse");
const errorHandler_1 = require("../../middleware/errorHandler");
const router = (0, express_1.Router)();
// Get all doctors with status
router.get('/', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const doctors = await (0, database_1.query)(`SELECT d.id, u.full_name, u.email, u.phone, u.created_at,
              d.medical_system, d.degree, d.specialization, d.city,
              d.profile_status, d.rejection_reason, d.experience_years,
              d.avg_rating, d.total_reviews, d.bio
       FROM doctors d
       JOIN users u ON u.id = d.user_id
       WHERE u.role = 'doctor'
       ORDER BY u.created_at DESC`, []);
        (0, apiResponse_1.sendSuccess)(res, doctors);
    }
    catch (e) {
        next(e);
    }
});
// Suspend a doctor
router.post('/:doctorId/suspend', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const { reason } = req.body;
        if (!reason?.trim())
            throw new errorHandler_1.AppError(400, 'MISSING_REASON', 'Suspension reason is required.');
        const doctor = await (0, database_1.queryOne)('SELECT id, user_id FROM doctors WHERE id=$1', [req.params.doctorId]);
        if (!doctor)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Doctor not found.');
        await (0, database_1.query)(`UPDATE doctors SET profile_status='suspended', rejection_reason=$1 WHERE id=$2`, [reason.trim(), req.params.doctorId]);
        await (0, database_1.query)(`UPDATE users SET is_active=FALSE WHERE id=$1`, [doctor.user_id]);
        // Log suspension
        await (0, database_1.query)(`INSERT INTO doctor_suspension_log (doctor_id, action, reason, admin_id)
       VALUES ($1, 'suspended', $2, $3)`, [req.params.doctorId, reason.trim(), req.user.sub]);
        (0, apiResponse_1.sendSuccess)(res, { message: 'Doctor suspended successfully.' });
    }
    catch (e) {
        next(e);
    }
});
// Reinstate a doctor
router.post('/:doctorId/reinstate', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const { note } = req.body;
        const doctor = await (0, database_1.queryOne)('SELECT id, user_id FROM doctors WHERE id=$1', [req.params.doctorId]);
        if (!doctor)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Doctor not found.');
        await (0, database_1.query)(`UPDATE doctors SET profile_status='verified', rejection_reason=NULL WHERE id=$1`, [req.params.doctorId]);
        await (0, database_1.query)(`UPDATE users SET is_active=TRUE WHERE id=$1`, [doctor.user_id]);
        await (0, database_1.query)(`INSERT INTO doctor_suspension_log (doctor_id, action, reason, admin_id)
       VALUES ($1, 'reinstated', $2, $3)`, [req.params.doctorId, note || 'Reinstated by admin', req.user.sub]);
        (0, apiResponse_1.sendSuccess)(res, { message: 'Doctor reinstated successfully.' });
    }
    catch (e) {
        next(e);
    }
});
// Get suspension log for a doctor
router.get('/:doctorId/log', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const logs = await (0, database_1.query)(`SELECT l.*, u.full_name AS admin_name
       FROM doctor_suspension_log l
       JOIN users u ON u.id = l.admin_id
       WHERE l.doctor_id=$1
       ORDER BY l.created_at DESC`, [req.params.doctorId]);
        (0, apiResponse_1.sendSuccess)(res, logs);
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
// ── Case Management ──────────────────────────────────────────────────────────
// Get all cases for a doctor
router.get('/:doctorId/cases', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const cases = await (0, database_1.query)(`SELECT c.*, u.full_name AS admin_name,
              (SELECT COUNT(*) FROM doctor_case_evidence e WHERE e.case_id = c.id) AS evidence_count
       FROM doctor_cases c
       JOIN users u ON u.id = c.admin_id
       WHERE c.doctor_id = $1
       ORDER BY c.created_at DESC`, [req.params.doctorId]);
        (0, apiResponse_1.sendSuccess)(res, cases);
    }
    catch (e) {
        next(e);
    }
});
// Create a case
router.post('/:doctorId/cases', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const { case_type, title, description, incident_date, severity } = req.body;
        if (!case_type || !title || !description) {
            throw new errorHandler_1.AppError(400, 'MISSING_FIELDS', 'case_type, title and description required.');
        }
        const [c] = await (0, database_1.query)(`INSERT INTO doctor_cases (doctor_id, case_type, title, description, incident_date, severity, admin_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [req.params.doctorId, case_type, title, description, incident_date || null, severity || 'medium', req.user.sub]);
        (0, apiResponse_1.sendSuccess)(res, c);
    }
    catch (e) {
        next(e);
    }
});
// Get evidence upload URL for a case
router.post('/:doctorId/cases/:caseId/evidence/upload-url', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const AWS = await Promise.resolve().then(() => __importStar(require('aws-sdk')));
        const r2 = new AWS.default.S3({
            endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
            region: 'auto',
            signatureVersion: 'v4',
        });
        const { file_name, content_type } = req.body;
        const key = `doctor-cases/${req.params.doctorId}/${req.params.caseId}/${Date.now()}-${file_name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        const upload_url = r2.getSignedUrl('putObject', {
            Bucket: process.env.R2_BUCKET || 'onlineconsultation',
            Key: key, ContentType: content_type, Expires: 300,
        });
        (0, apiResponse_1.sendSuccess)(res, { upload_url, key });
    }
    catch (e) {
        next(e);
    }
});
// Save evidence metadata
router.post('/:doctorId/cases/:caseId/evidence', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const { file_key, file_name, file_size } = req.body;
        const [ev] = await (0, database_1.query)(`INSERT INTO doctor_case_evidence (case_id, file_key, file_name, file_size, uploaded_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`, [req.params.caseId, file_key, file_name, file_size || null, req.user.sub]);
        (0, apiResponse_1.sendSuccess)(res, ev);
    }
    catch (e) {
        next(e);
    }
});
// Get evidence for a case
router.get('/:doctorId/cases/:caseId/evidence', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const evidence = await (0, database_1.query)(`SELECT e.*, u.full_name AS uploaded_by_name
       FROM doctor_case_evidence e
       JOIN users u ON u.id = e.uploaded_by
       WHERE e.case_id = $1 ORDER BY e.created_at DESC`, [req.params.caseId]);
        (0, apiResponse_1.sendSuccess)(res, evidence);
    }
    catch (e) {
        next(e);
    }
});
// View evidence file
router.get('/:doctorId/cases/:caseId/evidence/:evidenceId/view', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const AWS = await Promise.resolve().then(() => __importStar(require('aws-sdk')));
        const r2 = new AWS.default.S3({
            endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
            region: 'auto', signatureVersion: 'v4',
        });
        const [ev] = await (0, database_1.query)('SELECT * FROM doctor_case_evidence WHERE id=$1', [req.params.evidenceId]);
        if (!ev)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Evidence not found.');
        const url = r2.getSignedUrl('getObject', {
            Bucket: process.env.R2_BUCKET || 'onlineconsultation',
            Key: ev.file_key, Expires: 300,
        });
        (0, apiResponse_1.sendSuccess)(res, { url });
    }
    catch (e) {
        next(e);
    }
});
// Update case status / take action
router.patch('/:doctorId/cases/:caseId', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const { status, action_taken } = req.body;
        const [c] = await (0, database_1.query)(`UPDATE doctor_cases SET status=$1, action_taken=$2, updated_at=NOW()
       WHERE id=$3 AND doctor_id=$4 RETURNING *`, [status, action_taken || null, req.params.caseId, req.params.doctorId]);
        (0, apiResponse_1.sendSuccess)(res, c);
    }
    catch (e) {
        next(e);
    }
});
//# sourceMappingURL=doctors.routes.js.map