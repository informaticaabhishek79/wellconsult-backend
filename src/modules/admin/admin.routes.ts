import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query } from '../../config/database';
import { sendSuccess } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';
import { getDoctorForReview, decide, checklist } from './review';
import { EFFECTIVE_PCT_SQL } from '../../config/schema';

const router = Router();

// All admin routes require admin role
router.use(authenticate, authorize('admin'));

// GET /admin/doctors/pending — list doctors awaiting verification
router.get('/doctors/pending', async (_req, res, next) => {
  try {
    const rows = await query(
      `SELECT d.id AS doctor_id, d.*, u.full_name, u.email, u.avatar_url
       FROM doctors d
       JOIN users u ON u.id = d.user_id
       WHERE d.profile_status = 'pending'
       ORDER BY d.created_at ASC`
    );
    sendSuccess(res, rows);
  } catch (e) { next(e); }
});

// PATCH /admin/doctors/:id/verify — same rules as the review workspace
router.patch('/doctors/:id/verify', async (req, res, next) => {
  try { sendSuccess(res, await decide(req.params.id, req.user!.sub, 'approved')); } catch (e) { next(e); }
});

// PATCH /admin/doctors/:id/reject
router.patch('/doctors/:id/reject', async (req, res, next) => {
  try {
    await query(
      `UPDATE doctors SET profile_status='rejected', rejection_reason=COALESCE($2, rejection_reason), updated_at=NOW() WHERE id=$1`,
      [req.params.id, req.body?.reason || null]
    );
    sendSuccess(res, { message: 'Doctor rejected.' });
  } catch (e) { next(e); }
});

