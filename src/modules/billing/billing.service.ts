import { patientEmailSql } from '../family/family.service';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { query, queryOne, withTransaction } from '../../config/database';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';

/* ─────────────────────────────────────────────────────────────────────────────
   Billing engine. All money is in PAISE (integers).
   Lifecycle: quote → hold slot (pending_payment) → Razorpay order → server-side
   confirmation (signature + gateway fetch, or signed webhook) → booked →
   confirmed by doctor → completed → doctor earning credited → payout.
   Every money movement is a ledger row with a unique idempotency key, so
   retries and duplicate webhooks never double-count.
   ───────────────────────────────────────────────────────────────────────────── */

export type Settings = { tax_pct: number; patient_full_refund_hours: number; slot_hold_minutes: number; instant_sla_minutes: number; instant_escalate_minutes: number;
  gold_video_credits: number; gold_chat_credits: number; diamond_video_credits: number; diamond_chat_credits: number };
const DEFAULTS: Settings = { tax_pct: 0, patient_full_refund_hours: 2, slot_hold_minutes: 15, instant_sla_minutes: 15, instant_escalate_minutes: 5,
  gold_video_credits: 1, gold_chat_credits: 2, diamond_video_credits: 3, diamond_chat_credits: 5 };
const PLAN_DISCOUNT: Record<string, number> = { gold: 10, diamond: 25 };
export const REFUND_ETA = '5–7 business days';

/** node-postgres returns DATE columns as JS Dates at local midnight; turn either form into YYYY-MM-DD. */
export function dateStr(v: any): string {
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
}

export async function getSettings(): Promise<Settings> {
  const row = await queryOne<{ value: any }>(`SELECT value FROM platform_settings WHERE key='billing'`);
  return { ...DEFAULTS, ...(row?.value || {}) };
}

export function paymentsEnabled() {
  const id = process.env.RAZORPAY_KEY_ID, secret = process.env.RAZORPAY_KEY_SECRET;
  return process.env.PAYMENTS_ENABLED === 'true' && !!id && !!secret && id !== 'placeholder';
}

let rzp: any = null;
function gateway() {
  if (!paymentsEnabled()) throw new AppError(503, 'PAYMENTS_DISABLED', 'Online payments are not enabled yet.');
  if (!rzp) rzp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID!, key_secret: process.env.RAZORPAY_KEY_SECRET! });
  return rzp;
}

/* ── Quote ──────────────────────────────────────────────────────────────── */

export async function baseFeePaise(doctorId: string, consultType: string): Promise<number> {
  const own = await queryOne<{ fee_amount: number }>(
    'SELECT fee_amount FROM consultation_fees WHERE doctor_id=$1 AND consult_type=$2', [doctorId, consultType]);
  if (own?.fee_amount != null) return Math.round(Number(own.fee_amount));               // stored in paise
  const doc = await queryOne<{ medical_system: string }>('SELECT medical_system FROM doctors WHERE id=$1', [doctorId]);
  if (doc) {
    const pf = await queryOne<{ fee: number }>('SELECT fee FROM platform_fees WHERE medical_system=$1 AND consult_type=$2', [doc.medical_system, consultType]);
    if (pf?.fee != null) return Math.round(Number(pf.fee) * 100);                       // platform fees are in rupees
  }
  throw new AppError(400, 'NO_FEE_SET', 'This doctor has not set a fee for this consultation type.');
}

