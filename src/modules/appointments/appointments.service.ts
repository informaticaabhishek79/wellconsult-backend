import { patientEmailSql } from '../family/family.service';
import { query, queryOne, withTransaction } from '../../config/database';
import { AppError } from '../../middleware/errorHandler';
import { getPagination } from '../../utils/pagination';
import { Request } from 'express';
import Razorpay from 'razorpay';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { mailer as resend } from '../../utils/mailer';

const razorpay = new Razorpay({
  key_id:     env.razorpay.keyId     || 'placeholder',
  key_secret: env.razorpay.keySecret || 'placeholder',
});


async function sendAppointmentEmail(params: {
  to: string; name: string; role: 'patient' | 'doctor';
  doctorName: string; patientName: string;
  date: string; time: string; type: string;
  isEmergency?: boolean; action: 'booked' | 'cancelled' | 'confirmed';
}) {
  if (!process.env.RESEND_API_KEY) return;
  const { to, name, role, doctorName, patientName, date, time, type, isEmergency, action } = params;

  const subjects: Record<string, string> = {
    booked:    isEmergency ? 'Emergency consultation booked — Deemona Doctors' : 'Appointment confirmed — Deemona Doctors',
    cancelled: 'Appointment cancelled — Deemona Doctors',
    confirmed: 'Appointment confirmed by doctor — Deemona Doctors',
  };

  const actionText: Record<string, string> = {
    booked:    'has been successfully booked',
    cancelled: 'has been cancelled',
    confirmed: 'has been confirmed by the doctor',
  };

  try {
    await resend.emails.send({
      from: 'Deemona Doctors <noreply@mail.deemona.com>',
      to,
      subject: subjects[action],
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#fff">
          <div style="margin-bottom:24px">
            <span style="font-size:20px;font-weight:800;color:#1A1A18">Deemona <span style="color:#0A7B6C">Doctors</span></span>
          </div>
          ${isEmergency ? '<div style="background:#FEE2E2;border-radius:8px;padding:10px 16px;margin-bottom:16px;font-weight:700;color:#991B1B">⚡ Emergency consultation</div>' : ''}
          <h2 style="font-size:22px;font-weight:800;color:#1A1A18;margin:0 0 8px">
            Hi ${name}, your appointment ${actionText[action]}.
          </h2>
          <div style="background:#F8F7F4;border-radius:12px;padding:20px;margin:20px 0">
            <table style="width:100%;border-collapse:collapse">
              ${role === 'patient'
                ? `<tr><td style="color:#73726C;padding:6px 0;font-size:13px">Doctor</td><td style="font-weight:700;font-size:13px">${doctorName}</td></tr>`
                : `<tr><td style="color:#73726C;padding:6px 0;font-size:13px">Patient</td><td style="font-weight:700;font-size:13px">${patientName}</td></tr>`
              }
              <tr><td style="color:#73726C;padding:6px 0;font-size:13px">Date</td><td style="font-weight:700;font-size:13px">${date}</td></tr>
              <tr><td style="color:#73726C;padding:6px 0;font-size:13px">Time</td><td style="font-weight:700;font-size:13px">${time}</td></tr>
              <tr><td style="color:#73726C;padding:6px 0;font-size:13px">Type</td><td style="font-weight:700;font-size:13px;text-transform:capitalize">${type}</td></tr>
            </table>
          </div>
        </div>
      `,
    });
    logger.info('Appointment email sent', { to, action });
  } catch (err) {
    logger.error('Resend appointment email failed', { error: (err as Error).message });
  }
}


export const AppointmentsService = {
  async book(patientId: string, body: {
    doctor_id: string; appt_date: string; appt_time: string;
    consult_type: string; payment_method?: string; is_emergency?: boolean;
  }, opts: { instant?: boolean } = {}) {
    // Emergency booking was removed: emergencies are directed to 112 and in-person care.
    if (body.is_emergency) {
      throw new AppError(422, 'EMERGENCY_NOT_SUPPORTED', 'For a medical emergency call 112 or go to the nearest emergency department. Online consultations are not for emergencies.');
    }
    const consultType = ['video', 'phone', 'chat', 'clinic'].includes(body.consult_type) ? body.consult_type : 'video';
    const doctor = await queryOne<{ id: string }>(
      `SELECT d.id FROM doctors d JOIN users u ON u.id=d.user_id WHERE d.id=$1 AND d.profile_status='verified' AND u.is_active=TRUE`, [body.doctor_id]);
    if (!doctor) throw new AppError(404, 'DOCTOR_UNAVAILABLE', 'This doctor is not available for booking.');
    const patient = await queryOne<{ user_id: string }>('SELECT user_id FROM patients WHERE id=$1', [patientId]);
    if (!patient) throw new AppError(404, 'NOT_FOUND', 'Patient profile not found.');

    if (!opts.instant) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.appt_date)) || !/^\d{2}:\d{2}/.test(String(body.appt_time))) throw new AppError(400, 'INVALID', 'Choose a valid date and time.');
      const start = new Date(`${body.appt_date}T${String(body.appt_time).slice(0, 5)}:00+05:30`).getTime();
      if (start < Date.now()) throw new AppError(400, 'IN_PAST', 'That time has already passed.');
      const conflict = await queryOne(
        `SELECT id FROM appointments WHERE doctor_id=$1 AND appt_date=$2 AND appt_time=$3
           AND status NOT IN ('cancelled','no_show')
           AND NOT (status='pending_payment' AND hold_expires_at < NOW())`,
        [body.doctor_id, body.appt_date, body.appt_time]);
      if (conflict) throw new AppError(409, 'SLOT_UNAVAILABLE', 'This slot is no longer available.');
      // The time must be one of the doctor's open slots (working hours, not on leave).
      const { DoctorsService } = await import('../doctors/doctors.service');
      const av = await DoctorsService.getAvailability(body.doctor_id, String(body.appt_date));
      const t = String(body.appt_time).slice(0, 5);
      if (!av.available_slots.some((x: any) => String(x.slot_start).slice(0, 5) === t && !x.is_booked))
        throw new AppError(409, 'SLOT_UNAVAILABLE', 'The doctor is not available at this time. Please pick another slot.');
    }

    const { quote, attachPayment, checkoutFor, getSettings } = await import('../billing/billing.service');
    const q = await quote(patient.user_id, body.doctor_id, consultType);
    const s = await getSettings();
    const requires = q.payments_enabled && q.total_paise > 0;

    const appointmentId = await withTransaction(async (client) => {
      if (q.credit_applied) {
        // Serialise this patient's credit use so two quick bookings can't both take the last free consultation.
        const { ownerOf } = await import('../family/family.service');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [await ownerOf(patient.user_id)]);
        const { planCredit } = await import('../billing/billing.service');
        const c = await planCredit(patient.user_id, q.plan, consultType, s, client);
        if (c.used >= c.allowed) throw new AppError(409, 'CREDIT_USED', 'Your free consultation for this month was just used. Please review the new price and book again.');
      }
      const [appt] = await client.query(
        `INSERT INTO appointments (doctor_id, patient_id, appt_date, appt_time, consult_type, status, is_instant, instant_deadline)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [body.doctor_id, patientId, body.appt_date, body.appt_time, consultType,
         requires ? 'pending_payment' : 'booked', !!opts.instant,
         !requires && opts.instant ? new Date(Date.now() + s.instant_sla_minutes * 60000) : null]
      ).then(r => r.rows);
      await attachPayment(client, { id: appt.id, patient_id: patientId, doctor_id: body.doctor_id }, q);
      return appt.id as string;
    });

    let payment: any = { required: false };
    if (requires) {
      try { payment = await checkoutFor(appointmentId, patient.user_id); }
      catch (e: any) { payment = { required: true, error: e?.message || 'Could not start payment. Try again from Appointments.' }; }
    } else {
      setImmediate(() => this.notifyBookedEmails(appointmentId).catch(() => {}));
      if (opts.instant) setImmediate(async () => {
        try {
          const { io } = await import('../chat/chat.gateway');
          const [pn] = await query(`SELECT u.full_name FROM patients p JOIN users u ON u.id=p.user_id WHERE p.id=$1`, [patientId]) as any[];
          io?.to(`doctor:${body.doctor_id}`).emit('instant_consult_incoming', { appointmentId, patientName: pn?.full_name, consultType });
        } catch { /* optional */ }
      });
    }

    return { appointment_id: appointmentId, status: requires ? 'pending_payment' : 'booked', quote: q, payment };
  },

  async notifyBookedEmails(appointmentId: string) {
    try {
      const [d] = await query(
        `SELECT a.appt_date, a.appt_time, a.consult_type, pu.full_name AS patient_name, ${patientEmailSql('pu')} AS patient_email,
                du.full_name AS doctor_name, du.email AS doctor_email
         FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN users pu ON pu.id = p.user_id
         JOIN doctors d ON d.id = a.doctor_id JOIN users du ON du.id = d.user_id WHERE a.id = $1`, [appointmentId]) as any[];
      if (!d) return;
      for (const role of ['patient', 'doctor'] as const) {
        await sendAppointmentEmail({
          to: role === 'patient' ? d.patient_email : d.doctor_email, name: role === 'patient' ? d.patient_name : d.doctor_name,
          role, doctorName: d.doctor_name, patientName: d.patient_name, date: d.appt_date, time: d.appt_time,
          type: d.consult_type, action: 'booked',
        });
      }
    } catch (err) { logger.error('Failed to send appointment emails', { error: (err as Error).message }); }
  },

  async getById(appointmentId: string) {
    const appt = await queryOne(
      `SELECT a.*, u.full_name AS doctor_name, d.medical_system, d.specialization,
              pu.full_name AS patient_name
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN users u ON u.id = d.user_id
       JOIN patients p ON p.id = a.patient_id
       JOIN users pu ON pu.id = p.user_id
       WHERE a.id = $1`,
      [appointmentId]
    );
    if (!appt) throw new AppError(404, 'NOT_FOUND', 'Appointment not found.');
    return appt;
  },

  async cancel(appointmentId: string, reason: string) {
    const appt = await queryOne<{ status: string; payment_id: string }>(
      'SELECT status, payment_id FROM appointments WHERE id=$1', [appointmentId]
    );
    if (!appt) throw new AppError(404, 'NOT_FOUND', 'Appointment not found.');
    if (['completed','cancelled'].includes(appt.status))
      throw new AppError(422, 'CANNOT_CANCEL', 'This appointment cannot be cancelled.');

    await query(
      `UPDATE appointments SET status='cancelled', cancel_reason=$1, updated_at=NOW() WHERE id=$2`,
      [reason, appointmentId]
    );

    if (appt.payment_id) {
      await query(`UPDATE payments SET refund_status='requested' WHERE id=$1`, [appt.payment_id]);
    }

    // Send cancellation emails async — don't block response
    setImmediate(async () => { try {
      const [details] = await query(
        `SELECT a.appt_date, a.appt_time, a.consult_type,
                pu.full_name AS patient_name, ${patientEmailSql('pu')} AS patient_email,
                du.full_name AS doctor_name, du.email AS doctor_email
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         JOIN users pu ON pu.id = p.user_id
         JOIN doctors d ON d.id = a.doctor_id
         JOIN users du ON du.id = d.user_id
         WHERE a.id = $1`,
        [appointmentId]
      ) as any[];

      if (details) {
        await sendAppointmentEmail({
          to: details.patient_email, name: details.patient_name, role: 'patient',
          doctorName: details.doctor_name, patientName: details.patient_name,
          date: details.appt_date, time: details.appt_time,
          type: details.consult_type, action: 'cancelled',
        });
        await sendAppointmentEmail({
          to: details.doctor_email, name: details.doctor_name, role: 'doctor',
          doctorName: details.doctor_name, patientName: details.patient_name,
          date: details.appt_date, time: details.appt_time,
          type: details.consult_type, action: 'cancelled',
        });
      }
    } catch (err) {
      logger.error('Failed to send cancellation emails', { error: (err as Error).message });
    }});

    return { appointment_id: appointmentId, status: 'cancelled', refund_initiated: !!appt.payment_id };
  },

  async listForPatient(patientId: string, req: Request) {
    const { limit, offset, page } = getPagination(req);
    const rows = await query(
      `SELECT a.id, a.appt_date, a.appt_time, a.consult_type, a.status,
              u.full_name AS doctor_name, d.medical_system, d.specialization
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN users u ON u.id = d.user_id
       WHERE a.patient_id = $1
       ORDER BY a.appt_date DESC, a.appt_time DESC
       LIMIT $2 OFFSET $3`,
      [patientId, limit, offset]
    );
    const [{ count }] = await query<{ count: string }>(
      'SELECT COUNT(*)::int AS count FROM appointments WHERE patient_id=$1', [patientId]
    );
    return { rows, total: parseInt(count, 10), page, limit };
  },
};
