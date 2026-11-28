import { Router } from 'express';
import { AuthController } from './auth.controller';
import { authenticate } from '../../middleware/authenticate';
import { authLimiter, otpLimiter } from '../../middleware/rateLimiter';
import { validate } from '../../middleware/validate';
import { registerSchema, loginSchema, otpSendSchema, otpVerifySchema } from './auth.schema';
import { query } from '../../config/database';
import { AuthService } from './auth.service';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), AuthController.register);
router.post('/login',    authLimiter, validate(loginSchema),    AuthController.login);
router.post('/logout',   authenticate,                           AuthController.logout);
router.post('/refresh',                                          AuthController.refresh);
router.post('/otp/send',   otpLimiter, validate(otpSendSchema),   AuthController.sendOtp);
router.post('/otp/verify', otpLimiter, validate(otpVerifySchema),  AuthController.verifyOtp);

// Forgot password
router.post('/verify-email', otpLimiter, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim();
    const code = String(req.body.otp_code || '').trim();
    const bad = () => res.status(400).json({ success: false, error: { code: 'INVALID_OTP', message: 'The code is invalid or has expired.' } });
    if (!email || !/^\d{6}$/.test(code)) return bad();
    const [user] = await query<{ id: string }>('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (!user) return bad();
    const [row] = await query<{ id: string }>(
      `SELECT id FROM otp_verifications
         WHERE user_id = $1 AND otp_code = $2 AND purpose = 'email' AND expires_at > NOW() AND used = FALSE
         ORDER BY created_at DESC LIMIT 1`, [user.id, code]);
    if (!row) return bad();
    await query('UPDATE otp_verifications SET used = TRUE WHERE id = $1', [row.id]);
    await query('UPDATE users SET is_verified = TRUE WHERE id = $1', [user.id]);
    res.json({ success: true, data: { message: 'Email verified.' } });
  } catch (e) { next(e); }
});

router.post('/resend-verification', otpLimiter, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim();
    if (email) {
      const [user] = await query<{ id: string; is_verified: boolean }>('SELECT id, is_verified FROM users WHERE LOWER(email) = LOWER($1)', [email]);
      if (user && !user.is_verified) await AuthService.sendOtp(user.id, 'email');
    }
    res.json({ success: true, data: { message: 'If the account needs verification, a new code has been sent.' } });
  } catch (e) { next(e); }
});

router.post('/forgot-password', authLimiter, async (req, res, next) => {
  try {
    const { query, queryOne } = await import('../../config/database');
    const { Resend } = await import('resend');
    const { logger } = await import('../../utils/logger');
    const { email } = req.body;

    if (!email) {
      res.status(400).json({ success: false, error: { code: 'MISSING_EMAIL', message: 'Email is required.' } });
      return;
    }

    const user = await queryOne<{ id: string; full_name: string; email: string; is_active: boolean }>(
      'SELECT id, full_name, email, is_active FROM users WHERE LOWER(email)=LOWER($1)', [String(email).trim()]
    );

    // Always return success to prevent email enumeration
    if (!user || !user.is_active) {
      res.json({ success: true, data: { message: 'If this email exists, a reset link has been sent.' } });
      return;
    }

    const { randomBytes } = await import('crypto');
    const token = randomBytes(24).toString('hex');
    await query(
      `INSERT INTO otp_verifications (user_id, otp_code, purpose, expires_at)
       VALUES ($1, $2, 'password_reset', NOW() + INTERVAL '1 hour')`,
      [user.id, token]
    );

    const appUrl = (process.env.APP_URL || 'https://doctors.deemona.com').replace(/\/$/, '');
    const resetUrl = `${appUrl}/?reset_token=${token}&user_id=${user.id}`;
    const resend = new Resend(process.env.RESEND_API_KEY || '');

    setImmediate(async () => {
      try {
        await resend.emails.send({
          from: 'Deemona Doctors <noreply@mail.deemona.com>',
          to: user.email,
          subject: 'Reset your Deemona Doctors password',
          html: [
            '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#fff">',
            '<div style="margin-bottom:24px"><span style="font-size:20px;font-weight:800;color:#1A1A18">Deemona <span style="color:#0A7B6C">Doctors</span></span></div>',
            '<h2 style="font-size:22px;font-weight:800;color:#1A1A18;margin:0 0 8px">Reset your password</h2>',
            '<p style="color:#73726C;font-size:15px;line-height:1.6;margin:0 0 24px">Hi ' + user.full_name + ', click the button below to reset your password. This link expires in 1 hour.</p>',
            '<a href="' + resetUrl + '" style="display:block;background:#0A7B6C;color:#fff;text-decoration:none;padding:14px 24px;border-radius:8px;font-weight:700;font-size:15px;text-align:center;margin-bottom:24px">Reset my password</a>',
            '<p style="color:#A8A69E;font-size:13px">If you did not request this, you can safely ignore this email.</p>',
            '<hr style="border:none;border-top:1px solid #E0DDD5;margin:24px 0">',
            '<p style="color:#A8A69E;font-size:12px;text-align:center">Deemona Doctors — Holistic healthcare, digitally</p>',
            '</div>',
          ].join(''),
        });
      } catch (err) {
        logger.error('Password reset email failed', { error: (err as Error).message });
      }
    });

    res.json({ success: true, data: { message: 'If this email exists, a reset link has been sent.' } });
  } catch (e) { next(e); }
});

// Reset password with token
router.post('/reset-password', authLimiter, async (req, res, next) => {
  try {
    const { query, queryOne } = await import('../../config/database');
    const bcrypt = await import('bcryptjs');
    const { user_id, token, new_password } = req.body;

    if (!user_id || !token || !new_password) {
      res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'All fields required.' } });
      return;
    }
    if (new_password.length < 8) {
      res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters.' } });
      return;
    }

    const otp = await queryOne<{ id: string }>(
      `SELECT id FROM otp_verifications
       WHERE user_id=$1 AND otp_code=$2 AND purpose='password_reset'
         AND expires_at > NOW() AND used=FALSE
       ORDER BY id DESC LIMIT 1`,
      [user_id, token]
    );

    if (!otp) {
      res.status(400).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Reset link is invalid or has expired.' } });
      return;
    }

    const hash = await bcrypt.hash(new_password, 10);
    await query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, user_id]);
    await query('UPDATE otp_verifications SET used=TRUE WHERE id=$1', [otp.id]);

    res.json({ success: true, data: { message: 'Password reset successfully. You can now sign in.' } });
  } catch (e) { next(e); }
});

export default router;
