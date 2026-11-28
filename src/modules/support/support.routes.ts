import { Router } from 'express';
import crypto from 'crypto';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query, queryOne } from '../../config/database';
import { sendSuccess, sendCreated } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';
import { NotificationService } from '../notifications/notifications.service';
import { mailer } from '../../utils/mailer';
import { patientEmailSql } from '../family/family.service';

/* Feedback and complaints (grievances). Timelines follow the IT Rules 2021 / Consumer
   Protection (E-Commerce) Rules: acknowledge within 24 hours, resolve within 15 days. */

const router = Router();
router.use(authenticate);

export const CATEGORIES: Record<string, string> = {
  payment: 'Payment or refund',
  doctor: 'Doctor\'s behaviour or advice',
  no_show: 'Doctor didn\'t join / late',
  prescription: 'Prescription or care plan',
  technical: 'App or video problem',
  privacy: 'Privacy or my data',
  other: 'Something else',
};
const STATUSES = ['open', 'in_progress', 'waiting_on_user', 'resolved', 'closed'];
const esc = (v: any) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const me = (req: any) => req.user.actingOwner || req.user.sub;   // complaints belong to the account holder

async function loadFor(req: any, id: string) {
  const c = await queryOne<any>(`SELECT c.*, u.full_name AS user_name FROM complaints c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, [id]);
  if (!c) throw new AppError(404, 'NOT_FOUND', 'Complaint not found.');
  if (req.user.role !== 'admin' && c.user_id !== me(req)) throw new AppError(404, 'NOT_FOUND', 'Complaint not found.');
  return c;
}

async function tellUser(c: any, title: string, body: string) {
  const u = await queryOne<any>(`SELECT u.id, ${patientEmailSql('u')} AS email, u.fcm_token FROM users u WHERE u.id=$1`, [c.user_id]);
  if (!u) return;
  NotificationService.send({ userId: u.id, type: 'complaint', title, body, refType: 'complaint', refId: String(c.id), fcmToken: u.fcm_token }).catch(() => {});
  if (u.email) mailer.emails.send({ to: u.email, subject: `${title} [${c.ref}]`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;color:#334155"><h2 style="color:#0A7B6C">Deemona Doctors</h2><p><b>${esc(c.subject)}</b> (ref ${c.ref})</p><div style="white-space:pre-wrap">${esc(body)}</div><p>Open Help &amp; complaints in the app to reply.</p></div>` }).catch(() => {});
}

router.get('/categories', (_req, res) => sendSuccess(res, CATEGORIES));

router.post('/complaints', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!CATEGORIES[b.category]) throw new AppError(400, 'INVALID', 'Choose what the complaint is about.');
    const subject = String(b.subject || '').trim().slice(0, 150);
    const description = String(b.description || '').trim().slice(0, 4000);
    if (subject.length < 4 || description.length < 10) throw new AppError(400, 'MISSING_FIELDS', 'Add a short title and describe what happened.');
    let apptId: string | null = null;
    if (b.appointment_id) {
      const a = await queryOne<any>(
        `SELECT a.id FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN doctors d ON d.id=a.doctor_id
         WHERE a.id=$1 AND (p.user_id = ANY($2::uuid[]) OR d.user_id=$3)`,
        [b.appointment_id, [me(req), req.user!.sub], req.user!.sub]).catch(() => null);
      if (!a) throw new AppError(400, 'INVALID', 'That appointment is not yours.');
      apptId = a.id;
    }
    const open = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM complaints WHERE user_id=$1 AND status IN ('open','in_progress','waiting_on_user')`, [me(req)]);
    if ((open?.n || 0) >= 10) throw new AppError(429, 'TOO_MANY', 'You have 10 open complaints. Please wait for a reply on those first.');
    const ref = `DD-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const priority = ['privacy', 'payment'].includes(b.category) ? 'high' : 'normal';
    const row = await queryOne<any>(
      `INSERT INTO complaints (ref, user_id, role, appointment_id, category, subject, description, priority, ack_due_at, resolve_due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW() + INTERVAL '24 hours', NOW() + INTERVAL '15 days') RETURNING *`,
      [ref, me(req), req.user!.role, apptId, b.category, subject, description, priority]);
    tellUser(row, 'We received your complaint', `Thank you. Your reference is ${ref}. We will reply within 24 hours and aim to resolve it within 15 days.`).catch(() => {});
    sendCreated(res, row);
  } catch (e) { next(e); }
});

