import { query, queryOne, withTransaction } from '../../config/database';
import { redis } from '../../config/redis';
import { hashPassword, comparePassword } from '../../utils/hash';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../utils/jwt';
import { generateOtp } from '../../utils/otp';
import { AppError } from '../../middleware/errorHandler';
import { User } from '../../types';
import { logger } from '../../utils/logger';
import { env } from '../../config/env';
import nodemailer from 'nodemailer';

// ── Email transporter ──────────────────────────────────────
function getTransporter() {
  if (!env.smtp.user || !env.smtp.pass || env.smtp.user === 'placeholder') return null;
  return nodemailer.createTransport({
    host:   env.smtp.host,
    port:   env.smtp.port,
    secure: false,
    auth:   { user: env.smtp.user, pass: env.smtp.pass },
  });
}

async function sendOtpEmail(toEmail: string, toName: string, otp: string, purpose: string) {
  const transporter = getTransporter();
  if (!transporter) {
    logger.warn('SMTP not configured — skipping email send');
    return;
  }
  const subject = purpose === 'password_reset'
    ? 'Reset your WellConsult password'
    : 'Verify your WellConsult account';

  await transporter.sendMail({
    from:    `WellConsult <${env.smtp.from}>`,
    to:      toEmail,
    subject,
    html: `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#fff">
        <div style="margin-bottom:24px">
          <span style="font-size:20px;font-weight:800;color:#1A1A18">Well<span style="color:#1D9E75">Consult</span></span>
        </div>
        <h2 style="font-size:22px;font-weight:800;color:#1A1A18;margin:0 0 8px">
          ${purpose === 'password_reset' ? 'Reset your password' : 'Verify your account'}
        </h2>
        <p style="color:#73726C;font-size:15px;line-height:1.6;margin:0 0 24px">
          Hi ${toName}, use the code below to ${purpose === 'password_reset' ? 'reset your password' : 'verify your WellConsult account'}.
        </p>
        <div style="background:#E1F5EE;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
          <div style="font-size:42px;font-weight:800;letter-spacing:12px;color:#1D9E75">${otp}</div>
          <p style="color:#0F6E56;font-size:13px;margin:8px 0 0">Expires in 10 minutes</p>
        </div>
        <p style="color:#A8A69E;font-size:13px;line-height:1.6">
          If you did not request this, you can safely ignore this email.
        </p>
        <hr style="border:none;border-top:1px solid #E0DDD5;margin:24px 0">
        <p style="color:#A8A69E;font-size:12px;text-align:center">
          WellConsult — Holistic healthcare, digitally
        </p>
      </div>
    `,
  });
  logger.info('OTP email sent', { to: toEmail, purpose });
}

