import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query } from '../../config/database';
import { sendSuccess } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';
import { EFFECTIVE_PCT_SQL } from '../../config/schema';

const router = Router();
router.use(authenticate, authorize('doctor'));

// GET /onboarding/doctors/status
router.get('/doctors/status', async (req, res, next) => {
  try {
    const doctor = await query(
      `SELECT profile_status, medical_system, degree, reg_number, city, bio,
              ARRAY_LENGTH(languages, 1) AS lang_count,
              (SELECT COUNT(*) FROM doctor_availability WHERE doctor_id=d.id) AS slot_count,
              (SELECT COUNT(*) FROM consultation_fees WHERE doctor_id=d.id) AS fee_count
       FROM doctors d WHERE user_id=$1`,
      [req.user!.sub]
    );
    sendSuccess(res, doctor[0] || {});
  } catch (e) { next(e); }
});

// POST /onboarding/doctors/profile
router.post('/doctors/profile', async (req, res, next) => {
  try {
    const { medical_system, degree, city, bio, languages, experience_years, specialization } = req.body;
    const [doc] = await query(
      `UPDATE doctors SET medical_system=$1, degree=$2, city=$3, bio=$4,
       languages=$5, experience_years=$6, specialization=$7, updated_at=NOW()
       WHERE user_id=$8 RETURNING id, profile_status`,
      [medical_system, degree, city, bio, languages, experience_years, specialization, req.user!.sub]
    );
    if (!doc) throw new AppError(404, 'NOT_FOUND', 'Doctor profile not found.');
    sendSuccess(res, doc);
  } catch (e) { next(e); }
});

// POST /onboarding/doctors/credentials
router.post('/doctors/credentials', async (req, res, next) => {
  try {
    const { reg_number, reg_body, reg_year, practice_license_no, practice_license_authority, specialization } = req.body || {};
    const clean = (v: any, n = 80) => (v === undefined || v === null ? null : String(v).trim().slice(0, n) || null);
    const year = reg_year ? Number(reg_year) : null;
    if (year !== null && (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear())) throw new AppError(400, 'INVALID', 'Invalid registration year.');
    await query(
      `UPDATE doctors SET reg_number=COALESCE($1, reg_number), reg_body=COALESCE($2, reg_body), reg_year=COALESCE($3, reg_year),
              practice_license_no=COALESCE($4, practice_license_no), practice_license_authority=COALESCE($5, practice_license_authority),
              specialization=COALESCE($6, specialization), updated_at=NOW()
       WHERE user_id=$7`,
      [clean(reg_number, 40), clean(reg_body), year, clean(practice_license_no, 60), clean(practice_license_authority), clean(specialization), req.user!.sub]
    );
    sendSuccess(res, { message: 'Credentials updated.' });
  } catch (e) { next(e); }
});

// GET /onboarding/doctors/commission — the rate offered to this doctor
router.get('/doctors/commission', async (req, res, next) => {
  try {
    const [d] = await query(
      `SELECT ${EFFECTIVE_PCT_SQL} AS offered_pct, d.commission_status, d.commission_accepted_pct, d.commission_responded_at
       FROM doctors d WHERE d.user_id=$1`, [req.user!.sub]) as any[];
    if (!d) throw new AppError(404, 'NOT_FOUND', 'Doctor profile not found.');
    sendSuccess(res, { ...d, offered_pct: Number(d.offered_pct), commission_accepted_pct: d.commission_accepted_pct == null ? null : Number(d.commission_accepted_pct) });
  } catch (e) { next(e); }
});

// POST /onboarding/doctors/commission { accept: boolean, pct: number }
router.post('/doctors/commission', async (req, res, next) => {
  try {
    const accept = req.body?.accept === true;
    const seen = Number(req.body?.pct);
    const [d] = await query(`SELECT d.id, ${EFFECTIVE_PCT_SQL} AS offered_pct FROM doctors d WHERE d.user_id=$1`, [req.user!.sub]) as any[];
    if (!d) throw new AppError(404, 'NOT_FOUND', 'Doctor profile not found.');
    const offered = Number(d.offered_pct);
    if (accept && seen !== offered) throw new AppError(409, 'RATE_CHANGED', `The commission is now ${offered}%. Please review it again.`);
    await query(
      `UPDATE doctors SET commission_status=$2, commission_accepted_pct=CASE WHEN $2='accepted' THEN $3 ELSE commission_accepted_pct END,
              commission_responded_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [d.id, accept ? 'accepted' : 'declined', offered]);
    sendSuccess(res, { commission_status: accept ? 'accepted' : 'declined', offered_pct: offered });
  } catch (e) { next(e); }
});

// POST /onboarding/doctors/availability
router.post('/doctors/availability', async (req, res, next) => {
  try {
    const { slots } = req.body;
    const [doc] = await query('SELECT id FROM doctors WHERE user_id=$1', [req.user!.sub]);
    if (!doc) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');

    // Clear existing and re-insert
    await query('DELETE FROM doctor_availability WHERE doctor_id=$1', [doc.id]);
    for (const slot of slots) {
      await query(
        `INSERT INTO doctor_availability (doctor_id, day_of_week, slot_start, slot_end)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [doc.id, slot.day_of_week, slot.slot_start, slot.slot_end]
      );
    }
    sendSuccess(res, { message: `${slots.length} slots saved.` });
  } catch (e) { next(e); }
});

// POST /onboarding/doctors/fees
router.post('/doctors/fees', async (req, res, next) => {
  try {
    const { fees } = req.body;
    const [doc] = await query('SELECT id FROM doctors WHERE user_id=$1', [req.user!.sub]);
    if (!doc) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');

    for (const fee of fees) {
      await query(
        `INSERT INTO consultation_fees (doctor_id, consult_type, fee_amount, currency)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (doctor_id, consult_type) DO UPDATE
         SET fee_amount=$3, currency=$4`,
        [doc.id, fee.consult_type, fee.fee_amount, fee.currency || 'INR']
      );
    }
    sendSuccess(res, { message: 'Fees saved.' });
  } catch (e) { next(e); }
});

export default router;