router.get('/complaints', async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT c.*, (SELECT COUNT(*)::int FROM complaint_messages m WHERE m.complaint_id=c.id) AS messages,
              (SELECT m.author_role FROM complaint_messages m WHERE m.complaint_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_author
       FROM complaints c WHERE c.user_id=$1 ORDER BY c.updated_at DESC`, [me(req)]);
    sendSuccess(res, rows);
  } catch (e) { next(e); }
});

router.get('/complaints/:id', async (req, res, next) => {
  try {
    const c = await loadFor(req, req.params.id);
    const messages = await query(`SELECT m.*, u.full_name AS author_name FROM complaint_messages m JOIN users u ON u.id=m.author_id WHERE m.complaint_id=$1 ORDER BY m.id`, [c.id]);
    sendSuccess(res, { ...c, category_label: CATEGORIES[c.category], messages });
  } catch (e) { next(e); }
});

router.post('/complaints/:id/messages', async (req, res, next) => {
  try {
    const c = await loadFor(req, req.params.id);
    const body = String(req.body?.body || '').trim().slice(0, 4000);
    if (!body) throw new AppError(400, 'MISSING_FIELDS', 'Write a message.');
    const isAdmin = req.user!.role === 'admin';
    if (!isAdmin && c.status === 'closed') throw new AppError(409, 'CLOSED', 'This complaint is closed. Please raise a new one.');
    await query('INSERT INTO complaint_messages (complaint_id, author_id, author_role, body) VALUES ($1,$2,$3,$4)', [c.id, req.user!.sub, isAdmin ? 'admin' : 'user', body]);
    const status = isAdmin ? (['open', 'waiting_on_user'].includes(c.status) || c.status === 'in_progress' ? 'in_progress' : c.status) : (['resolved', 'waiting_on_user'].includes(c.status) ? 'open' : c.status);
    await query(`UPDATE complaints SET status=$1, updated_at=NOW(), first_response_at = CASE WHEN $2 THEN COALESCE(first_response_at, NOW()) ELSE first_response_at END WHERE id=$3`, [status, isAdmin, c.id]);
    if (isAdmin) await tellUser(c, 'Reply to your complaint', body);
    sendSuccess(res, { ok: true, status });
  } catch (e) { next(e); }
});

// The user rates a resolved complaint, or reopens it.
router.post('/complaints/:id/close', async (req, res, next) => {
  try {
    const c = await loadFor(req, req.params.id);
    const rating = Number(req.body?.rating);
    if (req.body?.reopen) {
      await query(`UPDATE complaints SET status='open', resolved_at=NULL, updated_at=NOW() WHERE id=$1`, [c.id]);
      return sendSuccess(res, { status: 'open' });
    }
    await query(`UPDATE complaints SET status='closed', rating=$1, updated_at=NOW(), resolved_at=COALESCE(resolved_at, NOW()) WHERE id=$2`,
      [rating >= 1 && rating <= 5 ? Math.round(rating) : null, c.id]);
    sendSuccess(res, { status: 'closed' });
  } catch (e) { next(e); }
});

router.post('/feedback', async (req, res, next) => {
  try {
    const score = Number(req.body?.score);
    if (!(score >= 0 && score <= 10)) throw new AppError(400, 'INVALID', 'Choose a score from 0 to 10.');
    await query('INSERT INTO app_feedback (user_id, role, score, comment, page) VALUES ($1,$2,$3,$4,$5)',
      [me(req), req.user!.role, Math.round(score), req.body?.comment ? String(req.body.comment).slice(0, 2000) : null, req.body?.page ? String(req.body.page).slice(0, 60) : null]);
    sendCreated(res, { thanks: true });
  } catch (e) { next(e); }
});

/* ── Admin ── */

router.get('/admin/complaints', authorize('admin'), async (req, res, next) => {
  try {
    const st = String(req.query.status || 'active');
    const where = st === 'all' ? 'TRUE' : st === 'active' ? `c.status IN ('open','in_progress','waiting_on_user')` : STATUSES.includes(st) ? `c.status='${st}'` : 'TRUE';
    const rows = await query(
      `SELECT c.*, u.full_name AS user_name,
              (c.first_response_at IS NULL AND c.ack_due_at < NOW()) AS ack_overdue,
              (c.status NOT IN ('resolved','closed') AND c.resolve_due_at < NOW()) AS resolve_overdue
       FROM complaints c JOIN users u ON u.id=c.user_id WHERE ${where}
       ORDER BY (c.status NOT IN ('resolved','closed')) DESC, c.priority='high' DESC, c.created_at LIMIT 300`);
    const [sum] = await query<any>(
      `SELECT COUNT(*) FILTER (WHERE status IN ('open','in_progress','waiting_on_user'))::int AS active,
              COUNT(*) FILTER (WHERE first_response_at IS NULL AND ack_due_at < NOW() AND status NOT IN ('resolved','closed'))::int AS ack_overdue,
              COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed') AND resolve_due_at < NOW())::int AS resolve_overdue,
              ROUND(AVG(rating) FILTER (WHERE rating IS NOT NULL), 1) AS avg_rating
       FROM complaints`);
    const [fb] = await query<any>(
      `SELECT COUNT(*)::int AS responses,
              ROUND(100.0 * (COUNT(*) FILTER (WHERE score >= 9) - COUNT(*) FILTER (WHERE score <= 6)) / NULLIF(COUNT(*), 0)) AS nps
       FROM app_feedback WHERE created_at > NOW() - INTERVAL '90 days'`);
    const comments = await query(`SELECT f.score, f.comment, f.role, f.created_at FROM app_feedback f WHERE f.comment IS NOT NULL ORDER BY f.id DESC LIMIT 20`);
    sendSuccess(res, { complaints: rows, summary: sum, feedback: { ...fb, comments }, categories: CATEGORIES });
  } catch (e) { next(e); }
});

router.patch('/admin/complaints/:id', authorize('admin'), async (req, res, next) => {
  try {
    const c = await loadFor(req, req.params.id);
    const status = STATUSES.includes(req.body?.status) ? req.body.status : c.status;
    const priority = ['low', 'normal', 'high'].includes(req.body?.priority) ? req.body.priority : c.priority;
    await query(`UPDATE complaints SET status=$1, priority=$2, updated_at=NOW(),
                   resolved_at = CASE WHEN $1 IN ('resolved','closed') THEN COALESCE(resolved_at, NOW()) ELSE NULL END,
                   first_response_at = COALESCE(first_response_at, CASE WHEN $1 <> 'open' THEN NOW() END)
                 WHERE id=$3`, [status, priority, c.id]);
    if (status !== c.status && status === 'resolved') await tellUser(c, 'Your complaint is resolved', 'We have marked your complaint as resolved. If it isn\'t, reopen it from Help & complaints.');
    sendSuccess(res, { status, priority });
  } catch (e) { next(e); }
});

export default router;
