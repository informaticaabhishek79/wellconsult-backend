import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query, queryOne } from '../../config/database';
import { sendSuccess, sendCreated } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';

const router = Router();

// Patient submits a review after completed appointment
router.post('/', authenticate, authorize('patient'), async (req, res, next) => {
  try {
    const { appointment_id, rating, review_text } = req.body;
    if (!appointment_id || !rating) throw new AppError(400, 'MISSING_FIELDS', 'appointment_id and rating are required.');
    if (rating < 1 || rating > 5) throw new AppError(400, 'INVALID_RATING', 'Rating must be between 1 and 5.');

    const [patient] = await query<{ id: string }>('SELECT id FROM patients WHERE user_id=$1', [req.user!.sub]) as any[];
    if (!patient) throw new AppError(404, 'NOT_FOUND', 'Patient not found.');

    // Verify appointment belongs to patient and is completed
    const appt = await queryOne<{ id: string; doctor_id: string; status: string }>(
      'SELECT id, doctor_id, status FROM appointments WHERE id=$1 AND patient_id=$2',
      [appointment_id, patient.id]
    );
    if (!appt) throw new AppError(404, 'NOT_FOUND', 'Appointment not found.');
    if (appt.status !== 'completed') throw new AppError(422, 'NOT_COMPLETED', 'You can only review completed consultations.');

    // Check if already reviewed
    const existing = await queryOne('SELECT id FROM reviews WHERE appointment_id=$1', [appointment_id]);
    if (existing) throw new AppError(409, 'ALREADY_REVIEWED', 'You have already reviewed this consultation.');

    // Save review
    const [review] = await query(
      `INSERT INTO reviews (patient_id, doctor_id, appointment_id, rating, review_text)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [patient.id, appt.doctor_id, appointment_id, rating, review_text?.trim() || null]
    ) as any[];

    // Update doctor avg_rating and total_reviews
    await query(
      `UPDATE doctors SET
         avg_rating = (SELECT AVG(rating) FROM reviews WHERE doctor_id=$1),
         total_reviews = (SELECT COUNT(*) FROM reviews WHERE doctor_id=$1)
       WHERE id=$1`,
      [appt.doctor_id]
    );

    sendCreated(res, review);
  } catch (e) { next(e); }
});

// Get reviews for a doctor
router.get('/doctor/:doctorId', async (req, res, next) => {
  try {
    const reviews = await query(
      `SELECT r.*, u.full_name AS patient_name
       FROM reviews r
       JOIN patients p ON p.id = r.patient_id
       JOIN users u ON u.id = p.user_id
       WHERE r.doctor_id = $1
       ORDER BY r.created_at DESC
       LIMIT 20`,
      [req.params.doctorId]
    );
    sendSuccess(res, reviews);
  } catch (e) { next(e); }
});

// Get patient's own reviews
router.get('/me', authenticate, authorize('patient'), async (req, res, next) => {
  try {
    const [patient] = await query<{ id: string }>('SELECT id FROM patients WHERE user_id=$1', [req.user!.sub]) as any[];
    if (!patient) { sendSuccess(res, []); return; }
    const reviews = await query(
      `SELECT r.*, u.full_name AS doctor_name
       FROM reviews r
       JOIN doctors d ON d.id = r.doctor_id
       JOIN users u ON u.id = d.user_id
       WHERE r.patient_id = $1
       ORDER BY r.created_at DESC`,
      [patient.id]
    );
    sendSuccess(res, reviews);
  } catch (e) { next(e); }
});

// Check if appointment is reviewed
router.get('/check/:appointmentId', authenticate, async (req, res, next) => {
  try {
    const review = await queryOne('SELECT id, rating FROM reviews WHERE appointment_id=$1', [req.params.appointmentId]);
    sendSuccess(res, { reviewed: !!review, review });
  } catch (e) { next(e); }
});

export default router;
