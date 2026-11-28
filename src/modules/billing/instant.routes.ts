import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query, queryOne } from '../../config/database';
import { redis } from '../../config/redis';
import { sendSuccess } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';
import { REFUND_ETA } from './billing.service';
import { escalate } from './instant.jobs';

/* Instant consultations carry the promise: a doctor responds within 15 minutes of payment, or a full refund.
   The timer starts only once payment is confirmed (or at booking when online payments are off). */

const router = Router();
const limiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: (req: any) => req.user?.sub || req.ip,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many instant requests. Please wait a few minutes.' } } });

function istNow() {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const g = (t: string) => f.find(p => p.type === t)?.value || '';
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}

async function isOnline(doctorId: string) {
  try { return redis.isOpen ? !!(await redis.get(`doctor:online:${doctorId}`)) : false; } catch { return false; }
}

// Patient: request an instant consultation with an online doctor
router.post('/requests', authenticate, authorize('patient'), limiter, async (req, res, next) => {
  try {
    const { doctor_id, consult_type } = req.body || {};
    if (!doctor_id) throw new AppError(400, 'MISSING_FIELDS', 'doctor_id required.');
    if (!(await isOnline(doctor_id))) throw new AppError(409, 'DOCTOR_OFFLINE', 'This doctor has just gone offline. Please pick another online doctor.');
    const patient = await queryOne<{ id: string }>('SELECT id FROM patients WHERE user_id=$1', [req.user!.sub]);
    if (!patient) throw new AppError(404, 'NOT_FOUND', 'Patient profile not found.');
    const open = await queryOne(`SELECT id FROM appointments WHERE patient_id=$1 AND is_instant AND status IN ('pending_payment','booked') AND (hold_expires_at IS NULL OR hold_expires_at > NOW()) AND created_at > NOW() - INTERVAL '30 minutes'`, [patient.id]).catch(() => null);
    if (open) throw new AppError(409, 'ALREADY_WAITING', 'You already have an instant request in progress.');
    const now = istNow();
    const { AppointmentsService } = await import('../appointments/appointments.service');
    const r = await AppointmentsService.book(patient.id, {
      doctor_id, appt_date: now.date, appt_time: now.time, consult_type: ['video', 'phone', 'chat'].includes(consult_type) ? consult_type : 'video',
    }, { instant: true });
    await query(`UPDATE appointments SET instant_tried=ARRAY[$2::uuid] WHERE id=$1`, [r.appointment_id, doctor_id]);
    sendSuccess(res, r);
  } catch (e) { next(e); }
});

// Patient: live status for the waiting screen
router.get('/requests/:id', authenticate, authorize('patient'), async (req, res, next) => {
  try {
    const a = await queryOne<any>(
      `SELECT a.id, a.status, a.payment_status, a.consult_type, a.instant_deadline, a.accepted_at, a.escalation_level,
              a.amount_paise, a.hold_expires_at, a.cancellation_reason, du.full_name AS doctor_name, d.medical_system,
              pay.refund_status, pay.refund_amount
       FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN doctors d ON d.id=a.doctor_id JOIN users du ON du.id=d.user_id
       LEFT JOIN payments pay ON pay.id=a.payment_id
       WHERE a.id=$1 AND p.user_id=$2 AND a.is_instant`, [req.params.id, req.user!.sub]);
    if (!a) throw new AppError(404, 'NOT_FOUND', 'Request not found.');
    const secondsLeft = a.instant_deadline ? Math.max(0, Math.round((new Date(a.instant_deadline).getTime() - Date.now()) / 1000)) : null;
    const stage =
      a.status === 'pending_payment' ? 'awaiting_payment'
      : a.status === 'booked' ? 'waiting_for_doctor'
      : a.status === 'confirmed' || a.status === 'completed' ? 'accepted'
      : 'cancelled';
    sendSuccess(res, {
      ...a, stage, seconds_left: secondsLeft,
      refund: a.refund_status ? { status: a.refund_status, amount_paise: Number(a.refund_amount), eta: REFUND_ETA } : null,
    });
  } catch (e) { next(e); }
});

// Doctor: pending instant requests assigned to me
router.get('/doctor/pending', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    sendSuccess(res, await query(
      `SELECT a.id, a.consult_type, a.instant_deadline, a.escalation_level, pu.full_name AS patient_name
       FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN users pu ON pu.id=p.user_id
       WHERE a.doctor_id=$1 AND a.is_instant AND a.status='booked' AND a.instant_deadline > NOW()
       ORDER BY a.instant_deadline`, [req.user!.doctorId]));
  } catch (e) { next(e); }
});

router.post('/requests/:id/accept', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    const rows = await query<any>(
      `UPDATE appointments SET status='confirmed', accepted_at=NOW()
       WHERE id=$1 AND doctor_id=$2 AND is_instant AND status='booked' AND instant_deadline > NOW() RETURNING id`, [req.params.id, req.user!.doctorId]);
    if (!rows.length) throw new AppError(409, 'NOT_AVAILABLE', 'This request has expired or was passed to another doctor.');
    sendSuccess(res, { appointment_id: req.params.id, status: 'confirmed' });
  } catch (e) { next(e); }
});

router.post('/requests/:id/decline', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    const a = await queryOne<any>(`SELECT id FROM appointments WHERE id=$1 AND doctor_id=$2 AND is_instant AND status='booked'`, [req.params.id, req.user!.doctorId]);
    if (!a) throw new AppError(404, 'NOT_FOUND', 'Request not found.');
    const moved = await escalate(req.params.id, 'declined');
    sendSuccess(res, { passed_to_another_doctor: moved });
  } catch (e) { next(e); }
});

export default router;
