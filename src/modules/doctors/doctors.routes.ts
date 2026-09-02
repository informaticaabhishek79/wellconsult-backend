import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { DoctorsService } from './doctors.service';
import { sendSuccess } from '../../utils/apiResponse';
import { query } from '../../config/database';

const router = Router();

// Get online doctors
router.get('/online', authenticate, async (req, res, next) => {
  try {
    const { redis } = await import('../../config/redis');
    const { query: dbQuery } = await import('../../config/database');
    const keys = await redis.keys('doctor:online:*');
    if (keys.length === 0) { res.json({ success: true, data: [] }); return; }

    const onlineDoctorIds = keys.map((k: string) => k.replace('doctor:online:', ''));
    const doctors = await dbQuery(
      `SELECT d.id, u.full_name, d.medical_system, d.specialization, d.degree,
              d.avg_rating, d.total_reviews, d.city, d.experience_years
       FROM doctors d
       JOIN users u ON u.id = d.user_id
       WHERE d.id = ANY($1::uuid[])
         AND d.profile_status = 'verified'
         AND u.is_active = TRUE`,
      [onlineDoctorIds]
    );
    res.json({ success: true, data: doctors });
  } catch (e) { next(e); }
});


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
    await query("UPDATE appointments SET status='confirmed' WHERE id=$1 AND doctor_id=$2", [req.params.id, req.user!.doctorId]);
    setImmediate(async () => {
      try {
        const { notifyAppointmentConfirmed } = await import('../../services/notifications');
        const { query: q } = await import('../../config/database');
        const [apptInfo] = await q(
          `SELECT a.appt_date, a.appt_time, a.consult_type, u.phone AS patient_phone, du.full_name AS doctor_name
           FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN users u ON u.id=p.user_id
           JOIN doctors d ON d.id=a.doctor_id JOIN users du ON du.id=d.user_id WHERE a.id=$1`, [req.params.id]
        ) as any[];
        if (apptInfo) {
          await notifyAppointmentConfirmed({
            patientPhone: apptInfo.patient_phone,
            doctorName: apptInfo.doctor_name,
            date: String(apptInfo.appt_date).slice(0,10),
            time: String(apptInfo.appt_time).slice(0,5),
            consultType: apptInfo.consult_type,
          });
        }
      } catch(e) { console.error('Notification error:', e); }
    });
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

// Doctor earnings stats
router.get('/me/earnings', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    const { period = 'month' } = req.query;
    let dateFilter = '';
    if (period === 'week') dateFilter = "AND a.appt_date >= CURRENT_DATE - INTERVAL '7 days'";
    else if (period === 'month') dateFilter = "AND a.appt_date >= DATE_TRUNC('month', CURRENT_DATE)";
    else if (period === 'year') dateFilter = "AND a.appt_date >= DATE_TRUNC('year', CURRENT_DATE)";

    const [stats] = await query(
      `SELECT
        COUNT(*) AS total_consultations,
        COUNT(*) FILTER (WHERE a.status = 'completed') AS completed_consultations,
        COALESCE(SUM(CASE WHEN a.status = 'completed' THEN COALESCE(a.fee, 0) ELSE 0 END), 0) AS total_earnings,
        COALESCE(SUM(CASE WHEN a.status = 'confirmed' THEN COALESCE(a.fee, 0) ELSE 0 END), 0) AS pending_earnings,
        (SELECT avg_rating FROM doctors WHERE user_id=$1) AS avg_rating
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       WHERE d.user_id=$1 ${dateFilter}`,
      [req.user!.sub]
    ) as any[];

    sendSuccess(res, stats);
  } catch (e) { next(e); }
});

// Doctor earnings history
router.get('/me/earnings/history', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    const { period = 'month' } = req.query;
    let dateFilter = '';
    if (period === 'week') dateFilter = "AND a.appt_date >= CURRENT_DATE - INTERVAL '7 days'";
    else if (period === 'month') dateFilter = "AND a.appt_date >= DATE_TRUNC('month', CURRENT_DATE)";
    else if (period === 'year') dateFilter = "AND a.appt_date >= DATE_TRUNC('year', CURRENT_DATE)";

    const history = await query(
      `SELECT a.id, a.appt_date, a.appt_time, a.status, a.consult_type,
              COALESCE(a.fee, 0) AS fee,
              pu.full_name AS patient_name
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN patients pt ON pt.id = a.patient_id
       JOIN users pu ON pu.id = pt.user_id
       WHERE d.user_id=$1 ${dateFilter}
       ORDER BY a.appt_date DESC LIMIT 50`,
      [req.user!.sub]
    );

    sendSuccess(res, history);
  } catch (e) { next(e); }
});

export default router;
