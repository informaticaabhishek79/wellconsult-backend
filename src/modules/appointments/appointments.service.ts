import { query, queryOne, withTransaction } from '../../config/database';
import { AppError } from '../../middleware/errorHandler';
import { getPagination } from '../../utils/pagination';
import { Request } from 'express';
import Razorpay from 'razorpay';
import { env } from '../../config/env';

const razorpay = new Razorpay({
  key_id:     env.razorpay.keyId,
  key_secret: env.razorpay.keySecret,
});

export const AppointmentsService = {
  async book(patientId: string, body: {
    doctor_id: string; appt_date: string; appt_time: string;
    consult_type: string; payment_method: string;
  }) {
    // 1. Check slot availability
    const conflict = await queryOne(
      `SELECT id FROM appointments WHERE doctor_id=$1 AND appt_date=$2 AND appt_time=$3
       AND status NOT IN ('cancelled','no_show')`,
      [body.doctor_id, body.appt_date, body.appt_time]
    );
    if (conflict) throw new AppError(409, 'SLOT_UNAVAILABLE', 'This slot is no longer available.');

    // 2. Get fee
    const fee = await queryOne<{ fee_amount: number; currency: string }>(
      'SELECT fee_amount, currency FROM consultation_fees WHERE doctor_id=$1 AND consult_type=$2',
      [body.doctor_id, body.consult_type]
    );
    if (!fee) throw new AppError(400, 'NO_FEE_SET', 'Doctor has not set a fee for this consultation type.');

    return withTransaction(async (client) => {
      // 3. Create Razorpay order
      const rzpOrder = await razorpay.orders.create({
        amount:   fee.fee_amount,
        currency: fee.currency,
        receipt:  `wc_${Date.now()}`,
      });

      // 4. Create payment record
      const [payment] = await client.query(
        `INSERT INTO payments (patient_id, doctor_id, amount, currency, gateway, status)
         VALUES ($1,$2,$3,$4,'razorpay','pending') RETURNING id`,
        [patientId, body.doctor_id, fee.fee_amount, fee.currency]
      ).then(r => r.rows);

      // 5. Create appointment
      const [appt] = await client.query(
        `INSERT INTO appointments (doctor_id, patient_id, appt_date, appt_time, consult_type, payment_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status`,
        [body.doctor_id, patientId, body.appt_date, body.appt_time, body.consult_type, payment.id]
      ).then(r => r.rows);

      // 6. Update payment with appointment_id
      await client.query('UPDATE payments SET appointment_id=$1 WHERE id=$2', [appt.id, payment.id]);

      return {
        appointment_id: appt.id,
        status: appt.status,
        payment: {
          payment_id:       payment.id,
          gateway:          'razorpay',
          razorpay_order_id: rzpOrder.id,
          amount:            fee.fee_amount,
          currency:          fee.currency,
        },
      };
    });
  },

  async getById(appointmentId: string, userId: string, role: string) {
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
      'SELECT status, payment_id FROM appointments WHERE id=$1',
      [appointmentId]
    );
    if (!appt) throw new AppError(404, 'NOT_FOUND', 'Appointment not found.');
    if (['completed','cancelled'].includes(appt.status)) {
      throw new AppError(422, 'CANNOT_CANCEL', 'This appointment cannot be cancelled.');
    }

    await query(
      `UPDATE appointments SET status='cancelled', cancel_reason=$1, updated_at=NOW() WHERE id=$2`,
      [reason, appointmentId]
    );

    if (appt.payment_id) {
      await query(`UPDATE payments SET refund_status='requested' WHERE id=$1`, [appt.payment_id]);
    }

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