export async function quote(userId: string, doctorId: string, consultType: string) {
  const s = await getSettings();
  const fee = await baseFeePaise(doctorId, consultType);
  // Family members share the account holder's plan.
  const { ownerOf } = await import('../family/family.service');
  const planUser = await ownerOf(userId);
  const sub = await queryOne<{ plan: string }>(
    `SELECT plan FROM subscriptions WHERE user_id=$1 AND status='active' AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [planUser]).catch(() => null);
  const plan = sub?.plan || 'free';
  // Included free consultations (only when online payments are on: otherwise every booking is already free).
  const credit = paymentsEnabled() ? await planCredit(userId, plan, consultType, s) : { allowed: 0, used: 0 };
  const creditApplied = credit.allowed > credit.used;
  const pct = creditApplied ? 100 : (PLAN_DISCOUNT[plan] || 0);
  const discount = Math.round(fee * pct / 100);
  const tax = Math.round((fee - discount) * (Number(s.tax_pct) || 0) / 100);
  return {
    fee_paise: fee, discount_paise: discount, discount_pct: pct, plan,
    credit_applied: creditApplied, credits_left: Math.max(0, credit.allowed - credit.used - (creditApplied ? 1 : 0)), credits_allowed: credit.allowed,
    tax_paise: tax, tax_pct: Number(s.tax_pct) || 0, total_paise: fee - discount + tax, currency: 'INR',
    payments_enabled: paymentsEnabled(),
  };
}

/** Free consultations a plan includes this calendar month (IST) for this consult type, and how many are used. */
export async function planCredit(userId: string, plan: string, consultType: string, s?: Settings, client?: any) {
  s = s || await getSettings();
  const allowed = Number((s as any)[`${plan}_${consultType}_credits`] || 0);
  if (!allowed) return { allowed: 0, used: 0 };
  // Free consultations are shared across the family on one plan.
  const { ownerOf, familyUserIds } = await import('../family/family.service');
  const ids = await familyUserIds(await ownerOf(userId));
  const sql = `SELECT COUNT(*)::int AS n FROM appointments a JOIN patients p ON p.id=a.patient_id
               WHERE p.user_id = ANY($1::uuid[]) AND a.plan_credit AND a.consult_type=$2 AND a.status NOT IN ('cancelled')
                 AND date_trunc('month', a.created_at AT TIME ZONE 'Asia/Kolkata') = date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata')`;
  const r = client ? (await client.query(sql, [ids, consultType])).rows[0] : await queryOne<{ n: number }>(sql, [ids, consultType]);
  return { allowed, used: Number(r?.n || 0) };
}

/* ── Orders & checkout ──────────────────────────────────────────────────── */

export async function checkoutFor(appointmentId: string, userId: string) {
  const a = await queryOne<any>(
    `SELECT a.id, a.status, a.amount_paise, a.payment_status, a.hold_expires_at, a.payment_id,
            pu.full_name, ${patientEmailSql('pu')} AS email, pu.phone, du.full_name AS doctor_name
     FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN users pu ON pu.id=p.user_id
     JOIN doctors d ON d.id=a.doctor_id JOIN users du ON du.id=d.user_id
     WHERE a.id=$1 AND p.user_id=$2`, [appointmentId, userId]);
  if (!a) throw new AppError(404, 'NOT_FOUND', 'Appointment not found.');
  if (a.status !== 'pending_payment') throw new AppError(409, 'NOT_PAYABLE', 'This appointment no longer needs payment.');
  if (a.hold_expires_at && new Date(a.hold_expires_at) < new Date()) throw new AppError(410, 'HOLD_EXPIRED', 'The time to pay for this slot has run out. Please book again.');

  let pay = a.payment_id ? await queryOne<any>('SELECT id, razorpay_order_id, status FROM payments WHERE id=$1', [a.payment_id]) : null;
  if (pay?.status === 'paid') throw new AppError(409, 'ALREADY_PAID', 'This appointment is already paid.');
  if (!pay?.razorpay_order_id) {
    const order = await gateway().orders.create({
      amount: Number(a.amount_paise), currency: 'INR', receipt: `appt_${a.id.slice(0, 30)}`,
      notes: { appointment_id: a.id }, payment_capture: 1,
    });
    await query('UPDATE payments SET razorpay_order_id=$1 WHERE id=$2', [order.id, a.payment_id]);
    pay = { ...pay, razorpay_order_id: order.id };
  }
  return {
    required: true, key: process.env.RAZORPAY_KEY_ID, order_id: pay.razorpay_order_id, amount: Number(a.amount_paise), currency: 'INR',
    name: 'Deemona Doctors', description: `Consultation with ${a.doctor_name}`,
    prefill: { name: a.full_name, email: a.email, contact: a.phone || undefined },
    appointment_id: a.id, hold_expires_at: a.hold_expires_at,
  };
}

/** Creates the appointment's payment row and applies the quote. Called inside the booking transaction. */
export async function attachPayment(client: any, appt: { id: string; patient_id: string; doctor_id: string }, q: Awaited<ReturnType<typeof quote>>) {
  const s = await getSettings();
  const requires = q.payments_enabled && q.total_paise > 0;
  const [pay] = (await client.query(
    `INSERT INTO payments (appointment_id, patient_id, doctor_id, amount, currency, gateway, status)
     VALUES ($1,$2,$3,$4,'INR','razorpay',$5) RETURNING id`,
    [appt.id, appt.patient_id, appt.doctor_id, q.total_paise, requires ? 'pending' : 'not_required'])).rows;
  await client.query(
    `UPDATE appointments SET payment_id=$2, fee=$9, fee_paise=$3, discount_paise=$4, tax_paise=$5, amount_paise=$6,
            payment_status=$7, hold_expires_at=$8, plan_credit=$10 WHERE id=$1`,
    [appt.id, pay.id, q.fee_paise, q.discount_paise, q.tax_paise, q.total_paise,
     requires ? 'unpaid' : 'not_required', requires ? new Date(Date.now() + s.slot_hold_minutes * 60000) : null, q.fee_paise, !!q.credit_applied]);
  return { payment_id: pay.id, requires };
}

/* ── Payment confirmation (client verify OR webhook) ─────────────────────── */

export function validSignature(orderId: string, paymentId: string, signature: string) {
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '').update(`${orderId}|${paymentId}`).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature))); } catch { return false; }
}

