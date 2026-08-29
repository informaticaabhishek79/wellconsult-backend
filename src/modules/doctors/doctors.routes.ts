import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { DoctorsService } from './doctors.service';
import { sendSuccess } from '../../utils/apiResponse';

const router = Router();

// Public routes
router.get('/', async (req, res, next) => {
  try {
    const { rows, total, page, limit } = await DoctorsService.search(req);
    sendSuccess(res, rows, 200, { page, limit, total });
  } catch (e) { next(e); }
});

router.get('/:id/availability', async (req, res, next) => {
  try {
    const date = req.query.date as string || new Date().toISOString().slice(0, 10);
    sendSuccess(res, await DoctorsService.getAvailability(req.params.id, date));
  } catch (e) { next(e); }
});

// Doctor auth routes
router.get('/me/dashboard', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    const data = await DoctorsService.getDashboard(req.user!.doctorId!);
    sendSuccess(res, data);
  } catch (e) { next(e); }
});

router.get('/me/profile', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    sendSuccess(res, await DoctorsService.getMyProfile(req.user!.doctorId!));
  } catch (e) { next(e); }
});

router.put('/me/profile', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    sendSuccess(res, await DoctorsService.updateProfile(req.user!.doctorId!, req.body));
  } catch (e) { next(e); }
});

router.post('/me/fees', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    sendSuccess(res, await DoctorsService.updateFees(req.user!.doctorId!, req.body));
  } catch (e) { next(e); }
});

router.post('/me/availability', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    sendSuccess(res, await DoctorsService.addAvailability(req.user!.doctorId!, req.body));
  } catch (e) { next(e); }
});

router.get('/me/appointments', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    const { query } = await import('../../config/database');
    const appointments = await query(
      `SELECT a.id, a.appt_date, a.appt_time, a.consult_type, a.status,
              u.full_name AS patient_name, p.id AS patient_id
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       JOIN users u ON u.id = p.user_id
       WHERE a.doctor_id = $1
       ORDER BY a.appt_date DESC, a.appt_time DESC`,
      [req.user!.doctorId]
    );
    sendSuccess(res, appointments);
  } catch (e) { next(e); }
});

router.patch('/me/appointments/:id/confirm', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    const { notifyAppointmentConfirmed } = await import('../../services/notifications');
    const { query } = await import('../../config/database');
    await query("UPDATE appointments SET status='confirmed' WHERE id=$1 AND doctor_id=$2", [req.params.id, req.user!.doctorId]);
    sendSuccess(res, { message: 'Appointment confirmed' });
  } catch (e) { next(e); }
});

router.patch('/me/appointments/:id/complete', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    const { query } = await import('../../config/database');
    await query("UPDATE appointments SET status='completed' WHERE id=$1 AND doctor_id=$2", [req.params.id, req.user!.doctorId]);
    sendSuccess(res, { message: 'Appointment completed' });
  } catch (e) { next(e); }
});

router.post('/me/appointments/:id/followup', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    const { follow_up_days, notes } = req.body;
    const { query } = await import('../../config/database');
    // Update consultation with follow-up info
    await query(
      `UPDATE consultations SET follow_up_days=$1, follow_up_notes=$2 
       WHERE appointment_id=$3 AND doctor_id=$4`,
      [follow_up_days, notes, req.params.id, req.user!.doctorId]
    );
    sendSuccess(res, { message: 'Follow-up period set', follow_up_days });
  } catch (e) { next(e); }
});

// Public doctor detail (must be last to avoid conflicts with /me routes)
router.get('/:id', async (req, res, next) => {
  try { sendSuccess(res, await DoctorsService.getById(req.params.id)); }
  catch (e) { next(e); }
});

export default router;
