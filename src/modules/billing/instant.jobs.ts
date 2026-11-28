import { query, queryOne } from '../../config/database';
import { redis } from '../../config/redis';
import { logger } from '../../utils/logger';
import { getSettings, refundAppointment, REFUND_ETA } from './billing.service';

/** Pass an unanswered instant request to another online, verified doctor of the same medical system. */
export async function escalate(appointmentId: string, why: 'timeout' | 'declined'): Promise<boolean> {
  const a = await queryOne<any>(
    `SELECT a.id, a.doctor_id, a.instant_tried, a.escalation_level, a.consult_type, d.medical_system, pu.full_name AS patient_name
     FROM appointments a JOIN doctors d ON d.id=a.doctor_id JOIN patients p ON p.id=a.patient_id JOIN users pu ON pu.id=p.user_id
     WHERE a.id=$1 AND a.status='booked' AND a.is_instant`, [appointmentId]);
  if (!a) return false;
  let online: string[] = [];
  try { if (redis.isOpen) online = (await redis.keys('doctor:online:*')).map((k: string) => k.replace('doctor:online:', '')); } catch { /* none */ }
  const tried: string[] = a.instant_tried || [];
  const candidates = online.filter(id => !tried.includes(id) && id !== a.doctor_id);
  let next: any = null;
  if (candidates.length) {
    next = await queryOne<any>(
      `SELECT d.id FROM doctors d JOIN users u ON u.id=d.user_id
       WHERE d.id = ANY($1::uuid[]) AND d.medical_system=$2 AND d.profile_status='verified' AND u.is_active
         AND EXISTS (SELECT 1 FROM consultation_fees f WHERE f.doctor_id=d.id AND f.consult_type=$3)
       ORDER BY d.avg_rating DESC NULLS LAST LIMIT 1`, [candidates, a.medical_system, a.consult_type]);
  }
  await query(`UPDATE appointments SET last_escalated_at=NOW(), escalation_level=escalation_level+1 WHERE id=$1`, [appointmentId]);
  if (!next) { logger.info('Instant escalation: no other doctor online', { appointmentId, why }); return false; }
  // The patient keeps the price they paid; the new doctor is credited that fee less their own accepted commission.
  await query(`UPDATE appointments SET doctor_id=$2, instant_tried=array_append(instant_tried, $2::uuid),
                 commission_pct=(SELECT COALESCE(commission_accepted_pct, commission_pct, (SELECT (value->>'default_pct')::numeric FROM platform_settings WHERE key='commission'), 0) FROM doctors WHERE id=$2)
               WHERE id=$1`, [appointmentId, next.id]);
  await query(`UPDATE payments SET doctor_id=$2 WHERE appointment_id=$1`, [appointmentId, next.id]);
  try {
    const { io } = await import('../chat/chat.gateway');
    io?.to(`doctor:${next.id}`).emit('instant_consult_incoming', { appointmentId, patientName: a.patient_name, consultType: a.consult_type, escalated: true });
  } catch { /* optional */ }
  logger.info('Instant request escalated', { appointmentId, from: a.doctor_id, to: next.id, why });
  return true;
}

/** Runs every minute. */
export async function runInstantJobs() {
  const s = await getSettings();

  // 1. Release unpaid slot holds
  await query(`UPDATE appointments SET status='cancelled', cancelled_by='system', cancellation_reason='Payment not completed in time', payment_status='expired'
               WHERE status='pending_payment' AND hold_expires_at < NOW()`);

  // 2. Escalate instant requests not accepted within the escalation window
  const toEscalate = await query<any>(
    `SELECT id FROM appointments WHERE is_instant AND status='booked' AND accepted_at IS NULL AND instant_deadline > NOW()
       AND COALESCE(last_escalated_at, paid_at, booked_at) < NOW() - ($1 || ' minutes')::interval`, [String(s.instant_escalate_minutes)]);
  for (const r of toEscalate) await escalate(r.id, 'timeout').catch(e => logger.error('escalate failed', { error: e?.message }));

  // 3. Breach: not accepted by the deadline → cancel, log, refund in full
  const breached = await query<any>(
    `SELECT a.id, a.doctor_id, a.instant_deadline, a.escalation_level, pu.email, pu.full_name
     FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN users pu ON pu.id=p.user_id
     WHERE a.is_instant AND a.status='booked' AND a.accepted_at IS NULL AND a.instant_deadline <= NOW()`);
  for (const b of breached) {
    try {
      await query(`UPDATE appointments SET status='cancelled', cancelled_by='system', cancellation_reason='No doctor responded within ${s.instant_sla_minutes} minutes' WHERE id=$1 AND status='booked'`, [b.id]);
      const refund = await refundAppointment(b.id, { reason: 'Instant consultation not answered in time', by: 'system', full: true });
      await query(`INSERT INTO sla_breaches (appointment_id, doctor_id, kind, deadline, escalation_level, refund_paise, refund_status)
                   VALUES ($1,$2,'instant_no_response',$3,$4,$5,$6) ON CONFLICT (appointment_id) DO NOTHING`,
        [b.id, b.doctor_id, b.instant_deadline, b.escalation_level, (refund as any).amount_paise ?? null, refund.status]);
      const { mailer } = await import('../../utils/mailer');
      await mailer.emails.send({ to: b.email, subject: 'Sorry — no doctor responded in time. Full refund started',
        html: `<p>Hi ${b.full_name},</p><p>No doctor accepted your instant consultation within ${s.instant_sla_minutes} minutes, so it was cancelled.</p>` +
              (refund.status === 'not_charged' ? '<p>You were not charged.</p>' : `<p>A full refund has been started. It usually reaches your account in ${REFUND_ETA}.</p>`) +
              '<p>If you feel unwell or worse, call 112 or visit the nearest hospital.</p>' });
      logger.warn('Instant SLA breach', { appointmentId: b.id, refund: refund.status });
    } catch (e: any) { logger.error('Breach handling failed', { appointmentId: b.id, error: e?.message }); }
  }
}

/** Runs every 30 minutes: retry failed refunds (up to 5 attempts). */
export async function retryFailedRefunds() {
  const rows = await query<any>(`SELECT appointment_id, refund_reason, refund_amount FROM payments WHERE refund_status='failed' AND refund_attempts < 5`);
  for (const r of rows) {
    await query(`UPDATE payments SET refund_status=NULL WHERE appointment_id=$1`, [r.appointment_id]);
    await refundAppointment(r.appointment_id, { reason: r.refund_reason || 'Retry', by: 'system', amountPaise: r.refund_amount != null ? Number(r.refund_amount) : undefined, full: r.refund_amount == null }).catch(() => {});
  }
}
