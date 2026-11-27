import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query, queryOne } from '../../config/database';
import { sendSuccess } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import AWS from 'aws-sdk';

const router = Router();

const r2 = new AWS.S3({
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  region: 'auto',
  signatureVersion: 'v4',
});

const BUCKET = process.env.R2_BUCKET || 'sahyog';

// Doctor requests presigned upload URL
router.post('/upload-url', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    const { document_type, file_name, content_type } = req.body;
    const allowed_types = ['degree_certificate', 'registration_certificate', 'practice_license', 'id_proof', 'photo'];
    if (!allowed_types.includes(document_type)) throw new AppError(400, 'INVALID_TYPE', 'Invalid document type.');
    const allowed_content = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowed_content.includes(content_type)) throw new AppError(400, 'INVALID_FORMAT', 'Only JPEG, PNG, WebP and PDF allowed.');

    const key = `doctor-docs/${req.user!.doctorId}/${document_type}/${Date.now()}-${file_name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const upload_url = r2.getSignedUrl('putObject', { Bucket: BUCKET, Key: key, ContentType: content_type, Expires: 300 });

    await query(
      `INSERT INTO doctor_documents (doctor_id, document_type, file_key, file_name, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (doctor_id, document_type)
       DO UPDATE SET file_key=$3, file_name=$4, status='pending', uploaded_at=NOW()`,
      [req.user!.doctorId, document_type, key, file_name]
    );

    sendSuccess(res, { upload_url, key });
  } catch (e) { next(e); }
});

// Doctor gets their verification status
router.get('/status', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    const docs = await query('SELECT document_type, file_name, status, uploaded_at FROM doctor_documents WHERE doctor_id=$1', [req.user!.doctorId]);
    const doctor = await queryOne<{ profile_status: string; rejection_reason: string }>('SELECT profile_status, rejection_reason FROM doctors WHERE id=$1', [req.user!.doctorId]);
    sendSuccess(res, { documents: docs, profile_status: doctor?.profile_status, rejection_reason: doctor?.rejection_reason });
  } catch (e) { next(e); }
});

// Admin gets all pending doctors
router.get('/pending', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const doctors = await query(
      `SELECT d.id, d.medical_system, d.degree, d.reg_number, d.profile_status, d.specialization, d.city,
              u.full_name, u.email,
              JSON_AGG(dd ORDER BY dd.document_type) FILTER (WHERE dd.id IS NOT NULL) AS documents,
              COUNT(dd.id) AS doc_count
       FROM doctors d JOIN users u ON u.id = d.user_id
       LEFT JOIN doctor_documents dd ON dd.doctor_id = d.id
       GROUP BY d.id, u.full_name, u.email
       HAVING COUNT(dd.id) > 0
       ORDER BY d.updated_at ASC`
    );
    sendSuccess(res, doctors);
  } catch (e) { next(e); }
});

// Admin views a document
router.get('/document/:doctorId/:docType', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const doc = await queryOne<{ file_key: string }>('SELECT file_key FROM doctor_documents WHERE doctor_id=$1 AND document_type=$2', [req.params.doctorId, req.params.docType]);
    if (!doc) throw new AppError(404, 'NOT_FOUND', 'Document not found.');
    const url = r2.getSignedUrl('getObject', { Bucket: BUCKET, Key: doc.file_key, Expires: 300 });
    sendSuccess(res, { url });
  } catch (e) { next(e); }
});

// Admin approves or rejects doctor
router.patch('/:doctorId/decision', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { decision, reason } = req.body;
    if (!['approved', 'rejected'].includes(decision)) throw new AppError(400, 'INVALID_DECISION', 'Decision must be approved or rejected.');
    const { decide } = await import('../admin/review');
    const { status } = await decide(req.params.doctorId, req.user!.sub, decision, reason);
    logger.info('Doctor verification decision', { doctorId: req.params.doctorId, decision, adminId: req.user!.sub });
    // Send notification
    setImmediate(async () => {
      try {
        const [info] = await query(
          `SELECT u.phone, u.full_name FROM doctors d JOIN users u ON u.id=d.user_id WHERE d.id=$1`,
          [req.params.doctorId]
        ) as any[];
        if (info) {
          const { notifyVerificationApproved, notifyVerificationRejected } = await import('../../services/notifications');
          if (decision === 'approved') {
            await notifyVerificationApproved({ doctorPhone: info.phone, doctorName: info.full_name });
          } else {
            await notifyVerificationRejected({ doctorPhone: info.phone, doctorName: info.full_name, reason });
          }
        }
      } catch {}
    });
    sendSuccess(res, { message: `Doctor ${decision}`, status });
  } catch (e) { next(e); }
});

export default router;