export const AuthService = {
  async register(body: {
    full_name: string; email: string; phone?: string;
    password: string; role: 'patient' | 'doctor';
  }): Promise<{ user_id: string; role: string }> {
    const exists = await queryOne<User>(
      'SELECT id FROM users WHERE email = $1', [body.email]
    );
    if (exists) throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');

    const password_hash = await hashPassword(body.password);

    // ── Transaction: create user + profile ─────────────────
    const result = await withTransaction(async (client) => {
      const [user] = await client.query<User>(
        `INSERT INTO users (full_name, email, phone, password_hash, role)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, role`,
        [body.full_name, body.email, body.phone, password_hash, body.role]
      ).then(r => r.rows);

      if (body.role === 'doctor') {
        await client.query(
          `INSERT INTO doctors (user_id, medical_system, degree, reg_number, reg_body, experience_years, city)
           VALUES ($1, 'allopathy', '', '', '', 0, '') ON CONFLICT DO NOTHING`,
          [user.id]
        );
      } else {
        await client.query(
          'INSERT INTO patients (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [user.id]
        );
      }

      logger.info('User registered', { userId: user.id, role: body.role });
      return { user_id: user.id as string, role: body.role };
    });

    // ── Send OTP AFTER transaction commits ──────────────────
    try {
      await AuthService.sendOtp(result.user_id, 'email');
    } catch (err) {
      logger.error('Failed to send OTP after registration', { error: (err as Error).message });
    }

    return result;
  },

  async login(email: string, password: string) {
    const user = await queryOne<User & { password_hash: string }>(
      'SELECT id, full_name, email, role, password_hash, is_active, is_verified FROM users WHERE email = $1',
      [email]
    );
    if (!user) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    if (!user.is_active) throw new AppError(403, 'ACCOUNT_DISABLED', 'Your account has been suspended.');

    const valid = await comparePassword(password, user.password_hash);
    if (!valid) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');

    const [doctor]  = await query<{ id: string }>('SELECT id FROM doctors WHERE user_id = $1', [user.id]);
    const [patient] = await query<{ id: string }>('SELECT id FROM patients WHERE user_id = $1', [user.id]);

    const payload = {
      sub:       user.id,
      role:      user.role,
      doctorId:  doctor?.id,
      patientId: patient?.id,
    };

    const accessToken  = signAccessToken(payload);
    const refreshToken = signRefreshToken({ sub: user.id });

    try {
      await redis.setEx(`refresh:${user.id}`, 30 * 24 * 60 * 60, refreshToken);
    } catch {
      logger.warn('Redis unavailable — refresh token not cached');
    }

    return {
      access_token:  accessToken,
      refresh_token: refreshToken,
      expires_in:    900,
      user: { id: user.id, full_name: user.full_name, role: user.role },
    };
  },

  async logout(accessToken: string, userId: string): Promise<void> {
    try {
      await redis.setEx(`blacklist:${accessToken}`, 900, '1');
      await redis.del(`refresh:${userId}`);
    } catch {
      logger.warn('Redis unavailable — token not blacklisted');
    }
  },

  async refresh(refreshToken: string) {
    let payload: { sub: string };
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired.');
    }

    try {
      const stored = await redis.get(`refresh:${payload.sub}`);
      if (stored && stored !== refreshToken) {
        throw new AppError(401, 'REFRESH_TOKEN_REUSE', 'Refresh token has already been used.');
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.warn('Redis unavailable — skipping refresh token validation');
    }

    const user = await queryOne<User>('SELECT id, role FROM users WHERE id = $1', [payload.sub]);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');

    const [doctor]  = await query<{ id: string }>('SELECT id FROM doctors WHERE user_id = $1', [user.id]);
    const [patient] = await query<{ id: string }>('SELECT id FROM patients WHERE user_id = $1', [user.id]);

    const newAccess  = signAccessToken({ sub: user.id, role: user.role, doctorId: doctor?.id, patientId: patient?.id });
    const newRefresh = signRefreshToken({ sub: user.id });

    try {
      await redis.setEx(`refresh:${user.id}`, 30 * 24 * 60 * 60, newRefresh);
    } catch {
      logger.warn('Redis unavailable — refresh token not cached');
    }

    return { access_token: newAccess, refresh_token: newRefresh, expires_in: 900 };
  },

  async sendOtp(userId: string, purpose: string): Promise<void> {
    const otp = generateOtp();

    await query(
      `INSERT INTO otp_verifications (user_id, otp_code, purpose, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')`,
      [userId, otp, purpose]
    );

    const user = await queryOne<{ email: string; full_name: string }>(
      'SELECT email, full_name FROM users WHERE id=$1', [userId]
    );

    if (user) {
      try {
        await sendOtpEmail(user.email, user.full_name, otp, purpose);
      } catch (err) {
        logger.error('Failed to send OTP email', { error: (err as Error).message });
      }
    }

    logger.info('OTP generated', { userId, purpose, otp });
  },

  async verifyOtp(userId: string, otpCode: string, purpose: string): Promise<void> {
    const row = await queryOne<{ id: string }>(
      `SELECT id FROM otp_verifications
       WHERE user_id = $1 AND otp_code = $2 AND purpose = $3
         AND expires_at > NOW() AND used = FALSE
       ORDER BY id DESC LIMIT 1`,
      [userId, otpCode, purpose]
    );
    if (!row) throw new AppError(400, 'INVALID_OTP', 'OTP is invalid or has expired.');

    await query('UPDATE otp_verifications SET used = TRUE WHERE id = $1', [row.id]);

    if (purpose === 'email') {
      await query('UPDATE users SET is_verified = TRUE WHERE id = $1', [userId]);
    }
  },
};