/** Server-side confirmation: never trusts the browser. Fetches the payment from Razorpay, checks order + amount, captures if needed. */
export async function confirmFromGateway(orderId: string, paymentId: string, via: 'client' | 'webhook') {
  const p = await gateway().payments.fetch(paymentId);
  if (p.order_id !== orderId) throw new AppError(400, 'ORDER_MISMATCH', 'Payment does not belong to this order.');
  if (p.status === 'authorized') {
    await gateway().payments.capture(paymentId, p.amount, p.currency);
    p.status = 'captured';
  }
  if (p.status !== 'captured') throw new AppError(402, 'NOT_CAPTURED', `Payment is ${p.status}.`);
  return markPaid(orderId, paymentId, Number(p.amount), via);
}

export async function markPaid(orderId: string, paymentId: string, amountPaise: number, via: string) {
  const outcome = await withTransaction(async (client: any) => {
    const [pay] = (await client.query(`SELECT * FROM payments WHERE razorpay_order_id=$1 FOR UPDATE`, [orderId])).rows;
    if (!pay) throw new AppError(404, 'NOT_FOUND', 'Unknown order.');
    if (pay.status === 'paid') return { already: true, appointment_id: pay.appointment_id };            // idempotent
    if (Number(pay.amount) !== amountPaise) throw new AppError(400, 'AMOUNT_MISMATCH', 'Paid amount does not match.');
    await client.query(`UPDATE payments SET status='paid', razorpay_payment_id=$2, paid_at=NOW(), confirmed_via=$3 WHERE id=$1`, [pay.id, paymentId, via]);
    await client.query(
      `INSERT INTO ledger_entries (idem_key, appointment_id, payment_id, doctor_id, entry_type, amount_paise, note)
       VALUES ($1,$2,$3,$4,'payment_received',$5,$6) ON CONFLICT (idem_key) DO NOTHING`,
      [`paid:${pay.id}`, pay.appointment_id, pay.id, pay.doctor_id, amountPaise, `Razorpay ${paymentId}`]);

    const [a] = (await client.query(`SELECT * FROM appointments WHERE id=$1 FOR UPDATE`, [pay.appointment_id])).rows;
    const s = await getSettings();
    if (a && a.status === 'pending_payment') {
      await client.query(
        `UPDATE appointments SET status='booked', payment_status='paid', paid_at=NOW(), booked_at=NOW(),
                instant_deadline = CASE WHEN is_instant THEN NOW() + ($2 || ' minutes')::interval ELSE NULL END
         WHERE id=$1`, [a.id, String(s.instant_sla_minutes)]);
      return { booked: true, appointment_id: a.id, is_instant: a.is_instant };
    }
    // Paid, but the booking is gone (hold expired / cancelled): keep the money record and refund in full.
    await client.query(`UPDATE appointments SET payment_status='paid' WHERE id=$1`, [pay.appointment_id]);
    return { orphan: true, appointment_id: pay.appointment_id };
  });

  if ((outcome as any).orphan) {
    logger.warn('Payment received for a booking that no longer exists — refunding', { orderId });
    await refundAppointment((outcome as any).appointment_id, { reason: 'Payment received after the slot was released', by: 'system', full: true });
  }
  if ((outcome as any).booked) setImmediate(() => notifyBooked((outcome as any).appointment_id).catch(() => {}));
  return outcome;
}

