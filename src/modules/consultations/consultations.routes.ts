import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query, queryOne } from '../../config/database';
import { sendSuccess } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';

const router = Router();
router.use(authenticate);

// GET /consultations/:id
router.get('/:id', async (req, res, next) => {
  try {
    const c = await queryOne(
      `SELECT c.*, u.full_name AS patient_name, du.full_name AS doctor_name
       FROM consultations c
       JOIN patients p ON p.id = c.patient_id
       JOIN users u ON u.id = p.user_id
       JOIN doctors d ON d.id = c.doctor_id
       JOIN users du ON du.id = d.user_id
       WHERE c.id=$1`,
      [req.params.id]
    );
    // Try appointment lookup if not found as consultation id
    if (!c) {
      const a = await queryOne(
        `SELECT a.id, a.doctor_id, a.patient_id, a.consult_type,
                a.appt_date, a.appt_time, a.status AS session_status,
                du.full_name AS doctor_name, pu.full_name AS patient_name
         FROM appointments a
         JOIN doctors d ON d.id = a.doctor_id
         JOIN users du ON du.id = d.user_id
         JOIN patients p ON p.id = a.patient_id
         JOIN users pu ON pu.id = p.user_id
         WHERE a.id=$1`,
        [req.params.id]
      );
      if (!a) throw new AppError(404, 'NOT_FOUND', 'Consultation not found.');
      sendSuccess(res, a); return;
    }
    sendSuccess(res, c);
  } catch (e) { next(e); }
});

// PUT /consultations/:id/notes (doctor only)
router.put('/:id/notes', authorize('doctor'), async (req, res, next) => {
  try {
    const { clinical_notes, diagnosis, follow_up_notes, follow_up_days } = req.body;
    // Find or create consultation from appointment
    let c = await queryOne<{ id: string }>(
      'SELECT id FROM consultations WHERE appointment_id=$1', [req.params.id]
    );
    if (!c) {
      const appt = await queryOne<{ doctor_id: string; patient_id: string }>(
        'SELECT doctor_id, patient_id FROM appointments WHERE id=$1', [req.params.id]
      );
      if (!appt) throw new AppError(404, 'NOT_FOUND', 'Appointment not found.');
      const [newC] = await query(
        `INSERT INTO consultations (appointment_id, doctor_id, patient_id, session_status)
         VALUES ($1,$2,$3,'scheduled') RETURNING id`,
        [req.params.id, appt.doctor_id, appt.patient_id]
      );
      c = newC;
    }
    await query(
      `UPDATE consultations SET clinical_notes=$1, diagnosis=$2,
       follow_up_notes=$3, follow_up_days=$4 WHERE id=$5`,
      [clinical_notes, diagnosis, follow_up_notes, follow_up_days, c!.id]
    );
    sendSuccess(res, { message: 'Notes saved.' });
  } catch (e) { next(e); }
});

// GET /consultations/:id/session-token
router.get('/:id/session-token', async (req, res, next) => {
  try {
    sendSuccess(res, {
      provider: 'daily.co',
      room_url:  `https://wellconsult.daily.co/session-${req.params.id}`,
      token:     `dev_token_${Date.now()}`,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
  } catch (e) { next(e); }
});

export default router;
