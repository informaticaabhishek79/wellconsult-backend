import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query, queryOne, withTransaction } from '../../config/database';
import { sendSuccess, sendCreated } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';

const router = Router();
router.use(authenticate);

// POST /prescriptions (doctor only)
router.post('/', authorize('doctor'), async (req, res, next) => {
  try {
    const { consultation_id, appointment_id, medical_system, items } = req.body;
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

    const result = await withTransaction(async (client) => {
      const [rx] = await client.query(
        `INSERT INTO prescriptions (consultation_id, doctor_id, patient_id, medical_system)
         VALUES ($1,$2,$3,$4) RETURNING id, issued_at`,
        [consultation_id || null, c.doctor_id, c.patient_id, medical_system]
      ).then(r => r.rows);

      for (const item of items || []) {
        await client.query(
          `INSERT INTO prescription_items (prescription_id, medicine_name, dosage, frequency, duration_days, instructions)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [rx.id, item.medicine_name, item.dosage, item.frequency, item.duration_days, item.instructions]
        );
      }
      return rx;
    });

    sendCreated(res, result);
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