async function notifyBooked(appointmentId: string) {
  const a = await queryOne<any>(
    `SELECT a.id, a.is_instant, a.consult_type, a.appt_date, a.appt_time, a.instant_deadline, a.doctor_id,
            pu.full_name AS patient_name, ${patientEmailSql('pu')} AS patient_email, du.full_name AS doctor_name, du.email AS doctor_email
     FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN users pu ON pu.id=p.user_id
     JOIN doctors d ON d.id=a.doctor_id JOIN users du ON du.id=d.user_id WHERE a.id=$1`, [appointmentId]);
  if (!a) return;
  if (a.is_instant) {
    try {
      const { io } = await import('../chat/chat.gateway');
      io?.to(`doctor:${a.doctor_id}`).emit('instant_consult_incoming', {
        appointmentId: a.id, patientName: a.patient_name, consultType: a.consult_type, deadline: a.instant_deadline,
      });
    } catch { /* socket optional */ }
  }
  const { mailer } = await import('../../utils/mailer');
  const when = a.is_instant ? 'now (instant consultation)' : `${dateStr(a.appt_date)} at ${String(a.appt_time).slice(0, 5)}`;
  await mailer.emails.send({ to: a.doctor_email, subject: a.is_instant ? 'Instant consultation request — respond within 15 minutes' : 'New paid appointment — please confirm',
    html: `<p>Hi ${a.doctor_name},</p><p>${a.patient_name} has paid for a ${a.consult_type} consultation ${when}. Please open Deemona Doctors to ${a.is_instant ? 'accept it' : 'confirm it'}.</p>` });
  await mailer.emails.send({ to: a.patient_email, subject: 'Payment received — Deemona Doctors',
    html: `<p>Hi ${a.patient_name},</p><p>Your payment for the ${a.consult_type} consultation with ${a.doctor_name} (${when}) was received.</p>` });
}

/* ── Refunds ────────────────────────────────────────────────────────────── */

