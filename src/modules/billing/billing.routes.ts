import { Router } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query, queryOne } from '../../config/database';
import { sendSuccess } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import {
  quote, checkoutFor, validSignature, confirmFromGateway, markPaid, refundAppointment, recordRefund,
  doctorBalance, getSettings, paymentsEnabled, REFUND_ETA,
} from './billing.service';

const router = Router();
const payLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: (req: any) => req.user?.sub || req.ip });

/* ── Patient ───────────────────────────────────────────────────────────── */

router.get('/quote', authenticate, async (req, res, next) => {
  try {
    const { doctor_id, consult_type } = req.query as any;
    if (!doctor_id || !consult_type) throw new AppError(400, 'MISSING_FIELDS', 'doctor_id and consult_type required.');
    sendSuccess(res, await quote(req.user!.sub, String(doctor_id), String(consult_type)));
  } catch (e) { next(e); }
});

// Re-open checkout for a held (unpaid) appointment
router.post('/appointments/:id/checkout', authenticate, authorize('patient'), payLimiter, async (req, res, next) => {
  try { sendSuccess(res, await checkoutFor(req.params.id, req.user!.sub)); } catch (e) { next(e); }
});

// Browser hands back Razorpay's response; the server verifies it with Razorpay before confirming.
router.post('/verify', authenticate, authorize('patient'), payLimiter, async (req, res, next) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) throw new AppError(400, 'MISSING_FIELDS', 'Payment details missing.');
    const own = await queryOne(`SELECT 1 FROM payments pay JOIN patients p ON p.id=pay.patient_id WHERE pay.razorpay_order_id=$1 AND p.user_id=$2`, [razorpay_order_id, req.user!.sub]);
    if (!own) throw new AppError(404, 'NOT_FOUND', 'Order not found.');
    if (!validSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) throw new AppError(400, 'INVALID_SIGNATURE', 'Payment could not be verified.');
    const r: any = await confirmFromGateway(razorpay_order_id, razorpay_payment_id, 'client');
    sendSuccess(res, { appointment_id: r.appointment_id, status: r.orphan ? 'refunded_slot_released' : 'paid',
      message: r.orphan ? `Payment received, but the slot had already been released. A full refund has been started (${REFUND_ETA}).` : 'Payment confirmed.' });
  } catch (e) { next(e); }
});

/* ── Razorpay webhook (signed, idempotent) ─────────────────────────────── */

router.post('/webhook', async (req: any, res, next) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) { res.status(503).json({ error: 'Webhook secret not configured' }); return; }
    const raw: Buffer = req.rawBody || Buffer.from(JSON.stringify(req.body));
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const got = String(req.headers['x-razorpay-signature'] || '');
    let ok = false; try { ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got)); } catch { ok = false; }
    if (!ok) { res.status(400).json({ error: 'Invalid signature' }); return; }

    const event = String(req.body?.event || '');
    const eventId = String(req.headers['x-razorpay-event-id'] || crypto.createHash('sha256').update(raw).digest('hex'));
    const ins = await query(`INSERT INTO payment_events (event_id, event, payload) VALUES ($1,$2,$3) ON CONFLICT (event_id) DO NOTHING RETURNING id`,
      [eventId, event, JSON.stringify(req.body)]) as any[];
    if (!ins.length) { res.json({ status: 'duplicate' }); return; }            // already handled

    try {
      const pay = req.body?.payload?.payment?.entity;
      const ref = req.body?.payload?.refund?.entity;
      if ((event === 'payment.captured' || event === 'order.paid') && pay?.order_id) {
        const known = await queryOne(`SELECT 1 FROM payments WHERE razorpay_order_id=$1`, [pay.order_id]);
        if (known) await markPaid(pay.order_id, pay.id, Number(pay.amount), 'webhook');
      } else if (event === 'payment.failed' && pay?.order_id) {
        await query(`UPDATE payments SET failure_reason=$2 WHERE razorpay_order_id=$1 AND status<>'paid'`, [pay.order_id, String(pay.error_description || 'Payment failed').slice(0, 300)]);
      } else if ((event === 'refund.processed' || event === 'refund.failed') && ref?.payment_id) {
        const p = await queryOne<any>(`SELECT id, appointment_id FROM payments WHERE razorpay_payment_id=$1`, [ref.payment_id]);
        if (p) {
          if (event === 'refund.processed') await recordRefund(p.id, p.appointment_id, ref.id, Number(ref.amount), 'processed');
          else {
            await query(`UPDATE payments SET refund_status='failed', refund_error='Gateway reported refund failure' WHERE id=$1`, [p.id]);
            await query(`UPDATE appointments SET payment_status='refund_failed' WHERE id=$1`, [p.appointment_id]);
          }
        }
      }
      await query(`UPDATE payment_events SET processed_at=NOW() WHERE event_id=$1`, [eventId]);
    } catch (err: any) {
      logger.error('Webhook handling failed', { event, error: err?.message });
      await query(`UPDATE payment_events SET error=$2 WHERE event_id=$1`, [eventId, String(err?.message || err).slice(0, 300)]);
    }
    res.json({ status: 'ok' });
  } catch (e) { next(e); }
});

