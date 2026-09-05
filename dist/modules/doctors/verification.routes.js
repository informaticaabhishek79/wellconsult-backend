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
const logger_1 = require("../../utils/logger");
const aws_sdk_1 = __importDefault(require("aws-sdk"));
const router = (0, express_1.Router)();
const r2 = new aws_sdk_1.default.S3({
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    region: 'auto',
    signatureVersion: 'v4',
});
const BUCKET = process.env.R2_BUCKET || 'sahyog';
// Doctor requests presigned upload URL
router.post('/upload-url', authenticate_1.authenticate, (0, authorize_1.authorize)('doctor'), async (req, res, next) => {
    try {
        const { document_type, file_name, content_type } = req.body;
        const allowed_types = ['degree_certificate', 'registration_certificate', 'id_proof', 'photo'];
        if (!allowed_types.includes(document_type))
            throw new errorHandler_1.AppError(400, 'INVALID_TYPE', 'Invalid document type.');
        const allowed_content = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
        if (!allowed_content.includes(content_type))
            throw new errorHandler_1.AppError(400, 'INVALID_FORMAT', 'Only JPEG, PNG, WebP and PDF allowed.');
        const key = `doctor-docs/${req.user.doctorId}/${document_type}/${Date.now()}-${file_name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        const upload_url = r2.getSignedUrl('putObject', { Bucket: BUCKET, Key: key, ContentType: content_type, Expires: 300 });
        await (0, database_1.query)(`INSERT INTO doctor_documents (doctor_id, document_type, file_key, file_name, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (doctor_id, document_type)
       DO UPDATE SET file_key=$3, file_name=$4, status='pending', uploaded_at=NOW()`, [req.user.doctorId, document_type, key, file_name]);
        (0, apiResponse_1.sendSuccess)(res, { upload_url, key });
    }
    catch (e) {
        next(e);
    }
});
// Doctor gets their verification status
router.get('/status', authenticate_1.authenticate, (0, authorize_1.authorize)('doctor'), async (req, res, next) => {
    try {
        const docs = await (0, database_1.query)('SELECT document_type, file_name, status, uploaded_at FROM doctor_documents WHERE doctor_id=$1', [req.user.doctorId]);
        const doctor = await (0, database_1.queryOne)('SELECT profile_status, rejection_reason FROM doctors WHERE id=$1', [req.user.doctorId]);
        (0, apiResponse_1.sendSuccess)(res, { documents: docs, profile_status: doctor?.profile_status, rejection_reason: doctor?.rejection_reason });
    }
    catch (e) {
        next(e);
    }
});
// Admin gets all pending doctors
router.get('/pending', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const doctors = await (0, database_1.query)(`SELECT d.id, d.medical_system, d.degree, d.reg_number, d.profile_status, d.specialization, d.city,
              u.full_name, u.email,
              JSON_AGG(dd ORDER BY dd.document_type) FILTER (WHERE dd.id IS NOT NULL) AS documents,
              COUNT(dd.id) AS doc_count
       FROM doctors d JOIN users u ON u.id = d.user_id
       LEFT JOIN doctor_documents dd ON dd.doctor_id = d.id
       GROUP BY d.id, u.full_name, u.email
       HAVING COUNT(dd.id) > 0
       ORDER BY d.updated_at ASC`);
        (0, apiResponse_1.sendSuccess)(res, doctors);
    }
    catch (e) {
        next(e);
    }
});
// Admin views a document
router.get('/document/:doctorId/:docType', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const doc = await (0, database_1.queryOne)('SELECT file_key FROM doctor_documents WHERE doctor_id=$1 AND document_type=$2', [req.params.doctorId, req.params.docType]);
        if (!doc)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Document not found.');
        const url = r2.getSignedUrl('getObject', { Bucket: BUCKET, Key: doc.file_key, Expires: 300 });
        (0, apiResponse_1.sendSuccess)(res, { url });
    }
    catch (e) {
        next(e);
    }
});
// Admin approves or rejects doctor
router.patch('/:doctorId/decision', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const { decision, reason } = req.body;
        if (!['approved', 'rejected'].includes(decision))
            throw new errorHandler_1.AppError(400, 'INVALID_DECISION', 'Decision must be approved or rejected.');
        // Check documents uploaded before approving
        if (decision === 'approved') {
            const requiredDocs = ['degree_certificate', 'registration_certificate', 'id_proof'];
            const uploadedDocs = await (0, database_1.query)('SELECT document_type FROM doctor_documents WHERE doctor_id=$1', [req.params.doctorId]);
            const uploadedTypes = uploadedDocs.map((d) => d.document_type);
            const missingDocs = requiredDocs.filter(d => !uploadedTypes.includes(d));
            if (missingDocs.length > 0) {
                throw new errorHandler_1.AppError(422, 'DOCUMENTS_MISSING', `Cannot verify: missing documents — ${missingDocs.join(', ').replace(/_/g, ' ')}`);
            }
        }
        const status = decision === 'approved' ? 'verified' : 'rejected';
        await (0, database_1.query)(`UPDATE doctors SET profile_status=$1, rejection_reason=$2, verified_at=${decision === 'approved' ? 'NOW()' : 'NULL'} WHERE id=$3`, [status, reason || null, req.params.doctorId]);
        logger_1.logger.info('Doctor verification decision', { doctorId: req.params.doctorId, decision, adminId: req.user.sub });
        // Send notification
        setImmediate(async () => {
            try {
                const [info] = await (0, database_1.query)(`SELECT u.phone, u.full_name FROM doctors d JOIN users u ON u.id=d.user_id WHERE d.id=$1`, [req.params.doctorId]);
                if (info) {
                    const { notifyVerificationApproved, notifyVerificationRejected } = await Promise.resolve().then(() => __importStar(require('../../services/notifications')));
                    if (decision === 'approved') {
                        await notifyVerificationApproved({ doctorPhone: info.phone, doctorName: info.full_name });
                    }
                    else {
                        await notifyVerificationRejected({ doctorPhone: info.phone, doctorName: info.full_name, reason });
                    }
                }
            }
            catch { }
        });
        (0, apiResponse_1.sendSuccess)(res, { message: `Doctor ${decision}`, status });
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
//# sourceMappingURL=verification.routes.js.map