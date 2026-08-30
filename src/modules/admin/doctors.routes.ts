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
              d.medical_system, d.degree, d.specialization, d.city, d.state,
              d.profile_status, d.rejection_reason, d.experience_years,
              d.avg_rating, d.total_consultations
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
