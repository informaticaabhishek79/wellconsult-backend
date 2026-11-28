import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query, queryOne } from '../../config/database';
import { sendSuccess } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';

const router = Router();

// GET patient's own appointments
router.get('/me/appointments', authenticate, authorize('patient'), async (req, res, next) => {
  try {
    const [patient] = await query<{ id: string }>('SELECT id FROM patients WHERE user_id=$1', [req.user!.sub]) as any[];
    if (!patient) { sendSuccess(res, []); return; }
    const appts = await query(
      `SELECT a.id, a.appt_date, a.appt_time, a.consult_type, a.status, a.doctor_id,
              a.payment_status, a.amount_paise, a.hold_expires_at, a.is_instant, a.cancellation_reason,
              pay.refund_status, pay.refund_amount,
              d.medical_system, d.specialization,
              u.full_name AS doctor_name
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN users u ON u.id = d.user_id
       LEFT JOIN payments pay ON pay.id = a.payment_id
       WHERE a.patient_id = $1
       ORDER BY a.appt_date DESC, a.appt_time DESC`,
      [patient.id]
    );
    sendSuccess(res, appts);
  } catch (e) { next(e); }
});

// GET patient's medical history
router.get('/me/history', authenticate, authorize('patient'), async (req, res, next) => {
  try {
    const [patient] = await query<{ id: string }>('SELECT id FROM patients WHERE user_id=$1', [req.user!.sub]) as any[];
    if (!patient) { sendSuccess(res, null); return; }
    const history = await queryOne(
      'SELECT * FROM patient_medical_history WHERE patient_id=$1',
      [patient.id]
    );
    sendSuccess(res, history || null);
  } catch (e) { next(e); }
});

// PUT patient's medical history
router.put('/me/history', authenticate, authorize('patient'), async (req, res, next) => {
  try {
    const [patient] = await query<{ id: string }>('SELECT id FROM patients WHERE user_id=$1', [req.user!.sub]) as any[];
    if (!patient) throw new AppError(404, 'NOT_FOUND', 'Patient not found.');
    const {
      blood_group, height_cm, weight_kg,
      chronic_conditions, allergies,
      current_medications, past_surgeries, family_history,
      smoking, alcohol,
      emergency_contact_name, emergency_contact_phone,
    } = req.body;

    const existing = await queryOne('SELECT id FROM patient_medical_history WHERE patient_id=$1', [patient.id]);

    if (existing) {
      await query(
        `UPDATE patient_medical_history SET
           blood_group=$1, height_cm=$2, weight_kg=$3,
           chronic_conditions=$4, allergies=$5,
           current_medications=$6, past_surgeries=$7, family_history=$8,
           smoking=$9, alcohol=$10,
           emergency_contact_name=$11, emergency_contact_phone=$12,
           updated_at=NOW()
         WHERE patient_id=$13`,
        [blood_group, height_cm||null, weight_kg||null,
         JSON.stringify(chronic_conditions||[]), JSON.stringify(allergies||[]),
         current_medications, past_surgeries, family_history,
         smoking, alcohol,
         emergency_contact_name, emergency_contact_phone, patient.id]
      );
    } else {
      await query(
        `INSERT INTO patient_medical_history
           (patient_id, blood_group, height_cm, weight_kg, chronic_conditions, allergies,
            current_medications, past_surgeries, family_history, smoking, alcohol,
            emergency_contact_name, emergency_contact_phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [patient.id, blood_group, height_cm||null, weight_kg||null,
         JSON.stringify(chronic_conditions||[]), JSON.stringify(allergies||[]),
         current_medications, past_surgeries, family_history,
         smoking, alcohol,
         emergency_contact_name, emergency_contact_phone]
      );
    }

    const history = await queryOne('SELECT * FROM patient_medical_history WHERE patient_id=$1', [patient.id]);
    sendSuccess(res, history);
  } catch (e) { next(e); }
});

// Doctor views patient history (only if they have/had an appointment together)
router.get('/:patientId/history', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    // Verify doctor has appointment with this patient
    const [appt] = await query(
      `SELECT a.id FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       WHERE a.doctor_id=$1 AND p.id=$2 LIMIT 1`,
      [req.user!.doctorId, req.params.patientId]
    ) as any[];
    if (!appt) throw new AppError(403, 'FORBIDDEN', 'You do not have access to this patient\'s history.');

    const history = await queryOne('SELECT * FROM patient_medical_history WHERE patient_id=$1', [req.params.patientId]);
    const patient = await queryOne(
      `SELECT u.full_name, u.email FROM patients p JOIN users u ON u.id=p.user_id WHERE p.id=$1`,
      [req.params.patientId]
    ) as any;

    sendSuccess(res, { ...history, patient_name: patient?.full_name });
  } catch (e) { next(e); }
});

export default router;
