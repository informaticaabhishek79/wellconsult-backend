import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query, queryOne } from '../../config/database';
import { sendSuccess } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';
import Razorpay from 'razorpay';
import crypto from 'crypto';

const router = Router();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

// ── Platform Fees (Admin) ─────────────────────────────────────────────────

// Get all platform fees
router.get('/fees', async (req, res, next) => {
  try {
    const fees = await query(
      `SELECT * FROM platform_fees ORDER BY medical_system, consult_type`
    );
    sendSuccess(res, fees);
  } catch (e) { next(e); }
});

// Set platform fee (admin only)
router.post('/fees', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { medical_system, consult_type, fee } = req.body;
    if (!medical_system || !consult_type || fee === undefined) {
      throw new AppError(400, 'MISSING_FIELDS', 'medical_system, consult_type and fee required.');
    }
    const [result] = await query(
      `INSERT INTO platform_fees (medical_system, consult_type, fee)
       VALUES ($1,$2,$3)
       ON CONFLICT (medical_system, consult_type) DO UPDATE SET fee=$3, updated_at=NOW()
       RETURNING *`,
      [medical_system, consult_type, fee]
    ) as any[];
    sendSuccess(res, result);
  } catch (e) { next(e); }
});

// Get fee for a specific doctor booking
router.get('/fees/calculate', authenticate, async (req, res, next) => {
  try {
    const { doctor_id, consult_type } = req.query;
    if (!doctor_id || !consult_type) throw new AppError(400, 'MISSING_FIELDS', 'doctor_id and consult_type required.');

    // Get doctor's medical system
    const doctor = await queryOne<{ medical_system: string }>(
      'SELECT medical_system FROM doctors WHERE id=$1',
      [doctor_id as string]
    );
    if (!doctor) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');

    // Get platform fee
    const feeRow = await queryOne<{ fee: number }>(
      `SELECT fee FROM platform_fees WHERE medical_system=$1 AND consult_type=$2`,
      [doctor.medical_system, consult_type as string]
    );

    let fee = parseFloat(String(feeRow?.fee || 0));

    // Apply subscription discount
    const sub = await queryOne<{ plan: string; status: string }>(
      `SELECT plan, status FROM subscriptions WHERE user_id=$1 AND status='active'`,
      [req.user!.sub]
    );

    let discount = 0;
    let discounted_fee = fee;
    if (sub?.plan === 'gold') { discount = 10; discounted_fee = fee * 0.9; }
    if (sub?.plan === 'diamond') { discount = 25; discounted_fee = fee * 0.75; }

    sendSuccess(res, {
      original_fee: fee,
      discount_percent: discount,
      final_fee: Math.round(discounted_fee),
      subscription_plan: sub?.plan || 'free',
      medical_system: doctor.medical_system,
    });
  } catch (e) { next(e); }
});

// Create direct order without appointment (payment first flow)
router.post('/create-direct-order', authenticate, async (req, res, next) => {
  try {
    const { amount, doctor_id, consult_type } = req.body;
    if (!amount || !doctor_id) throw new AppError(400, 'MISSING_FIELDS', 'amount and doctor_id required.');
    const user = await queryOne<{ email: string; full_name: string; phone: string }>(
      'SELECT email, full_name, phone FROM users WHERE id=$1', [req.user!.sub]
    );
    const order = await (razorpay.orders as any).create({
      amount: Math.round(parseFloat(String(amount)) * 100),
      currency: 'INR',
      receipt: `appt_${Date.now()}`,
      notes: { user_id: req.user!.sub, doctor_id, consult_type },
    });
    sendSuccess(res, {
      order_id: order.id, amount: order.amount,
      razorpay_key: process.env.RAZORPAY_KEY_ID,
      patient_name: user?.full_name, email: user?.email, phone: user?.phone,
    });
  } catch (e) { next(e); }
});

// Consultation payments moved to /billing (server-verified, ledgered). The old create-order / verify / refund routes were removed.

export default router;