export async function refundAppointment(appointmentId: string, opts: { reason: string; by: string; full?: boolean; amountPaise?: number }) {
  const a = await queryOne<any>(`SELECT a.id, a.payment_id, a.amount_paise FROM appointments a WHERE a.id=$1`, [appointmentId]);
  if (!a?.payment_id) return { status: 'not_charged' };
  const pay = await queryOne<any>(`SELECT * FROM payments WHERE id=$1`, [a.payment_id]);
  if (!pay || pay.status !== 'paid') {
    await query(`UPDATE appointments SET payment_status=CASE WHEN payment_status='unpaid' THEN 'not_charged' ELSE payment_status END WHERE id=$1`, [appointmentId]);
    return { status: 'not_charged' };
  }
  if (['processed', 'pending'].includes(pay.refund_status)) return { status: pay.refund_status, amount_paise: Number(pay.refund_amount) };  // idempotent
  const amount = Math.min(Number(pay.amount), opts.full || opts.amountPaise == null ? Number(pay.amount) : Math.round(opts.amountPaise));
  if (amount <= 0) return { status: 'none' };

  await query(`UPDATE payments SET refund_status='pending', refund_amount=$2, refund_reason=$3, refund_requested_at=COALESCE(refund_requested_at, NOW()), refund_attempts=refund_attempts+1 WHERE id=$1`,
    [pay.id, amount, opts.reason.slice(0, 300)]);
  await query(`UPDATE appointments SET payment_status='refund_pending' WHERE id=$1`, [appointmentId]);
  try {
    const r = await gateway().payments.refund(pay.razorpay_payment_id, { amount, speed: 'normal', notes: { appointment_id: appointmentId, reason: opts.reason.slice(0, 200), by: opts.by } });
    await recordRefund(pay.id, appointmentId, r.id, amount, r.status === 'processed' ? 'processed' : 'pending');
    return { status: r.status === 'processed' ? 'processed' : 'pending', amount_paise: amount, eta: REFUND_ETA };
  } catch (e: any) {
    const msg = e?.error?.description || e?.message || 'Refund failed';
    logger.error('Refund failed', { appointmentId, error: msg });
    await query(`UPDATE payments SET refund_status='failed', refund_error=$2 WHERE id=$1`, [pay.id, msg.slice(0, 300)]);
    await query(`UPDATE appointments SET payment_status='refund_failed' WHERE id=$1`, [appointmentId]);
    return { status: 'failed', amount_paise: amount, error: msg };
  }
}

export async function recordRefund(paymentId: string, appointmentId: string, refundId: string, amount: number, status: 'pending' | 'processed') {
  await query(`UPDATE payments SET refund_status=$2, refund_id=$3, refund_error=NULL, refunded_at=CASE WHEN $2='processed' THEN NOW() ELSE refunded_at END,
                 status=CASE WHEN $2='processed' THEN 'refunded' ELSE status END WHERE id=$1`, [paymentId, status, refundId]);
  await query(`UPDATE appointments SET payment_status=$2 WHERE id=$1`, [appointmentId, status === 'processed' ? 'refunded' : 'refund_pending']);
  await query(`INSERT INTO ledger_entries (idem_key, appointment_id, payment_id, entry_type, amount_paise, note)
               VALUES ($1,$2,$3,'refund',$4,$5) ON CONFLICT (idem_key) DO NOTHING`, [`refund:${paymentId}`, appointmentId, paymentId, -amount, refundId]);
  // If the doctor was already credited for this appointment, reverse it.
  const earned = await queryOne<{ amount_paise: number; doctor_id: string }>(`SELECT amount_paise, doctor_id FROM ledger_entries WHERE idem_key=$1`, [`earning:${appointmentId}`]);
  if (earned) {
    await query(`INSERT INTO ledger_entries (idem_key, appointment_id, doctor_id, entry_type, amount_paise, note)
                 VALUES ($1,$2,$3,'doctor_earning_reversal',$4,'Refunded after completion') ON CONFLICT (idem_key) DO NOTHING`,
      [`earning-reversal:${appointmentId}`, appointmentId, earned.doctor_id, -Number(earned.amount_paise)]);
  }
}

/* ── Doctor earnings on completion ──────────────────────────────────────── */

