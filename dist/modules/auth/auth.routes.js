"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_controller_1 = require("./auth.controller");
const authenticate_1 = require("../../middleware/authenticate");
const rateLimiter_1 = require("../../middleware/rateLimiter");
const validate_1 = require("../../middleware/validate");
const auth_schema_1 = require("./auth.schema");
const router = (0, express_1.Router)();
router.post('/register', rateLimiter_1.authLimiter, (0, validate_1.validate)(auth_schema_1.registerSchema), auth_controller_1.AuthController.register);
router.post('/login', rateLimiter_1.authLimiter, (0, validate_1.validate)(auth_schema_1.loginSchema), auth_controller_1.AuthController.login);
router.post('/logout', authenticate_1.authenticate, auth_controller_1.AuthController.logout);
router.post('/refresh', auth_controller_1.AuthController.refresh);
router.post('/otp/send', rateLimiter_1.otpLimiter, (0, validate_1.validate)(auth_schema_1.otpSendSchema), auth_controller_1.AuthController.sendOtp);
router.post('/otp/verify', rateLimiter_1.otpLimiter, (0, validate_1.validate)(auth_schema_1.otpVerifySchema), auth_controller_1.AuthController.verifyOtp);
// Forgot password
router.post('/forgot-password', rateLimiter_1.authLimiter, async (req, res, next) => {
    try {
        const { query, queryOne } = await Promise.resolve().then(() => __importStar(require('../../config/database')));
        const { Resend } = await Promise.resolve().then(() => __importStar(require('resend')));
        const { logger } = await Promise.resolve().then(() => __importStar(require('../../utils/logger')));
        const { email } = req.body;
        if (!email) {
            res.status(400).json({ success: false, error: { code: 'MISSING_EMAIL', message: 'Email is required.' } });
            return;
        }
        const user = await queryOne('SELECT id, full_name, is_active FROM users WHERE email=$1', [email]);
        // Always return success to prevent email enumeration
        if (!user || !user.is_active) {
            res.json({ success: true, data: { message: 'If this email exists, a reset link has been sent.' } });
            return;
        }
        const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36);
        await query(`INSERT INTO otp_verifications (user_id, otp_code, purpose, expires_at)
       VALUES ($1, $2, 'password_reset', NOW() + INTERVAL '1 hour')`, [user.id, token]);
        const resetUrl = `https://deemona-doctors-web.onrender.com?reset_token=${token}&user_id=${user.id}`;
        const resend = new Resend(process.env.RESEND_API_KEY || '');
        setImmediate(async () => {
            try {
                await resend.emails.send({
                    from: 'Deemona Doctors <onboarding@resend.dev>',
                    to: email,
                    subject: 'Reset your Deemona Doctors password',
                    html: [
                        '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#fff">',
                        '<div style="margin-bottom:24px"><span style="font-size:20px;font-weight:800;color:#1A1A18">Well<span style="color:#0A7B6C">Consult</span></span></div>',
                        '<h2 style="font-size:22px;font-weight:800;color:#1A1A18;margin:0 0 8px">Reset your password</h2>',
                        '<p style="color:#73726C;font-size:15px;line-height:1.6;margin:0 0 24px">Hi ' + user.full_name + ', click the button below to reset your password. This link expires in 1 hour.</p>',
                        '<a href="' + resetUrl + '" style="display:block;background:#0A7B6C;color:#fff;text-decoration:none;padding:14px 24px;border-radius:8px;font-weight:700;font-size:15px;text-align:center;margin-bottom:24px">Reset my password</a>',
                        '<p style="color:#A8A69E;font-size:13px">If you did not request this, you can safely ignore this email.</p>',
                        '<hr style="border:none;border-top:1px solid #E0DDD5;margin:24px 0">',
                        '<p style="color:#A8A69E;font-size:12px;text-align:center">Deemona Doctors — Holistic healthcare, digitally</p>',
                        '</div>',
                    ].join(''),
                });
            }
            catch (err) {
                logger.error('Password reset email failed', { error: err.message });
            }
        });
        res.json({ success: true, data: { message: 'If this email exists, a reset link has been sent.' } });
    }
    catch (e) {
        next(e);
    }
});
// Reset password with token
router.post('/reset-password', rateLimiter_1.authLimiter, async (req, res, next) => {
    try {
        const { query, queryOne } = await Promise.resolve().then(() => __importStar(require('../../config/database')));
        const bcrypt = await Promise.resolve().then(() => __importStar(require('bcryptjs')));
        const { user_id, token, new_password } = req.body;
        if (!user_id || !token || !new_password) {
            res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'All fields required.' } });
            return;
        }
        if (new_password.length < 8) {
            res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters.' } });
            return;
        }
        const otp = await queryOne(`SELECT id FROM otp_verifications
       WHERE user_id=$1 AND otp_code=$2 AND purpose='password_reset'
         AND expires_at > NOW() AND used=FALSE
       ORDER BY id DESC LIMIT 1`, [user_id, token]);
        if (!otp) {
            res.status(400).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Reset link is invalid or has expired.' } });
            return;
        }
        const hash = await bcrypt.hash(new_password, 10);
        await query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, user_id]);
        await query('UPDATE otp_verifications SET used=TRUE WHERE id=$1', [otp.id]);
        res.json({ success: true, data: { message: 'Password reset successfully. You can now sign in.' } });
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
//# sourceMappingURL=auth.routes.js.map