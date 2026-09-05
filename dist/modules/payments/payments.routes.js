"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../../middleware/authenticate");
const authorize_1 = require("../../middleware/authorize");
const database_1 = require("../../config/database");
const apiResponse_1 = require("../../utils/apiResponse");
const errorHandler_1 = require("../../middleware/errorHandler");
const razorpay_1 = __importDefault(require("razorpay"));
const crypto_1 = __importDefault(require("crypto"));
const router = (0, express_1.Router)();
const razorpay = new razorpay_1.default({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});
// ── Platform Fees (Admin) ─────────────────────────────────────────────────
// Get all platform fees
router.get('/fees', async (req, res, next) => {
    try {
        const fees = await (0, database_1.query)(`SELECT * FROM platform_fees ORDER BY medical_system, consult_type`);
        (0, apiResponse_1.sendSuccess)(res, fees);
    }
    catch (e) {
        next(e);
    }
});
// Set platform fee (admin only)
router.post('/fees', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const { medical_system, consult_type, fee } = req.body;
        if (!medical_system || !consult_type || fee === undefined) {
            throw new errorHandler_1.AppError(400, 'MISSING_FIELDS', 'medical_system, consult_type and fee required.');
        }
        const [result] = await (0, database_1.query)(`INSERT INTO platform_fees (medical_system, consult_type, fee)
       VALUES ($1,$2,$3)
       ON CONFLICT (medical_system, consult_type) DO UPDATE SET fee=$3, updated_at=NOW()
       RETURNING *`, [medical_system, consult_type, fee]);
        (0, apiResponse_1.sendSuccess)(res, result);
    }
    catch (e) {
        next(e);
    }
});
// Get fee for a specific doctor booking
router.get('/fees/calculate', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const { doctor_id, consult_type } = req.query;
        if (!doctor_id || !consult_type)
            throw new errorHandler_1.AppError(400, 'MISSING_FIELDS', 'doctor_id and consult_type required.');
        // Get doctor's medical system
        const doctor = await (0, database_1.queryOne)('SELECT medical_system FROM doctors WHERE id=$1', [doctor_id]);
        if (!doctor)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Doctor not found.');
        // Get platform fee
        const feeRow = await (0, database_1.queryOne)(`SELECT fee FROM platform_fees WHERE medical_system=$1 AND consult_type=$2`, [doctor.medical_system, consult_type]);
        let fee = parseFloat(String(feeRow?.fee || 0));
        // Apply subscription discount
        const sub = await (0, database_1.queryOne)(`SELECT plan, status FROM subscriptions WHERE user_id=$1 AND status='active'`, [req.user.sub]);
        let discount = 0;
        let discounted_fee = fee;
        if (sub?.plan === 'gold') {
            discount = 10;
            discounted_fee = fee * 0.9;
        }
        if (sub?.plan === 'diamond') {
            discount = 25;
            discounted_fee = fee * 0.75;
        }
        (0, apiResponse_1.sendSuccess)(res, {
            original_fee: fee,
            discount_percent: discount,
            final_fee: Math.round(discounted_fee),
            subscription_plan: sub?.plan || 'free',
            medical_system: doctor.medical_system,
        });
    }
    catch (e) {
        next(e);
    }
});
// Create direct order without appointment (payment first flow)
router.post('/create-direct-order', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const { amount, doctor_id, consult_type } = req.body;
        if (!amount || !doctor_id)
            throw new errorHandler_1.AppError(400, 'MISSING_FIELDS', 'amount and doctor_id required.');
        const user = await (0, database_1.queryOne)('SELECT email, full_name, phone FROM users WHERE id=$1', [req.user.sub]);
        const order = await razorpay.orders.create({
            amount: Math.round(parseFloat(String(amount)) * 100),
            currency: 'INR',
            receipt: `appt_${Date.now()}`,
            notes: { user_id: req.user.sub, doctor_id, consult_type },
        });
        (0, apiResponse_1.sendSuccess)(res, {
            order_id: order.id, amount: order.amount,
            razorpay_key: process.env.RAZORPAY_KEY_ID,
            patient_name: user?.full_name, email: user?.email, phone: user?.phone,
        });
    }
    catch (e) {
        next(e);
    }
});
// ── Consultation Payment ──────────────────────────────────────────────────
// Create payment order for appointment
router.post('/create-order', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const { appointment_id } = req.body;
        if (!appointment_id)
            throw new errorHandler_1.AppError(400, 'MISSING_FIELDS', 'appointment_id required.');
        const appt = await (0, database_1.queryOne)(`SELECT a.*, d.medical_system, u.full_name AS patient_name, u.email, u.phone
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN patients pt ON pt.id = a.patient_id
       JOIN users u ON u.id = pt.user_id
       WHERE a.id=$1 AND pt.user_id=$2`, [appointment_id, req.user.sub]);
        if (!appt)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Appointment not found.');
        // Get fee
        const feeRow = await (0, database_1.queryOne)(`SELECT fee FROM platform_fees WHERE medical_system=$1 AND consult_type=$2`, [appt.medical_system, appt.consult_type]);
        let fee = parseFloat(String(feeRow?.fee || 0));
        // Apply subscription discount
        const sub = await (0, database_1.queryOne)(`SELECT plan FROM subscriptions WHERE user_id=$1 AND status='active'`, [req.user.sub]);
        if (sub?.plan === 'gold')
            fee = Math.round(parseFloat(String(fee)) * 0.9);
        if (sub?.plan === 'diamond')
            fee = Math.round(parseFloat(String(fee)) * 0.75);
        if (fee === 0) {
            // Free consultation - just confirm
            await (0, database_1.query)(`UPDATE appointments SET status='confirmed' WHERE id=$1`, [appointment_id]);
            (0, apiResponse_1.sendSuccess)(res, { free: true, message: 'Appointment confirmed (free consultation).' });
            return;
        }
        // Create Razorpay order
        const order = await razorpay.orders.create({
            amount: Math.round(fee * 100), // paise as integer
            currency: 'INR',
            receipt: `appt_${appointment_id.slice(0, 12)}`,
            notes: { appointment_id, user_id: req.user.sub },
        });
        // Get doctor_id and patient_id from appointment
        const apptForPayment = await (0, database_1.queryOne)('SELECT patient_id, doctor_id FROM appointments WHERE id=$1', [appointment_id]);
        // Save payment record - use existing table structure
        await (0, database_1.query)(`INSERT INTO payments (appointment_id, patient_id, doctor_id, amount, currency, gateway, razorpay_order_id)
       VALUES ($1,$2,$3,$4,'INR','razorpay',$5)
       ON CONFLICT (appointment_id) DO UPDATE SET razorpay_order_id=$5, amount=$4`, [appointment_id, apptForPayment?.patient_id, apptForPayment?.doctor_id, fee, order.id]);
        (0, apiResponse_1.sendSuccess)(res, {
            order_id: order.id,
            amount: fee * 100,
            currency: 'INR',
            razorpay_key: process.env.RAZORPAY_KEY_ID,
            patient_name: appt.patient_name,
            email: appt.email,
            phone: appt.phone,
        });
    }
    catch (e) {
        next(e);
    }
});
// Verify payment and confirm appointment
router.post('/verify', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, appointment_id } = req.body;
        // Verify signature
        const body = `${razorpay_order_id}|${razorpay_payment_id}`;
        const expected = crypto_1.default.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body).digest('hex');
        if (expected !== razorpay_signature) {
            throw new errorHandler_1.AppError(400, 'INVALID_SIGNATURE', 'Payment verification failed.');
        }
        // Update payment and confirm appointment
        await (0, database_1.query)(`UPDATE payments SET razorpay_payment_id=$1, status='paid', paid_at=NOW() WHERE razorpay_order_id=$2`, [razorpay_payment_id, razorpay_order_id]);
        await (0, database_1.query)(`UPDATE appointments SET status='confirmed', payment_id=$1 WHERE id=$2`, [razorpay_payment_id, appointment_id]);
        (0, apiResponse_1.sendSuccess)(res, { message: 'Payment successful. Appointment confirmed!' });
    }
    catch (e) {
        next(e);
    }
});
// Refund payment (SLA breach or cancellation)
router.post('/refund', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const { appointment_id, reason } = req.body;
        const payment = await (0, database_1.queryOne)(`SELECT razorpay_payment_id, amount, status FROM payments WHERE appointment_id=$1`, [appointment_id]);
        if (!payment)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Payment not found.');
        if (payment.status === 'refunded')
            throw new errorHandler_1.AppError(400, 'ALREADY_REFUNDED', 'Already refunded.');
        // Process Razorpay refund
        await razorpay.payments.refund(payment.razorpay_payment_id, {
            amount: payment.amount * 100,
            notes: { reason: reason || 'Customer request', appointment_id },
        });
        await (0, database_1.query)(`UPDATE payments SET status='refunded', refunded_at=NOW() WHERE appointment_id=$1`, [appointment_id]);
        await (0, database_1.query)(`UPDATE appointments SET status='cancelled', cancellation_reason=$1 WHERE id=$2`, [reason || 'Refunded', appointment_id]);
        (0, apiResponse_1.sendSuccess)(res, { message: 'Refund processed successfully.' });
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
//# sourceMappingURL=payments.routes.js.map