/* ── Doctor ────────────────────────────────────────────────────────────── */

router.get('/doctor/balance', authenticate, authorize('doctor'), async (req, res, next) => {
  try { sendSuccess(res, await doctorBalance(req.user!.doctorId as string)); } catch (e) { next(e); }
});

/* ── Admin ─────────────────────────────────────────────────────────────── */

router.get('/admin/summary', authenticate, authorize('admin'), async (_req, res, next) => {
  try {
    const [l] = await query<any>(`
      SELECT COALESCE(SUM(amount_paise) FILTER (WHERE entry_type='payment_received'),0)::bigint AS collected,
             COALESCE(-SUM(amount_paise) FILTER (WHERE entry_type='refund'),0)::bigint AS refunded,
             COALESCE(SUM(amount_paise) FILTER (WHERE entry_type='platform_commission'),0)::bigint AS platform_net,
             COALESCE(SUM(amount_paise) FILTER (WHERE entry_type IN ('doctor_earning','doctor_earning_reversal')),0)::bigint AS doctor_earned,
             COALESCE(-SUM(amount_paise) FILTER (WHERE entry_type='payout'),0)::bigint AS paid_out
      FROM ledger_entries`);
    const [c] = await query<any>(`
      SELECT (SELECT COUNT(*) FROM payments WHERE refund_status='failed')::int AS refunds_failed,
             (SELECT COUNT(*) FROM payments WHERE refund_status='pending')::int AS refunds_pending,
             (SELECT COUNT(*) FROM sla_breaches WHERE breached_at > NOW() - INTERVAL '30 days')::int AS breaches_30d,
             (SELECT COUNT(*) FROM appointments WHERE status='pending_payment' AND hold_expires_at > NOW())::int AS awaiting_payment,
             (SELECT COUNT(*) FROM payment_events WHERE error IS NOT NULL)::int AS webhook_errors`);
    sendSuccess(res, {
      ...Object.fromEntries(Object.entries(l).map(([k, v]) => [k, Number(v)])), ...c,
      doctor_payable: Number(l.doctor_earned) - Number(l.paid_out),
      payments_enabled: paymentsEnabled(), webhook_configured: !!process.env.RAZORPAY_WEBHOOK_SECRET,
      settings: await getSettings(),
    });
  } catch (e) { next(e); }
});

router.put('/admin/settings', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const cur = await getSettings();
    const b = req.body || {};
    const num = (v: any, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
    const next_ = {
      tax_pct: num(b.tax_pct, 0, 28, cur.tax_pct),
      patient_full_refund_hours: num(b.patient_full_refund_hours, 0, 72, cur.patient_full_refund_hours),
      slot_hold_minutes: num(b.slot_hold_minutes, 5, 60, cur.slot_hold_minutes),
      instant_sla_minutes: num(b.instant_sla_minutes, 5, 60, cur.instant_sla_minutes),
      instant_escalate_minutes: num(b.instant_escalate_minutes, 1, 30, cur.instant_escalate_minutes),
    };
    await query(`INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES ('billing',$1,NOW(),$2)
                 ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW(), updated_by=$2`, [JSON.stringify(next_), req.user!.sub]);
    sendSuccess(res, next_);
  } catch (e) { next(e); }
});

