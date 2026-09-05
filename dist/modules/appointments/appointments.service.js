"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppointmentsService = void 0;
const database_1 = require("../../config/database");
const errorHandler_1 = require("../../middleware/errorHandler");
const pagination_1 = require("../../utils/pagination");
const razorpay_1 = __importDefault(require("razorpay"));
const env_1 = require("../../config/env");
const logger_1 = require("../../utils/logger");
const resend_1 = require("resend");
const resend = new resend_1.Resend(process.env.RESEND_API_KEY || '');
const razorpay = new razorpay_1.default({
    key_id: env_1.env.razorpay.keyId || 'placeholder',
    key_secret: env_1.env.razorpay.keySecret || 'placeholder',
});
async function sendAppointmentEmail(params) {
    if (!process.env.RESEND_API_KEY)
        return;
    const { to, name, role, doctorName, patientName, date, time, type, isEmergency, action } = params;
    const subjects = {
        booked: isEmergency ? 'Emergency consultation booked — Deemona Doctors' : 'Appointment confirmed — Deemona Doctors',
        cancelled: 'Appointment cancelled — Deemona Doctors',
        confirmed: 'Appointment confirmed by doctor — Deemona Doctors',
    };
    const actionText = {
        booked: 'has been successfully booked',
        cancelled: 'has been cancelled',
        confirmed: 'has been confirmed by the doctor',
    };
    try {
        await resend.emails.send({
            from: 'Deemona Doctors <onboarding@resend.dev>',
            to,
            subject: subjects[action],
            html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#fff">
          <div style="margin-bottom:24px">
            <span style="font-size:20px;font-weight:800;color:#1A1A18">Well<span style="color:#0A7B6C">Consult</span></span>
          </div>
          ${isEmergency ? '<div style="background:#FEE2E2;border-radius:8px;padding:10px 16px;margin-bottom:16px;font-weight:700;color:#991B1B">⚡ Emergency consultation</div>' : ''}
          <h2 style="font-size:22px;font-weight:800;color:#1A1A18;margin:0 0 8px">
            Hi ${name}, your appointment ${actionText[action]}.
          </h2>
          <div style="background:#F8F7F4;border-radius:12px;padding:20px;margin:20px 0">
            <table style="width:100%;border-collapse:collapse">
              ${role === 'patient'
                ? `<tr><td style="color:#73726C;padding:6px 0;font-size:13px">Doctor</td><td style="font-weight:700;font-size:13px">${doctorName}</td></tr>`
                : `<tr><td style="color:#73726C;padding:6px 0;font-size:13px">Patient</td><td style="font-weight:700;font-size:13px">${patientName}</td></tr>`}
              <tr><td style="color:#73726C;padding:6px 0;font-size:13px">Date</td><td style="font-weight:700;font-size:13px">${date}</td></tr>
              <tr><td style="color:#73726C;padding:6px 0;font-size:13px">Time</td><td style="font-weight:700;font-size:13px">${time}</td></tr>
              <tr><td style="color:#73726C;padding:6px 0;font-size:13px">Type</td><td style="font-weight:700;font-size:13px;text-transform:capitalize">${type}</td></tr>
            </table>
          </div>
        </div>
      `,
        });
        logger_1.logger.info('Appointment email sent', { to, action });
    }
    catch (err) {
        logger_1.logger.error('Resend appointment email failed', { error: err.message });
    }
}
exports.AppointmentsService = {
    async book(patientId, body) {
        // Check slot availability (skip for emergency)
        if (!body.is_emergency) {
            const conflict = await (0, database_1.queryOne)(`SELECT id FROM appointments WHERE doctor_id=$1 AND appt_date=$2 AND appt_time=$3
         AND status NOT IN ('cancelled','no_show')`, [body.doctor_id, body.appt_date, body.appt_time]);
            if (conflict)
                throw new errorHandler_1.AppError(409, 'SLOT_UNAVAILABLE', 'This slot is no longer available.');
        }
        // Get fee — emergency = 1.5x video fee
        let fee = await (0, database_1.queryOne)('SELECT fee_amount, currency FROM consultation_fees WHERE doctor_id=$1 AND consult_type=$2', [body.doctor_id, body.consult_type]);
        if (!fee && body.is_emergency) {
            fee = await (0, database_1.queryOne)('SELECT fee_amount, currency FROM consultation_fees WHERE doctor_id=$1 AND consult_type=\'video\'', [body.doctor_id]);
        }
        // Fallback to platform_fees if doctor hasn't set their own fee
        if (!fee) {
            const doctor = await (0, database_1.queryOne)('SELECT medical_system FROM doctors WHERE id=$1', [body.doctor_id]);
            if (doctor) {
                const platformFee = await (0, database_1.queryOne)('SELECT fee FROM platform_fees WHERE medical_system=$1 AND consult_type=$2', [doctor.medical_system, body.consult_type || 'video']);
                if (platformFee)
                    fee = { fee_amount: platformFee.fee, currency: 'INR' };
            }
        }
        if (!fee)
            throw new errorHandler_1.AppError(400, 'NO_FEE_SET', 'Doctor has not set a fee for this consultation type.');
        const feeAmount = body.is_emergency ? Math.round(fee.fee_amount * 1.5) : fee.fee_amount;
        const result = await (0, database_1.withTransaction)(async (client) => {
            // Create payment record
            let rzpOrderId = `dev_order_${Date.now()}`;
            if (env_1.env.razorpay.keyId && env_1.env.razorpay.keyId !== 'placeholder') {
                try {
                    const rzpOrder = await razorpay.orders.create({
                        amount: feeAmount, currency: fee.currency, receipt: `wc_${Date.now()}`,
                    });
                    rzpOrderId = rzpOrder.id;
                }
                catch { /* use dev order id */ }
            }
            const [payment] = await client.query(`INSERT INTO payments (patient_id, doctor_id, amount, currency, gateway, status)
         VALUES ($1,$2,$3,$4,'razorpay','pending') RETURNING id`, [patientId, body.doctor_id, feeAmount, fee.currency]).then(r => r.rows);
            const [appt] = await client.query(`INSERT INTO appointments (doctor_id, patient_id, appt_date, appt_time, consult_type, payment_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, status`, [body.doctor_id, patientId, body.appt_date, body.appt_time, body.consult_type, payment.id,
                body.is_emergency ? 'confirmed' : 'booked']).then(r => r.rows);
            await client.query('UPDATE payments SET appointment_id=$1 WHERE id=$2', [appt.id, payment.id]);
            return { appointment_id: appt.id, status: appt.status, payment_id: payment.id, rzpOrderId, feeAmount, currency: fee.currency };
        });
        // Send emails async — fire and forget
        setImmediate(async () => {
            try {
                const [apptDetails] = await (0, database_1.query)(`SELECT a.appt_date, a.appt_time, a.consult_type,
                pu.full_name AS patient_name, pu.email AS patient_email,
                du.full_name AS doctor_name, du.email AS doctor_email
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         JOIN users pu ON pu.id = p.user_id
         JOIN doctors d ON d.id = a.doctor_id
         JOIN users du ON du.id = d.user_id
         WHERE a.id = $1`, [result.appointment_id]);
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
            }
            catch (err) {
                logger_1.logger.error('Failed to send appointment emails', { error: err.message });
            }
        });
        return {
            appointment_id: result.appointment_id,
            status: result.status,
            payment: {
                payment_id: result.payment_id,
                gateway: 'razorpay',
                razorpay_order_id: result.rzpOrderId,
                amount: result.feeAmount,
                currency: result.currency,
            },
        };
    },
    async getById(appointmentId) {
        const appt = await (0, database_1.queryOne)(`SELECT a.*, u.full_name AS doctor_name, d.medical_system, d.specialization,
              pu.full_name AS patient_name
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN users u ON u.id = d.user_id
       JOIN patients p ON p.id = a.patient_id
       JOIN users pu ON pu.id = p.user_id
       WHERE a.id = $1`, [appointmentId]);
        if (!appt)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Appointment not found.');
        return appt;
    },
    async cancel(appointmentId, reason) {
        const appt = await (0, database_1.queryOne)('SELECT status, payment_id FROM appointments WHERE id=$1', [appointmentId]);
        if (!appt)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Appointment not found.');
        if (['completed', 'cancelled'].includes(appt.status))
            throw new errorHandler_1.AppError(422, 'CANNOT_CANCEL', 'This appointment cannot be cancelled.');
        await (0, database_1.query)(`UPDATE appointments SET status='cancelled', cancel_reason=$1, updated_at=NOW() WHERE id=$2`, [reason, appointmentId]);
        if (appt.payment_id) {
            await (0, database_1.query)(`UPDATE payments SET refund_status='requested' WHERE id=$1`, [appt.payment_id]);
        }
        // Send cancellation emails async — don't block response
        setImmediate(async () => {
            try {
                const [details] = await (0, database_1.query)(`SELECT a.appt_date, a.appt_time, a.consult_type,
                pu.full_name AS patient_name, pu.email AS patient_email,
                du.full_name AS doctor_name, du.email AS doctor_email
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         JOIN users pu ON pu.id = p.user_id
         JOIN doctors d ON d.id = a.doctor_id
         JOIN users du ON du.id = d.user_id
         WHERE a.id = $1`, [appointmentId]);
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
            }
            catch (err) {
                logger_1.logger.error('Failed to send cancellation emails', { error: err.message });
            }
        });
        return { appointment_id: appointmentId, status: 'cancelled', refund_initiated: !!appt.payment_id };
    },
    async listForPatient(patientId, req) {
        const { limit, offset, page } = (0, pagination_1.getPagination)(req);
        const rows = await (0, database_1.query)(`SELECT a.id, a.appt_date, a.appt_time, a.consult_type, a.status,
              u.full_name AS doctor_name, d.medical_system, d.specialization
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN users u ON u.id = d.user_id
       WHERE a.patient_id = $1
       ORDER BY a.appt_date DESC, a.appt_time DESC
       LIMIT $2 OFFSET $3`, [patientId, limit, offset]);
        const [{ count }] = await (0, database_1.query)('SELECT COUNT(*)::int AS count FROM appointments WHERE patient_id=$1', [patientId]);
        return { rows, total: parseInt(count, 10), page, limit };
    },
};
//# sourceMappingURL=appointments.service.js.map