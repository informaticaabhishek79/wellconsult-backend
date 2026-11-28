import { query, queryOne, withTransaction } from '../../config/database';
import { redis } from '../../config/redis';
import { hashPassword, comparePassword } from '../../utils/hash';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../utils/jwt';
import { generateOtp, OTP_TTL_SECONDS } from '../../utils/otp';
import { AppError } from '../../middleware/errorHandler';
import { User } from '../../types';
import { logger } from '../../utils/logger';
import { mailer as resend, mailConfigured, mailProvider } from '../../utils/mailer';

async function sendOtpEmail(toEmail: string, toName: string, otp: string, purpose: string) {
  if (!mailConfigured) {
    logger.warn('No email provider configured — skipping OTP email');
    return;
  }
  const subject = purpose === 'password_reset'
    ? 'Reset your Deemona Doctors password'
    : 'Verify your Deemona Doctors account';
  try {
    const sendRes = await resend.emails.send({
      from: 'Deemona Doctors <noreply@mail.deemona.com>',
      to:   toEmail,
      subject,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#fff">
          <div style="margin-bottom:24px">
            <span style="font-size:20px;font-weight:800;color:#1A1A18">Deemona <span style="color:#0A7B6C">Doctors</span></span>
          </div>
          <h2 style="font-size:22px;font-weight:800;color:#1A1A18;margin:0 0 8px">
            ${purpose === 'password_reset' ? 'Reset your password' : 'Verify your account'}
          </h2>
          <p style="color:#73726C;font-size:15px;line-height:1.6;margin:0 0 24px">
            Hi ${toName}, use the code below to ${purpose === 'password_reset' ? 'reset your password' : 'verify your Deemona Doctors account'}.
          </p>
          <div style="background:#E6F4F1;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
            <div style="font-size:42px;font-weight:800;letter-spacing:12px;color:#0A7B6C">${otp}</div>
            <p style="color:#065E52;font-size:13px;margin:8px 0 0">Expires in 10 minutes</p>
          </div>
          <p style="color:#A8A69E;font-size:13px">If you did not request this, you can safely ignore this email.</p>
        </div>
      `,
    });
    if (sendRes && sendRes.error) { logger.error('OTP email failed', { provider: mailProvider, error: sendRes.error }); return; }
    logger.info('OTP email sent via Resend', { to: toEmail, purpose });
  } catch (err) {
    logger.error('Resend email failed', { error: (err as Error).message });
  }
}

export const AuthService = {
  async register(body: {
    full_name: string; email: string; phone?: string;
    password: string; role: 'patient' | 'doctor' | 'agent';
  }): Promise<{ user_id: string; role: string }> {
    const exists = await queryOne<User>(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [body.email.trim()]
    );
    if (exists) throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');

    const password_hash = await hashPassword(body.password);

    const result = await withTransaction(async (client) => {
      const [user] = await client.query<User>(
        `INSERT INTO users (full_name, email, phone, password_hash, role, is_verified)
         VALUES ($1, $2, $3, $4, $5, FALSE) RETURNING id, role`,
        [body.full_name, body.email.trim().toLowerCase(), body.phone, password_hash, body.role]
      ).then(r => r.rows);

      // Create profile stub
      if (body.role === 'doctor') {
        await client.query(
          `INSERT INTO doctors (user_id, medical_system, degree, reg_number, reg_body, experience_years, city)
           VALUES ($1, 'allopathy', '', '', '', 0, '') ON CONFLICT DO NOTHING`,
          [user.id]
        );
      } else if (body.role !== 'agent') {
        await client.query(
          'INSERT INTO patients (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [user.id]
        );
      }

      logger.info('User registered', { userId: user.id, role: body.role });
      return { user_id: user.id as string, role: body.role };
    });

    // Send OTP async — don't block registration response
    setImmediate(async () => { try {
      await AuthService.sendOtp(result.user_id, 'email');
    } catch (err) {
      logger.error('Failed to send OTP after registration', { error: (err as Error).message });
    }});

    return result;
  },

  async login(email: string, password: string) {
    const user = await queryOne<User & { password_hash: string }>(
      'SELECT id, full_name, email, role, password_hash, is_active, is_verified FROM users WHERE LOWER(email) = LOWER($1)',
      [String(email).trim()]
    );
    if (!user) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    if (!user.is_active) throw new AppError(403, 'ACCOUNT_DISABLED', 'Your account has been suspended.');

    const valid = await comparePassword(password, user.password_hash);
    if (!valid) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    if (!user.is_verified) throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email before signing in. Enter the code we emailed you.');

    // Fetch linked doctor/patient id
    const [doctor] = await query<{ id: string }>('SELECT id FROM doctors WHERE user_id = $1', [user.id]);
    const [patient] = await query<{ id: string }>('SELECT id FROM patients WHERE user_id = $1', [user.id]);

    const payload = {
      sub:       user.id,
      role:      user.role,
      doctorId:  doctor?.id,
      patientId: patient?.id,
    };

    const accessToken  = signAccessToken(payload);
    const refreshToken = signRefreshToken({ sub: user.id });

    // Store refresh token in Redis (30 days)
    await redis.setEx(`refresh:${user.id}`, 30 * 24 * 60 * 60, refreshToken);

    return {
      access_token:  accessToken,
      refresh_token: refreshToken,
      expires_in:    86400,
      user: { id: user.id, full_name: user.full_name, role: user.role, doctorId: doctor?.id, patientId: patient?.id },
    };
  },

  async logout(accessToken: string, userId: string): Promise<void> {
    // Blacklist access token (TTL = 15 min)
    await redis.setEx(`blacklist:${accessToken}`, 900, '1');
    await redis.del(`refresh:${userId}`);
  },

  async refresh(refreshToken: string) {
    let payload: { sub: string };
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired.');
    }

    const stored = await redis.get(`refresh:${payload.sub}`);
    if (stored !== refreshToken) {
      throw new AppError(401, 'REFRESH_TOKEN_REUSE', 'Refresh token has already been used.');
    }

    const user = await queryOne<User>('SELECT id, role FROM users WHERE id = $1', [payload.sub]);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');

    const [doctor]  = await query<{ id: string }>('SELECT id FROM doctors WHERE user_id = $1', [user.id]);
    const [patient] = await query<{ id: string }>('SELECT id FROM patients WHERE user_id = $1', [user.id]);

    const newAccess  = signAccessToken({ sub: user.id, role: user.role, doctorId: doctor?.id, patientId: patient?.id });
    const newRefresh = signRefreshToken({ sub: user.id });

    await redis.setEx(`refresh:${user.id}`, 30 * 24 * 60 * 60, newRefresh);

    return { access_token: newAccess, refresh_token: newRefresh, expires_in: 86400 };
  },

  async sendOtp(userId: string, purpose: string): Promise<void> {
    const otp = generateOtp();
    await query(
      `INSERT INTO otp_verifications (user_id, otp_code, purpose, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')`,
      [userId, otp, purpose]
    );
    // Send OTP email via Resend
    const user = await queryOne<{ email: string; full_name: string }>('SELECT email, full_name FROM users WHERE id=$1', [userId]);
    if (user) await sendOtpEmail(user.email, user.full_name, otp, purpose);
    logger.info('OTP generated', { userId, purpose });
  },

  async verifyOtp(userId: string, otpCode: string, purpose: string): Promise<void> {
    const row = await queryOne<{ id: string }>(
      `SELECT id FROM otp_verifications
       WHERE user_id = $1 AND otp_code = $2 AND purpose = $3
         AND expires_at > NOW() AND used = FALSE
       ORDER BY created_at DESC LIMIT 1`,
      [userId, otpCode, purpose]
    );
    if (!row) throw new AppError(400, 'INVALID_OTP', 'OTP is invalid or has expired.');

    await query('UPDATE otp_verifications SET used = TRUE WHERE id = $1', [row.id]);

    if (purpose === 'email') {
      await query('UPDATE users SET is_verified = TRUE WHERE id = $1', [userId]);
    }
  },
};