// PATCH /admin/doctors/:id/suspend
router.patch('/doctors/:id/suspend', async (req, res, next) => {
  try {
    await query(
      `UPDATE doctors SET profile_status='suspended', updated_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    sendSuccess(res, { message: 'Doctor suspended.' });
  } catch (e) { next(e); }
});

// GET /admin/stats — platform KPIs
router.get('/stats', async (_req, res, next) => {
  try {
    const [stats] = await query(`
      SELECT
        (SELECT COUNT(*) FROM users)::int                                         AS total_users,
        (SELECT COUNT(*) FROM doctors WHERE profile_status='verified')::int       AS verified_doctors,
        (SELECT COUNT(*) FROM doctors WHERE profile_status='pending')::int        AS pending_doctors,
        (SELECT COUNT(*) FROM appointments)::int                                  AS total_appointments,
        (SELECT COUNT(*) FROM appointments WHERE status='completed')::int         AS completed_appointments,
        (SELECT COALESCE(SUM(amount),0) FROM payments WHERE status='paid')::int  AS total_revenue
    `);
    sendSuccess(res, stats);
  } catch (e) { next(e); }
});

/* ── Commission settings ─────────────────────────────────────────── */

router.get('/settings/commission', async (_req, res, next) => {
  try {
    const row = await query(`SELECT value, updated_at FROM platform_settings WHERE key='commission'`) as any[];
    sendSuccess(res, { default_pct: Number(row[0]?.value?.default_pct ?? 0), updated_at: row[0]?.updated_at || null });
  } catch (e) { next(e); }
});

router.put('/settings/commission', async (req, res, next) => {
  try {
    const pct = Number(req.body?.default_pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 60) throw new AppError(400, 'INVALID', 'Commission must be between 0 and 60%.');
    const v = Math.round(pct * 100) / 100;
    await query(
      `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES ('commission', $1, NOW(), $2)
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW(), updated_by=$2`,
      [JSON.stringify({ default_pct: v }), req.user!.sub]);
    // Doctors on the default who accepted a different rate must accept again (old rate keeps applying until then)
    await query(`UPDATE doctors SET commission_status='pending'
                 WHERE commission_pct IS NULL AND commission_status='accepted' AND commission_accepted_pct <> $1`, [v]);
    sendSuccess(res, { default_pct: v });
  } catch (e) { next(e); }
});

router.put('/doctors/:id/commission', async (req, res, next) => {
  try {
    const raw = req.body?.pct;
    const pct = raw === null || raw === '' || raw === undefined ? null : Number(raw);
    if (pct !== null && (!Number.isFinite(pct) || pct < 0 || pct > 60)) throw new AppError(400, 'INVALID', 'Commission must be between 0 and 60%.');
    const rows = await query(
      `UPDATE doctors d SET commission_pct=$2,
         commission_status = CASE WHEN d.commission_accepted_pct IS NOT NULL
                                    AND d.commission_accepted_pct = COALESCE($2, (SELECT (value->>'default_pct')::numeric FROM platform_settings WHERE key='commission'))
                                  THEN 'accepted' ELSE 'pending' END,
         updated_at=NOW()
       WHERE d.id=$1 RETURNING d.id, d.commission_pct, d.commission_status`, [req.params.id, pct === null ? null : Math.round(pct * 100) / 100]) as any[];
    if (!rows.length) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');
    sendSuccess(res, rows[0]);
  } catch (e) { next(e); }
});

/* ── Verification workspace ────────────────────────────────────────── */

router.get('/review/doctors', async (req, res, next) => {
  try {
    const status = String(req.query.status || 'pending');
    const where = status === 'all' ? '' : status === 'pending' ? `WHERE d.profile_status IN ('pending','under_review')` : `WHERE d.profile_status = $1`;
    const params = status === 'all' || status === 'pending' ? [] : [status];
    const rows = await query(
      `SELECT d.id, u.full_name, u.email, d.medical_system, d.degree, d.specialization, d.city, d.reg_number, d.reg_body,
              d.practice_license_no, d.profile_status, d.commission_pct, d.commission_status, d.commission_accepted_pct,
              ${EFFECTIVE_PCT_SQL} AS offered_pct, d.register_check, d.created_at, d.updated_at,
              COALESCE((SELECT JSON_AGG(JSON_BUILD_OBJECT('document_type', dd.document_type)) FROM doctor_documents dd WHERE dd.doctor_id=d.id), '[]') AS documents
       FROM doctors d JOIN users u ON u.id = d.user_id ${where}
       ORDER BY d.updated_at DESC NULLS LAST LIMIT 200`, params) as any[];
    sendSuccess(res, rows.map(r => ({ ...r, offered_pct: Number(r.offered_pct), checklist: checklist(r, r.documents || []) })));
  } catch (e) { next(e); }
});

router.get('/review/doctors/:id', async (req, res, next) => {
  try { sendSuccess(res, await getDoctorForReview(req.params.id)); } catch (e) { next(e); }
});

router.post('/review/doctors/:id/register-check', async (req, res, next) => {
  try {
    const b = req.body || {};
    const check = {
      register: String(b.register || '').slice(0, 40),
      found: !!b.found, name_matches: !!b.name_matches, reg_number_matches: !!b.reg_number_matches,
      council_matches: !!b.council_matches, not_blacklisted: !!b.not_blacklisted,
      register_name: String(b.register_name || '').slice(0, 120),
      notes: String(b.notes || '').slice(0, 1000),
      checked_by: req.user!.sub, checked_at: new Date().toISOString(),
    };
    const rows = await query(`UPDATE doctors SET register_check=$2, profile_status = CASE WHEN profile_status='pending' THEN 'under_review' ELSE profile_status END, updated_at=NOW() WHERE id=$1 RETURNING id`,
      [req.params.id, JSON.stringify(check)]) as any[];
    if (!rows.length) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');
    sendSuccess(res, await getDoctorForReview(req.params.id));
  } catch (e) { next(e); }
});

router.post('/review/doctors/:id/decision', async (req, res, next) => {
  try {
    const { decision, reason } = req.body || {};
    if (!['approved', 'rejected'].includes(decision)) throw new AppError(400, 'INVALID_DECISION', 'Decision must be approved or rejected.');
    sendSuccess(res, await decide(req.params.id, req.user!.sub, decision, reason));
  } catch (e) { next(e); }
});

/* ── Overview ──────────────────────────────────────────────────────── */

router.get('/overview', async (_req, res, next) => {
  try {
    const [o] = await query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE role='patient')::int AS patients,
        (SELECT COUNT(*) FROM doctors WHERE profile_status='verified')::int AS verified_doctors,
        (SELECT COUNT(*) FROM doctors WHERE profile_status IN ('pending','under_review'))::int AS awaiting_review,
        (SELECT COUNT(*) FROM doctors WHERE commission_status='declined')::int AS declined_commission,
        (SELECT COUNT(*) FROM doctors WHERE profile_status='suspended')::int AS suspended_doctors,
        (SELECT COUNT(*) FROM appointments)::int AS appointments,
        (SELECT COUNT(*) FROM appointments WHERE status='completed')::int AS completed,
        (SELECT COALESCE(SUM(amount),0) FROM payments WHERE status='paid')::bigint AS revenue_paise,
        (SELECT COALESCE(SUM(p.amount * COALESCE(a.commission_pct,0) / 100),0)
           FROM appointments a JOIN payments p ON p.id = a.payment_id
          WHERE p.status='paid')::bigint AS commission_paise
    `) as any[];
    sendSuccess(res, o);
  } catch (e) { next(e); }
});

export default router;
