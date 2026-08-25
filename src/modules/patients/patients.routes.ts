import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query } from '../../config/database';
import { sendSuccess } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';
import { getPagination } from '../../utils/pagination';

const router = Router();
router.use(authenticate);

// GET /patients/me/profile
router.get('/me/profile', async (req, res, next) => {
  try {
    const [p] = await query('SELECT * FROM patients WHERE user_id=$1', [req.user!.sub]);
    if (!p) throw new AppError(404, 'NOT_FOUND', 'Patient profile not found.');
    sendSuccess(res, p);
  } catch (e) { next(e); }
});

// PUT /patients/me/profile
router.put('/me/profile', async (req, res, next) => {
  try {
    const { gender, blood_group, emergency_contact, known_allergies, chronic_conditions, date_of_birth } = req.body;
    const [p] = await query(
      `UPDATE patients SET gender=$1, blood_group=$2, emergency_contact=$3,
       known_allergies=$4, chronic_conditions=$5, date_of_birth=$6, updated_at=NOW()
       WHERE user_id=$7 RETURNING *`,
      [gender, blood_group, emergency_contact,
       known_allergies || [], chronic_conditions || [],
       date_of_birth || null, req.user!.sub]
    );
    sendSuccess(res, p);
  } catch (e) { next(e); }
});

// GET /patients/me/appointments
router.get('/me/appointments', async (req, res, next) => {
  try {
    const { limit, offset, page } = getPagination(req);
    const [pat] = await query('SELECT id FROM patients WHERE user_id=$1', [req.user!.sub]);
    if (!pat) throw new AppError(404, 'NOT_FOUND', 'Patient not found.');
    const rows = await query(
      `SELECT a.id, a.appt_date, a.appt_time, a.consult_type, a.status,
              u.full_name AS doctor_name, d.id AS doctor_id, d.medical_system, d.specialization
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN users u ON u.id = d.user_id
       WHERE a.patient_id=$1
       ORDER BY a.appt_date DESC LIMIT $2 OFFSET $3`,
      [pat.id, limit, offset]
    );
    const [{ count }] = await query<{ count: string }>(
      'SELECT COUNT(*)::int AS count FROM appointments WHERE patient_id=$1', [pat.id]
    );
    sendSuccess(res, rows, 200, { page, limit, total: parseInt(count) });
  } catch (e) { next(e); }
});

// GET /patients/me/prescriptions
router.get('/me/prescriptions', async (req, res, next) => {
  try {
    const [pat] = await query('SELECT id FROM patients WHERE user_id=$1', [req.user!.sub]);
    if (!pat) throw new AppError(404, 'NOT_FOUND', 'Patient not found.');
    const rows = await query(
      `SELECT p.id, p.medical_system, p.issued_at,
              u.full_name AS doctor_name,
              JSON_AGG(pi ORDER BY pi.id) AS items
       FROM prescriptions p
       JOIN doctors d ON d.id = p.doctor_id
       JOIN users u ON u.id = d.user_id
       LEFT JOIN prescription_items pi ON pi.prescription_id = p.id
       WHERE p.patient_id=$1
       GROUP BY p.id, u.full_name
       ORDER BY p.issued_at DESC`,
      [pat.id]
    );
    sendSuccess(res, rows);
  } catch (e) { next(e); }
});

// GET /patients/me/records
router.get('/me/records', async (req, res, next) => {
  try {
    const [pat] = await query('SELECT id FROM patients WHERE user_id=$1', [req.user!.sub]);
    if (!pat) throw new AppError(404, 'NOT_FOUND', 'Patient not found.');
    const rows = await query(
      `SELECT * FROM patient_records WHERE patient_id=$1 ORDER BY created_at DESC`,
      [pat.id]
    );
    sendSuccess(res, rows);
  } catch (e) { next(e); }
});

// GET /patients/:id/records (for doctors)
router.get('/:patientId/records', authorize('doctor', 'admin'), async (req, res, next) => {
  try {
    const rows = await query(
      'SELECT * FROM patient_records WHERE patient_id=$1 ORDER BY created_at DESC',
      [req.params.patientId]
    );
    sendSuccess(res, rows);
  } catch (e) { next(e); }
});

export default router;
