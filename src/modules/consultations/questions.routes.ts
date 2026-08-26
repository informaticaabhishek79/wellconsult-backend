import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query, queryOne } from '../../config/database';
import { sendSuccess, sendCreated } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';

const router = Router();

// Patient submits a question
router.post('/', authenticate, authorize('patient'), async (req, res, next) => {
  try {
    const { specialty, question, patient_age, patient_gender } = req.body;
    if (!specialty || !question) throw new AppError(400, 'MISSING_FIELDS', 'Specialty and question are required.');
    if (question.length < 20) throw new AppError(400, 'TOO_SHORT', 'Please provide more details (minimum 20 characters).');

    const [patient] = await query<{ id: string }>('SELECT id FROM patients WHERE user_id=$1', [req.user!.sub]);
    if (!patient) throw new AppError(404, 'NOT_FOUND', 'Patient profile not found.');

    const [q] = await query(
      `INSERT INTO doctor_questions (patient_id, specialty, question, patient_age, patient_gender, status)
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
      [patient.id, specialty, question, patient_age || null, patient_gender || null]
    ) as any[];

    sendCreated(res, q);
  } catch (e) { next(e); }
});

// Patient gets their questions
router.get('/', authenticate, authorize('patient'), async (req, res, next) => {
  try {
    const [patient] = await query<{ id: string }>('SELECT id FROM patients WHERE user_id=$1', [req.user!.sub]);
    if (!patient) { sendSuccess(res, []); return; }

    const questions = await query(
      `SELECT dq.*, u.full_name AS doctor_name
       FROM doctor_questions dq
       LEFT JOIN doctors d ON d.id = dq.doctor_id
       LEFT JOIN users u ON u.id = d.user_id
       WHERE dq.patient_id = $1
       ORDER BY dq.created_at DESC`,
      [patient.id]
    );

    sendSuccess(res, questions);
  } catch (e) { next(e); }
});

// Doctor gets pending questions for their specialty
router.get('/pending', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    const [doctor] = await query<{ id: string; medical_system: string }>('SELECT id, medical_system FROM doctors WHERE id=$1', [req.user!.doctorId]);
    
    const questions = await query(
      `SELECT dq.*, u.full_name AS patient_name
       FROM doctor_questions dq
       JOIN patients p ON p.id = dq.patient_id
       JOIN users u ON u.id = p.user_id
       WHERE dq.specialty = $1 AND dq.status = 'pending'
       ORDER BY dq.created_at ASC
       LIMIT 20`,
      [doctor?.medical_system || 'allopathy']
    );

    sendSuccess(res, questions);
  } catch (e) { next(e); }
});

// Doctor answers a question
router.patch('/:id/answer', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    const { answer } = req.body;
    if (!answer || answer.trim().length < 10) throw new AppError(400, 'TOO_SHORT', 'Please provide a detailed answer.');

    const q = await queryOne('SELECT * FROM doctor_questions WHERE id=$1', [req.params.id]) as any;
    if (!q) throw new AppError(404, 'NOT_FOUND', 'Question not found.');
    if (q.status !== 'pending') throw new AppError(422, 'ALREADY_ANSWERED', 'This question has already been answered.');

    const [updated] = await query(
      `UPDATE doctor_questions SET answer=$1, doctor_id=$2, status='answered', answered_at=NOW()
       WHERE id=$3 RETURNING *`,
      [answer.trim(), req.user!.doctorId, req.params.id]
    ) as any[];

    sendSuccess(res, updated);
  } catch (e) { next(e); }
});

export default router;
