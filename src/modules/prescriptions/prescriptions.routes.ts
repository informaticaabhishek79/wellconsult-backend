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
    const { consultation_id, medical_system, items } = req.body;
    const c = await queryOne<{ doctor_id: string; patient_id: string }>(
      'SELECT doctor_id, patient_id FROM consultations WHERE id=$1', [consultation_id]
    );
    if (!c) throw new AppError(404, 'NOT_FOUND', 'Consultation not found.');

    const result = await withTransaction(async (client) => {
      const [rx] = await client.query(
        `INSERT INTO prescriptions (consultation_id, doctor_id, patient_id, medical_system)
         VALUES ($1,$2,$3,$4) RETURNING id, issued_at`,
        [consultation_id, c.doctor_id, c.patient_id, medical_system]
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
