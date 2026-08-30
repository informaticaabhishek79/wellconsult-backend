import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query, queryOne } from '../../config/database';
import { sendSuccess } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';

const router = Router();

// Get all doctors with status
router.get('/', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const doctors = await query(
      `SELECT d.id, u.full_name, u.email, u.phone, u.created_at,
              d.medical_system, d.degree, d.specialization, d.city,
              d.profile_status, d.rejection_reason, d.experience_years,
              d.avg_rating, d.total_reviews, d.bio
       FROM doctors d
       JOIN users u ON u.id = d.user_id
       WHERE u.role = 'doctor'
       ORDER BY u.created_at DESC`,
      []
    );
    sendSuccess(res, doctors);
  } catch (e) { next(e); }
});

// Suspend a doctor
router.post('/:doctorId/suspend', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) throw new AppError(400, 'MISSING_REASON', 'Suspension reason is required.');

    const doctor = await queryOne<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM doctors WHERE id=$1', [req.params.doctorId]
    );
    if (!doctor) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');

    await query(
      `UPDATE doctors SET profile_status='suspended', rejection_reason=$1 WHERE id=$2`,
      [reason.trim(), req.params.doctorId]
    );

    await query(
      `UPDATE users SET is_active=FALSE WHERE id=$1`,
      [doctor.user_id]
    );

    // Log suspension
    await query(
      `INSERT INTO doctor_suspension_log (doctor_id, action, reason, admin_id)
       VALUES ($1, 'suspended', $2, $3)`,
      [req.params.doctorId, reason.trim(), req.user!.sub]
    );

    sendSuccess(res, { message: 'Doctor suspended successfully.' });
  } catch (e) { next(e); }
});

// Reinstate a doctor
router.post('/:doctorId/reinstate', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { note } = req.body;
    const doctor = await queryOne<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM doctors WHERE id=$1', [req.params.doctorId]
    );
    if (!doctor) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');

    await query(
      `UPDATE doctors SET profile_status='verified', rejection_reason=NULL WHERE id=$1`,
      [req.params.doctorId]
    );

    await query(
      `UPDATE users SET is_active=TRUE WHERE id=$1`,
      [doctor.user_id]
    );

    await query(
      `INSERT INTO doctor_suspension_log (doctor_id, action, reason, admin_id)
       VALUES ($1, 'reinstated', $2, $3)`,
      [req.params.doctorId, note || 'Reinstated by admin', req.user!.sub]
    );

    sendSuccess(res, { message: 'Doctor reinstated successfully.' });
  } catch (e) { next(e); }
});

// Get suspension log for a doctor
router.get('/:doctorId/log', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const logs = await query(
      `SELECT l.*, u.full_name AS admin_name
       FROM doctor_suspension_log l
       JOIN users u ON u.id = l.admin_id
       WHERE l.doctor_id=$1
       ORDER BY l.created_at DESC`,
      [req.params.doctorId]
    );
    sendSuccess(res, logs);
  } catch (e) { next(e); }
});

export default router;

// ── Case Management ──────────────────────────────────────────────────────────

// Get all cases for a doctor
router.get('/:doctorId/cases', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const cases = await query(
      `SELECT c.*, u.full_name AS admin_name,
              (SELECT COUNT(*) FROM doctor_case_evidence e WHERE e.case_id = c.id) AS evidence_count
       FROM doctor_cases c
       JOIN users u ON u.id = c.admin_id
       WHERE c.doctor_id = $1
       ORDER BY c.created_at DESC`,
      [req.params.doctorId]
    );
    sendSuccess(res, cases);
  } catch (e) { next(e); }
});

// Create a case
router.post('/:doctorId/cases', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { case_type, title, description, incident_date, severity } = req.body;
    if (!case_type || !title || !description) {
      throw new AppError(400, 'MISSING_FIELDS', 'case_type, title and description required.');
    }
    const [c] = await query(
      `INSERT INTO doctor_cases (doctor_id, case_type, title, description, incident_date, severity, admin_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.doctorId, case_type, title, description, incident_date || null, severity || 'medium', req.user!.sub]
    ) as any[];
    sendSuccess(res, c);
  } catch (e) { next(e); }
});

// Get evidence upload URL for a case
router.post('/:doctorId/cases/:caseId/evidence/upload-url', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const AWS = await import('aws-sdk');
    const r2 = new AWS.default.S3({
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      region: 'auto',
      signatureVersion: 'v4',
    });
    const { file_name, content_type } = req.body;
    const key = `doctor-cases/${req.params.doctorId}/${req.params.caseId}/${Date.now()}-${file_name.replace(/[^a-zA-Z0-9.-]/g,'_')}`;
    const upload_url = r2.getSignedUrl('putObject', {
      Bucket: process.env.R2_BUCKET || 'onlineconsultation',
      Key: key, ContentType: content_type, Expires: 300,
    });
    sendSuccess(res, { upload_url, key });
  } catch (e) { next(e); }
});

// Save evidence metadata
router.post('/:doctorId/cases/:caseId/evidence', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { file_key, file_name, file_size } = req.body;
    const [ev] = await query(
      `INSERT INTO doctor_case_evidence (case_id, file_key, file_name, file_size, uploaded_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.caseId, file_key, file_name, file_size || null, req.user!.sub]
    ) as any[];
    sendSuccess(res, ev);
  } catch (e) { next(e); }
});

// Get evidence for a case
router.get('/:doctorId/cases/:caseId/evidence', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const evidence = await query(
      `SELECT e.*, u.full_name AS uploaded_by_name
       FROM doctor_case_evidence e
       JOIN users u ON u.id = e.uploaded_by
       WHERE e.case_id = $1 ORDER BY e.created_at DESC`,
      [req.params.caseId]
    );
    sendSuccess(res, evidence);
  } catch (e) { next(e); }
});

// View evidence file
router.get('/:doctorId/cases/:caseId/evidence/:evidenceId/view', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const AWS = await import('aws-sdk');
    const r2 = new AWS.default.S3({
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      region: 'auto', signatureVersion: 'v4',
    });
    const [ev] = await query('SELECT * FROM doctor_case_evidence WHERE id=$1', [req.params.evidenceId]) as any[];
    if (!ev) throw new AppError(404, 'NOT_FOUND', 'Evidence not found.');
    const url = r2.getSignedUrl('getObject', {
      Bucket: process.env.R2_BUCKET || 'onlineconsultation',
      Key: ev.file_key, Expires: 300,
    });
    sendSuccess(res, { url });
  } catch (e) { next(e); }
});

// Update case status / take action
router.patch('/:doctorId/cases/:caseId', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { status, action_taken } = req.body;
    const [c] = await query(
      `UPDATE doctor_cases SET status=$1, action_taken=$2, updated_at=NOW()
       WHERE id=$3 AND doctor_id=$4 RETURNING *`,
      [status, action_taken || null, req.params.caseId, req.params.doctorId]
    ) as any[];
    sendSuccess(res, c);
  } catch (e) { next(e); }
});