export async function creditDoctor(appointmentId: string) {
  const a = await queryOne<any>(
    `SELECT a.id, a.doctor_id, a.fee_paise, a.amount_paise, a.tax_paise, a.commission_pct, a.payment_status, a.plan_credit FROM appointments a WHERE a.id=$1`, [appointmentId]);
  // Paid consultations, and free plan consultations (the platform pays the doctor for those).
  if (!a || a.fee_paise == null || !(a.payment_status === 'paid' || (a.plan_credit && a.payment_status === 'not_required'))) return null;
  const pct = Number(a.commission_pct || 0);
  // The doctor earns their fee minus the commission they accepted. Plan discounts are absorbed by the platform.
  const payable = Math.round(Number(a.fee_paise) * (1 - pct / 100));
  const platform = Number(a.amount_paise) - Number(a.tax_paise || 0) - payable;
  await query(`INSERT INTO ledger_entries (idem_key, appointment_id, doctor_id, entry_type, amount_paise, note)
               VALUES ($1,$2,$3,'doctor_earning',$4,$5) ON CONFLICT (idem_key) DO NOTHING`,
    [`earning:${a.id}`, a.id, a.doctor_id, payable, `Fee ${a.fee_paise} less ${pct}% commission`]);
  await query(`INSERT INTO ledger_entries (idem_key, appointment_id, doctor_id, entry_type, amount_paise, note)
               VALUES ($1,$2,$3,'platform_commission',$4,'Net to platform after discount') ON CONFLICT (idem_key) DO NOTHING`,
    [`commission:${a.id}`, a.id, a.doctor_id, platform]);
  return { payable, platform };
}

export async function doctorBalance(doctorId: string) {
  const [r] = await query<any>(
    `SELECT COALESCE(SUM(amount_paise) FILTER (WHERE entry_type IN ('doctor_earning','doctor_earning_reversal')),0)::bigint AS earned,
            COALESCE(SUM(amount_paise) FILTER (WHERE entry_type='payout'),0)::bigint AS paid_out
     FROM ledger_entries WHERE doctor_id=$1`, [doctorId]);
  return { earned_paise: Number(r.earned), paid_out_paise: -Number(r.paid_out), balance_paise: Number(r.earned) + Number(r.paid_out) };
}

/* ── Cancellation policy ────────────────────────────────────────────────── */

export async function cancelWithPolicy(appointmentId: string, actor: { role: string; userId: string; doctorId?: string }, reason?: string) {
  const a = await queryOne<any>(
    `SELECT a.*, p.user_id AS patient_user_id FROM appointments a JOIN patients p ON p.id=a.patient_id WHERE a.id=$1`, [appointmentId]);
  if (!a) throw new AppError(404, 'NOT_FOUND', 'Appointment not found.');
  if (actor.role === 'patient' && a.patient_user_id !== actor.userId) throw new AppError(403, 'FORBIDDEN', 'Not your appointment.');
  if (actor.role === 'doctor' && a.doctor_id !== actor.doctorId) throw new AppError(403, 'FORBIDDEN', 'Not your appointment.');
  if (['completed', 'cancelled', 'no_show'].includes(a.status)) throw new AppError(422, 'CANNOT_CANCEL', 'This appointment cannot be cancelled.');

  const s = await getSettings();
  let full = true, note = 'Full refund';
  if (actor.role === 'patient' && a.status === 'confirmed') {
    const start = new Date(`${dateStr(a.appt_date)}T${String(a.appt_time).slice(0, 8)}+05:30`).getTime();
    const hours = (start - Date.now()) / 3600000;
    if (a.is_instant || hours < s.patient_full_refund_hours) { full = false; note = `No refund: cancelled less than ${s.patient_full_refund_hours} hours before a confirmed consultation`; }
  }
  await query(`UPDATE appointments SET status='cancelled', cancelled_by=$2, cancellation_reason=$3, cancel_reason=$3, updated_at=NOW() WHERE id=$1`,
    [appointmentId, actor.role, (reason || '').slice(0, 300) || null]).catch(async () => {
      await query(`UPDATE appointments SET status='cancelled', cancelled_by=$2, cancellation_reason=$3 WHERE id=$1`, [appointmentId, actor.role, (reason || '').slice(0, 300) || null]);
    });
  const refund = full ? await refundAppointment(appointmentId, { reason: `Cancelled by ${actor.role}${reason ? `: ${reason}` : ''}`, by: actor.role, full: true })
                      : { status: 'none', note };
  return { appointment_id: appointmentId, status: 'cancelled', refund, policy: note, refund_eta: full ? REFUND_ETA : null };
}
