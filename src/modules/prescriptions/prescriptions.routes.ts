import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query, queryOne, withTransaction } from '../../config/database';
import { sendSuccess, sendCreated } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';
import { checkAllergies } from '../clinical/allergy';
import { schedulesFromPrescription } from '../clinical/meds';
import { patientAllergies } from '../clinical/clinical.routes';
import { NotificationService } from '../notifications/notifications.service';

const router = Router();
router.use(authenticate);

// POST /prescriptions (doctor only)
router.post('/', authorize('doctor'), async (req, res, next) => {
  try {
    const { consultation_id, appointment_id, medical_system, items, allergy_acknowledged, allergy_override_reason } = req.body;
    let c: { doctor_id: string; patient_id: string } | null = null;

    if (consultation_id) {
      c = await queryOne<{ doctor_id: string; patient_id: string }>(
        'SELECT doctor_id, patient_id FROM consultations WHERE id=$1', [consultation_id]
      );
    } else if (appointment_id) {
      // Get doctor and patient from appointment directly
      const appt = await queryOne<{ doctor_id: string; patient_id: string }>(
        'SELECT doctor_id, patient_id FROM appointments WHERE id=$1', [appointment_id]
      );
      c = appt || null;
    }
    if (!c) throw new AppError(404, 'NOT_FOUND', 'Consultation not found.');
    if (c.doctor_id !== req.user!.doctorId) throw new AppError(403, 'FORBIDDEN', 'You can only prescribe for your own patients.');
    const list = (Array.isArray(items) ? items : []).filter((i: any) => i?.medicine_name);
    if (!list.length) throw new AppError(400, 'MISSING_FIELDS', 'Add at least one medicine.');

    // Drug-allergy safety check: the doctor must confirm before prescribing against a recorded allergy.
    const warnings = checkAllergies(await patientAllergies(c.patient_id), list.map((i: any) => String(i.medicine_name)));
    if (warnings.length && !allergy_acknowledged)
      throw new AppError(409, 'ALLERGY_WARNING', 'This prescription may conflict with the patient\'s recorded allergies.', { warnings });
    if (warnings.length && !String(allergy_override_reason || '').trim())
      throw new AppError(400, 'REASON_REQUIRED', 'Give a reason for prescribing despite the allergy warning.', { warnings });

    const result = await withTransaction(async (client) => {
      const [rx] = await client.query(
        `INSERT INTO prescriptions (consultation_id, doctor_id, patient_id, medical_system, appointment_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, issued_at`,
        [consultation_id || null, c.doctor_id, c.patient_id, medical_system, appointment_id ? String(appointment_id) : null]
      ).then(r => r.rows);

      for (const item of list) {
        await client.query(
          `INSERT INTO prescription_items (prescription_id, medicine_name, dosage, frequency, duration_days, instructions)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [rx.id, item.medicine_name, item.dosage, item.frequency, item.duration_days, item.instructions]
        );
      }
      await schedulesFromPrescription(client, rx.id, c!.patient_id, list);
      if (warnings.length)
        await client.query(`INSERT INTO allergy_overrides (prescription_id, doctor_id, patient_id, warnings) VALUES ($1,$2,$3,$4)`,
          [String(rx.id), c!.doctor_id, c!.patient_id, JSON.stringify({ warnings, reason: String(allergy_override_reason).slice(0, 500) })]);
      return rx;
    });

    queryOne<any>(`SELECT u.id, u.fcm_token FROM patients p JOIN users u ON u.id=p.user_id WHERE p.id=$1`, [c.patient_id]).then(u => u && NotificationService.send({
      userId: u.id, type: 'prescription', title: 'New prescription', body: 'Your medicines and reminders are in Medicines.', refType: 'prescription', refId: String(result.id), fcmToken: u.fcm_token,
    })).catch(() => {});
    sendCreated(res, { ...result, allergy_warnings: warnings });
  } catch (e) { next(e); }
});

// GET /prescriptions (patient gets their prescriptions)
router.get('/', async (req, res, next) => {
  try {
    const { query } = await import('../../config/database');
    let prescriptions: any[] = [];
    if (req.user!.role === 'patient') {
      const [patient] = await query<{ id: string }>('SELECT id FROM patients WHERE user_id=$1', [req.user!.sub]);
      if (!patient) { sendSuccess(res, []); return; }
      prescriptions = await query(
        `SELECT p.id, p.medical_system, p.issued_at,
                u.full_name AS doctor_name,
                JSON_AGG(pi ORDER BY pi.id) FILTER (WHERE pi.id IS NOT NULL) AS items
         FROM prescriptions p
         JOIN doctors d ON d.id = p.doctor_id
         JOIN users u ON u.id = d.user_id
         LEFT JOIN prescription_items pi ON pi.prescription_id = p.id
         WHERE p.patient_id = $1
         GROUP BY p.id, u.full_name
         ORDER BY p.issued_at DESC`,
        [patient.id]
      );
    } else if (req.user!.role === 'doctor') {
      prescriptions = await query(
        `SELECT p.id, p.medical_system, p.issued_at,
                pu.full_name AS patient_name,
                JSON_AGG(pi ORDER BY pi.id) FILTER (WHERE pi.id IS NOT NULL) AS items
         FROM prescriptions p
         JOIN patients pat ON pat.id = p.patient_id
         JOIN users pu ON pu.id = pat.user_id
         LEFT JOIN prescription_items pi ON pi.prescription_id = p.id
         WHERE p.doctor_id = $1
         GROUP BY p.id, pu.full_name
         ORDER BY p.issued_at DESC`,
        [req.user!.doctorId]
      );
    } else { prescriptions = []; }
    sendSuccess(res, prescriptions);
  } catch (e) { next(e); }
});

// GET /prescriptions/:id
router.get('/:id', async (req, res, next) => {
  try {
    const rx = await queryOne(
      `SELECT p.*, u.full_name AS doctor_name,
              JSON_AGG(pi ORDER BY pi.id) AS items
       FROM prescriptions p
       JOIN doctors d ON d.id = p.doctor_id
       JOIN users u ON u.id = d.user_id
       LEFT JOIN prescription_items pi ON pi.prescription_id = p.id
       WHERE p.id=$1 GROUP BY p.id, u.full_name`,
      [req.params.id]
    );
    if (!rx) throw new AppError(404, 'NOT_FOUND', 'Prescription not found.');
    sendSuccess(res, rx);
  } catch (e) { next(e); }
});

export default router;
