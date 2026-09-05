"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../../middleware/authenticate");
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
const PLANS = {
    free: { razorpay_plan_id: 'plan_TX3yZM24fQRxto', price: 0, name: 'Free' },
    gold: { razorpay_plan_id: 'plan_TX3yu96OKfUKcu', price: 25, name: 'Gold' },
    diamond: { razorpay_plan_id: 'plan_TX3zKc3eeJ8bYh', price: 50, name: 'Diamond' },
};
// Get current subscription
router.get('/me', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const sub = await (0, database_1.queryOne)(`SELECT * FROM subscriptions WHERE user_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 1`, [req.user.sub]);
        (0, apiResponse_1.sendSuccess)(res, sub || { plan: 'free', status: 'active' });
    }
    catch (e) {
        next(e);
    }
});
// Get all plans
router.get('/plans', async (req, res, next) => {
    try {
        (0, apiResponse_1.sendSuccess)(res, {
            free: {
                name: 'Free',
                price: 0,
                features: [
                    'BP & weight checkup',
                    'Basic symptom checker',
                    'Ask a Doctor (text Q&A)',
                    'Access to Veda AI (limited)',
                ],
            },
            gold: {
                name: 'Gold',
                price: 25,
                features: [
                    'Everything in Free',
                    '1 video consultation/month',
                    '5 chat consultations/month',
                    'All medical systems access',
                    'Medical records storage',
                    '10% discount on consultation fees',
                    'Appointment reminders via SMS',
                ],
            },
            diamond: {
                name: 'Diamond',
                price: 50,
                features: [
                    'Everything in Gold',
                    'Unlimited video consultations',
                    '25% discount on consultation fees',
                    'Family account (up to 4 members)',
                    'Unlimited medical records',
                    '24/7 instant consultation priority',
                    'Veda AI unlimited',
                ],
            },
        });
    }
    catch (e) {
        next(e);
    }
});
// Create subscription
router.post('/create', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const { plan } = req.body;
        if (!plan || !PLANS[plan])
            throw new errorHandler_1.AppError(400, 'INVALID_PLAN', 'Invalid plan selected.');
        if (plan === 'free')
            throw new errorHandler_1.AppError(400, 'FREE_PLAN', 'Free plan does not require payment.');
        const planConfig = PLANS[plan];
        const user = await (0, database_1.queryOne)('SELECT email, full_name, phone FROM users WHERE id=$1', [req.user.sub]);
        if (!user)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'User not found.');
        // Create Razorpay subscription
        const subscription = await razorpay.subscriptions.create({
            plan_id: planConfig.razorpay_plan_id,
            customer_notify: 1,
            quantity: 1,
            total_count: 12, // 12 months
            notes: {
                user_id: req.user.sub,
                plan,
                user_name: user.full_name,
            },
        });
        // Save to DB
        await (0, database_1.query)(`INSERT INTO subscriptions (user_id, plan, razorpay_subscription_id, status, amount, started_at, expires_at)
       VALUES ($1,$2,$3,'created',$4,NOW(), NOW() + INTERVAL '1 month')
       ON CONFLICT (user_id) DO UPDATE SET
         plan=$2, razorpay_subscription_id=$3, status='created', amount=$4, updated_at=NOW()`, [req.user.sub, plan, subscription.id, planConfig.price]);
        (0, apiResponse_1.sendSuccess)(res, {
            subscription_id: subscription.id,
            razorpay_key: process.env.RAZORPAY_KEY_ID,
            plan,
            amount: planConfig.price * 100, // in paise
            user_name: user.full_name,
            user_email: user.email,
            user_phone: user.phone,
        });
    }
    catch (e) {
        next(e);
    }
});
// Verify payment webhook
router.post('/webhook', async (req, res, next) => {
    try {
        const secret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
        const signature = req.headers['x-razorpay-signature'];
        if (secret) {
            const body = JSON.stringify(req.body);
            const expected = crypto_1.default.createHmac('sha256', secret).update(body).digest('hex');
            if (signature !== expected) {
                res.status(400).json({ error: 'Invalid signature' });
                return;
            }
        }
        const event = req.body.event;
        const payload = req.body.payload?.subscription?.entity;
        if (event === 'subscription.activated' || event === 'subscription.charged') {
            const subId = payload?.id;
            const userId = payload?.notes?.user_id;
            const plan = payload?.notes?.plan;
            if (userId && plan) {
                await (0, database_1.query)(`UPDATE subscriptions SET status='active', updated_at=NOW(),
           expires_at=NOW() + INTERVAL '1 month' WHERE razorpay_subscription_id=$1`, [subId]);
            }
        }
        if (event === 'subscription.cancelled' || event === 'subscription.completed') {
            const subId = payload?.id;
            await (0, database_1.query)(`UPDATE subscriptions SET status='cancelled', updated_at=NOW() WHERE razorpay_subscription_id=$1`, [subId]);
        }
        res.json({ status: 'ok' });
    }
    catch (e) {
        next(e);
    }
});
// Cancel subscription
router.post('/cancel', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const sub = await (0, database_1.queryOne)(`SELECT razorpay_subscription_id FROM subscriptions WHERE user_id=$1 AND status='active'`, [req.user.sub]);
        if (!sub)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'No active subscription found.');
        await razorpay.subscriptions.cancel(sub.razorpay_subscription_id, { cancel_at_cycle_end: 1 });
        await (0, database_1.query)(`UPDATE subscriptions SET status='cancelling', updated_at=NOW() WHERE user_id=$1 AND status='active'`, [req.user.sub]);
        (0, apiResponse_1.sendSuccess)(res, { message: 'Subscription will be cancelled at end of current billing cycle.' });
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
//# sourceMappingURL=subscriptions.routes.js.map