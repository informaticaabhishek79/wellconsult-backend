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
    consult_type: string; payment_method: string; is_emergency?: boolean;
  }) {
    // Emergency booking was removed: emergencies are directed to 112 and in-person care.
    if (body.is_emergency) {
      throw new AppError(422, 'EMERGENCY_NOT_SUPPORTED', 'For a medical emergency call 112 or go to the nearest emergency department. Online consultations are not for emergencies.');
    }
    {
      const conflict = await queryOne(
        `SELECT id FROM appointments WHERE doctor_id=$1 AND appt_date=$2 AND appt_time=$3
         AND status NOT IN ('cancelled','no_show')`,
        [body.doctor_id, body.appt_date, body.appt_time]
      );
      if (conflict) throw new AppError(409, 'SLOT_UNAVAILABLE', 'This slot is no longer available.');
    }

    // Get fee — emergency = 1.5x video fee
    let fee = await queryOne<{ fee_amount: number; currency: string }>(
      'SELECT fee_amount, currency FROM consultation_fees WHERE doctor_id=$1 AND consult_type=$2',
      [body.doctor_id, body.consult_type]
    );

    if (!fee && body.is_emergency) {
      fee = await queryOne<{ fee_amount: number; currency: string }>(
        'SELECT fee_amount, currency FROM consultation_fees WHERE doctor_id=$1 AND consult_type=\'video\'',
        [body.doctor_id]
      );
    }

    // Fallback to platform_fees if doctor hasn't set their own fee
    if (!fee) {
      const doctor = await queryOne<{ medical_system: string }>(
        'SELECT medical_system FROM doctors WHERE id=$1', [body.doctor_id]
      );
      if (doctor) {
        const platformFee = await queryOne<{ fee: number }>(
          'SELECT fee FROM platform_fees WHERE medical_system=$1 AND consult_type=$2',
          [doctor.medical_system, body.consult_type || 'video']
        );
        if (platformFee) fee = { fee_amount: platformFee.fee, currency: 'INR' };
      }
    }

    if (!fee) throw new AppError(400, 'NO_FEE_SET', 'Doctor has not set a fee for this consultation type.');

    const feeAmount = body.is_emergency ? Math.round(fee.fee_amount * 1.5) : fee.fee_amount;

    const result = await withTransaction(async (client) => {
      // Create payment record
      let rzpOrderId = `dev_order_${Date.now()}`;
      if (env.razorpay.keyId && env.razorpay.keyId !== 'placeholder') {
        try {
          const rzpOrder = await razorpay.orders.create({
            amount: feeAmount, currency: fee!.currency, receipt: `wc_${Date.now()}`,
          });
          rzpOrderId = rzpOrder.id;
        } catch { /* use dev order id */ }
      }

      const [payment] = await client.query(
        `INSERT INTO payments (patient_id, doctor_id, amount, currency, gateway, status)
         VALUES ($1,$2,$3,$4,'razorpay','pending') RETURNING id`,
        [patientId, body.doctor_id, feeAmount, fee!.currency]
      ).then(r => r.rows);

      const [appt] = await client.query(
        `INSERT INTO appointments (doctor_id, patient_id, appt_date, appt_time, consult_type, payment_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, status`,
        [body.doctor_id, patientId, body.appt_date, body.appt_time, body.consult_type, payment.id,
         body.is_emergency ? 'confirmed' : 'booked']
      ).then(r => r.rows);

      await client.query('UPDATE payments SET appointment_id=$1 WHERE id=$2', [appt.id, payment.id]);

      return { appointment_id: appt.id, status: appt.status, payment_id: payment.id, rzpOrderId, feeAmount, currency: fee!.currency };
    });

    // Send emails async — fire and forget
    setImmediate(async () => { try {
      const [apptDetails] = await query(
        `SELECT a.appt_date, a.appt_time, a.consult_type,
                pu.full_name AS patient_name, pu.email AS patient_email,
                du.full_name AS doctor_name, du.email AS doctor_email
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         JOIN users pu ON pu.id = p.user_id
         JOIN doctors d ON d.id = a.doctor_id
         JOIN users du ON du.id = d.user_id
         WHERE a.id = $1`,
        [result.appointment_id]
      ) as any[];

      if (apptDetails) {
        // Email to patient
        await sendAppointmentEmail({
          to: apptDetails.patient_email, name: apptDetails.patient_name,
          role: 'patient', doctorName: apptDetails.doctor_name,
          patientName: apptDetails.patient_name, date: apptDetails.appt_date,
          time: apptDetails.appt_time, type: apptDetails.consult_type,
          isEmergency: body.is_emergency, action: 'booked',
        });

        // Email to doctor
        await sendAppointmentEmail({
          to: apptDetails.doctor_email, name: apptDetails.doctor_name,
          role: 'doctor', doctorName: apptDetails.doctor_name,
          patientName: apptDetails.patient_name, date: apptDetails.appt_date,
          time: apptDetails.appt_time, type: apptDetails.consult_type,
          isEmergency: body.is_emergency, action: 'booked',
        });
      }
    } catch (err) {
      logger.error('Failed to send appointment emails', { error: (err as Error).message });
    }});

    return {
      appointment_id: result.appointment_id,
      status:         result.status,
      payment: {
        payment_id:       result.payment_id,
        gateway:          'razorpay',
        razorpay_order_id: result.rzpOrderId,
        amount:           result.feeAmount,
        currency:         result.currency,
      },
    };
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
                pu.full_name AS patient_name, pu.email AS patient_email,
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