router.get('/admin/refunds', authenticate, authorize('admin'), async (_req, res, next) => {
  try {
    sendSuccess(res, await query(
      `SELECT pay.id AS payment_id, pay.appointment_id, pay.amount, pay.refund_status, pay.refund_amount, pay.refund_reason,
              pay.refund_error, pay.refund_attempts, pay.refund_requested_at, pu.full_name AS patient_name, du.full_name AS doctor_name
       FROM payments pay JOIN patients p ON p.id=pay.patient_id JOIN users pu ON pu.id=p.user_id
       JOIN doctors d ON d.id=pay.doctor_id JOIN users du ON du.id=d.user_id
       WHERE pay.refund_status IS NOT NULL ORDER BY pay.refund_requested_at DESC NULLS LAST LIMIT 100`));
  } catch (e) { next(e); }
});

router.post('/admin/appointments/:id/refund', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const amount = req.body?.amount_paise != null ? Number(req.body.amount_paise) : undefined;
    const reason = String(req.body?.reason || 'Refund by admin');
    // Allow retry of a failed refund
    await query(`UPDATE payments SET refund_status=NULL WHERE appointment_id=$1 AND refund_status='failed'`, [req.params.id]);
    sendSuccess(res, await refundAppointment(req.params.id, { reason, by: 'admin', full: amount == null, amountPaise: amount }));
  } catch (e) { next(e); }
});

router.get('/admin/breaches', authenticate, authorize('admin'), async (_req, res, next) => {
  try {
    sendSuccess(res, await query(
      `SELECT b.*, du.full_name AS doctor_name, pu.full_name AS patient_name
       FROM sla_breaches b JOIN appointments a ON a.id=b.appointment_id
       JOIN patients p ON p.id=a.patient_id JOIN users pu ON pu.id=p.user_id
       LEFT JOIN doctors d ON d.id=b.doctor_id LEFT JOIN users du ON du.id=d.user_id
       ORDER BY b.breached_at DESC LIMIT 100`));
  } catch (e) { next(e); }
});

router.get('/admin/payables', authenticate, authorize('admin'), async (_req, res, next) => {
  try {
    sendSuccess(res, await query(
      `SELECT d.id AS doctor_id, u.full_name,
              COALESCE(SUM(l.amount_paise) FILTER (WHERE l.entry_type IN ('doctor_earning','doctor_earning_reversal')),0)::bigint AS earned,
              COALESCE(-SUM(l.amount_paise) FILTER (WHERE l.entry_type='payout'),0)::bigint AS paid_out
       FROM ledger_entries l JOIN doctors d ON d.id=l.doctor_id JOIN users u ON u.id=d.user_id
       GROUP BY d.id, u.full_name ORDER BY u.full_name`));
  } catch (e) { next(e); }
});

router.post('/admin/payouts', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { doctor_id, amount_paise, reference, note } = req.body || {};
    const amt = Math.round(Number(amount_paise));
    if (!doctor_id || !Number.isFinite(amt) || amt <= 0) throw new AppError(400, 'INVALID', 'Doctor and a positive amount are required.');
    const bal = await doctorBalance(doctor_id);
    if (amt > bal.balance_paise) throw new AppError(422, 'EXCEEDS_BALANCE', `Payout exceeds the doctor's balance of ₹${(bal.balance_paise / 100).toFixed(2)}.`);
    const [p] = await query<any>(`INSERT INTO doctor_payouts (doctor_id, amount_paise, reference, note, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [doctor_id, amt, String(reference || '').slice(0, 100) || null, String(note || '').slice(0, 300) || null, req.user!.sub]);
    await query(`INSERT INTO ledger_entries (idem_key, doctor_id, entry_type, amount_paise, note) VALUES ($1,$2,'payout',$3,$4)`,
      [`payout:${p.id}`, doctor_id, -amt, reference || 'Manual payout']);
    sendSuccess(res, { payout_id: p.id, ...(await doctorBalance(doctor_id)) });
  } catch (e) { next(e); }
});

export default router;
