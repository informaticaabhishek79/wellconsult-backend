import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query } from '../../config/database';
import { sendSuccess } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';

const router = Router();

// All admin routes require admin role
router.use(authenticate, authorize('admin'));

// GET /admin/doctors/pending — list doctors awaiting verification
router.get('/doctors/pending', async (_req, res, next) => {
  try {
    const rows = await query(
      `SELECT d.id AS doctor_id, d.*, u.full_name, u.email, u.avatar_url
       FROM doctors d
       JOIN users u ON u.id = d.user_id
       WHERE d.profile_status = 'pending'
       ORDER BY d.created_at ASC`
    );
    sendSuccess(res, rows);
  } catch (e) { next(e); }
});

// PATCH /admin/doctors/:id/verify
router.patch('/doctors/:id/verify', async (req, res, next) => {
  try {
    const { notes } = req.body;
    const doctor = await query(
      `UPDATE doctors SET profile_status='verified', verified_at=NOW(), updated_at=NOW()
       WHERE id=$1 RETURNING id, profile_status`,
      [req.params.id]
    );
    if (!doctor.length) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');
    sendSuccess(res, { ...doctor[0], notes });
  } catch (e) { next(e); }
});

// PATCH /admin/doctors/:id/reject
router.patch('/doctors/:id/reject', async (req, res, next) => {
  try {
    await query(
      `UPDATE doctors SET profile_status='rejected', updated_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    sendSuccess(res, { message: 'Doctor rejected.' });
  } catch (e) { next(e); }
});

// PATCH /admin/doctors/:id/suspend
router.patch('/doctors/:id/suspend', async (req, res, next) => {
  try {
    await query(
      `UPDATE doctors SET profile_status='suspended', updated_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    sendSuccess(res, { message: 'Doctor suspended.' });
  } catch (e) { next(e); }
});

// GET /admin/stats — platform KPIs
router.get('/stats', async (_req, res, next) => {
  try {
    const [stats] = await query(`
      SELECT
        (SELECT COUNT(*) FROM users)::int                                         AS total_users,
        (SELECT COUNT(*) FROM doctors WHERE profile_status='verified')::int       AS verified_doctors,
        (SELECT COUNT(*) FROM doctors WHERE profile_status='pending')::int        AS pending_doctors,
        (SELECT COUNT(*) FROM appointments)::int                                  AS total_appointments,
        (SELECT COUNT(*) FROM appointments WHERE status='completed')::int         AS completed_appointments,
        (SELECT COALESCE(SUM(amount),0) FROM payments WHERE status='paid')::int  AS total_revenue
    `);
    sendSuccess(res, stats);
  } catch (e) { next(e); }
});

export default router;
