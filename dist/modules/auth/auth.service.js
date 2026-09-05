"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const database_1 = require("../../config/database");
const redis_1 = require("../../config/redis");
const hash_1 = require("../../utils/hash");
const jwt_1 = require("../../utils/jwt");
const otp_1 = require("../../utils/otp");
const errorHandler_1 = require("../../middleware/errorHandler");
const logger_1 = require("../../utils/logger");
const resend_1 = require("resend");
const resend = new resend_1.Resend(process.env.RESEND_API_KEY || '');
async function sendOtpEmail(toEmail, toName, otp, purpose) {
    if (!process.env.RESEND_API_KEY) {
        logger_1.logger.warn('RESEND_API_KEY not set — skipping OTP email');
        return;
    }
    const subject = purpose === 'password_reset'
        ? 'Reset your Deemona Doctors password'
        : 'Verify your Deemona Doctors account';
    try {
        await resend.emails.send({
            from: 'Deemona Doctors <onboarding@resend.dev>',
            to: toEmail,
            subject,
            html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#fff">
          <div style="margin-bottom:24px">
            <span style="font-size:20px;font-weight:800;color:#1A1A18">Well<span style="color:#0A7B6C">Consult</span></span>
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
        logger_1.logger.info('OTP email sent via Resend', { to: toEmail, purpose });
    }
    catch (err) {
        logger_1.logger.error('Resend email failed', { error: err.message });
    }
}
exports.AuthService = {
    async register(body) {
        const exists = await (0, database_1.queryOne)('SELECT id FROM users WHERE email = $1', [body.email]);
        if (exists)
            throw new errorHandler_1.AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');
        const password_hash = await (0, hash_1.hashPassword)(body.password);
        const result = await (0, database_1.withTransaction)(async (client) => {
            const [user] = await client.query(`INSERT INTO users (full_name, email, phone, password_hash, role, is_verified)
         VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id, role`, [body.full_name, body.email, body.phone, password_hash, body.role]).then(r => r.rows);
            // Create profile stub
            if (body.role === 'doctor') {
                await client.query(`INSERT INTO doctors (user_id, medical_system, degree, reg_number, reg_body, experience_years, city)
           VALUES ($1, 'allopathy', '', '', '', 0, '') ON CONFLICT DO NOTHING`, [user.id]);
            }
            else {
                await client.query('INSERT INTO patients (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
            }
            logger_1.logger.info('User registered', { userId: user.id, role: body.role });
            return { user_id: user.id, role: body.role };
        });
        // Send OTP async — don't block registration response
        setImmediate(async () => {
            try {
                await exports.AuthService.sendOtp(result.user_id, 'email');
            }
            catch (err) {
                logger_1.logger.error('Failed to send OTP after registration', { error: err.message });
            }
        });
        return result;
    },
    async login(email, password) {
        const user = await (0, database_1.queryOne)('SELECT id, full_name, email, role, password_hash, is_active, is_verified FROM users WHERE email = $1', [email]);
        if (!user)
            throw new errorHandler_1.AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
        if (!user.is_active)
            throw new errorHandler_1.AppError(403, 'ACCOUNT_DISABLED', 'Your account has been suspended.');
        const valid = await (0, hash_1.comparePassword)(password, user.password_hash);
        if (!valid)
            throw new errorHandler_1.AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
        // Fetch linked doctor/patient id
        const [doctor] = await (0, database_1.query)('SELECT id FROM doctors WHERE user_id = $1', [user.id]);
        const [patient] = await (0, database_1.query)('SELECT id FROM patients WHERE user_id = $1', [user.id]);
        const payload = {
            sub: user.id,
            role: user.role,
            doctorId: doctor?.id,
            patientId: patient?.id,
        };
        const accessToken = (0, jwt_1.signAccessToken)(payload);
        const refreshToken = (0, jwt_1.signRefreshToken)({ sub: user.id });
        // Store refresh token in Redis (30 days)
        await redis_1.redis.setEx(`refresh:${user.id}`, 30 * 24 * 60 * 60, refreshToken);
        return {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: 86400,
            user: { id: user.id, full_name: user.full_name, role: user.role, doctorId: doctor?.id, patientId: patient?.id },
        };
    },
    async logout(accessToken, userId) {
        // Blacklist access token (TTL = 15 min)
        await redis_1.redis.setEx(`blacklist:${accessToken}`, 900, '1');
        await redis_1.redis.del(`refresh:${userId}`);
    },
    async refresh(refreshToken) {
        let payload;
        try {
            payload = (0, jwt_1.verifyRefreshToken)(refreshToken);
        }
        catch {
            throw new errorHandler_1.AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired.');
        }
        const stored = await redis_1.redis.get(`refresh:${payload.sub}`);
        if (stored !== refreshToken) {
            throw new errorHandler_1.AppError(401, 'REFRESH_TOKEN_REUSE', 'Refresh token has already been used.');
        }
        const user = await (0, database_1.queryOne)('SELECT id, role FROM users WHERE id = $1', [payload.sub]);
        if (!user)
            throw new errorHandler_1.AppError(404, 'USER_NOT_FOUND', 'User not found.');
        const [doctor] = await (0, database_1.query)('SELECT id FROM doctors WHERE user_id = $1', [user.id]);
        const [patient] = await (0, database_1.query)('SELECT id FROM patients WHERE user_id = $1', [user.id]);
        const newAccess = (0, jwt_1.signAccessToken)({ sub: user.id, role: user.role, doctorId: doctor?.id, patientId: patient?.id });
        const newRefresh = (0, jwt_1.signRefreshToken)({ sub: user.id });
        await redis_1.redis.setEx(`refresh:${user.id}`, 30 * 24 * 60 * 60, newRefresh);
        return { access_token: newAccess, refresh_token: newRefresh, expires_in: 86400 };
    },
    async sendOtp(userId, purpose) {
        const otp = (0, otp_1.generateOtp)();
        await (0, database_1.query)(`INSERT INTO otp_verifications (user_id, otp_code, purpose, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')`, [userId, otp, purpose]);
        // Send OTP email via Resend
        const user = await (0, database_1.queryOne)('SELECT email, full_name FROM users WHERE id=$1', [userId]);
        if (user)
            await sendOtpEmail(user.email, user.full_name, otp, purpose);
        logger_1.logger.info('OTP generated', { userId, purpose });
    },
    async verifyOtp(userId, otpCode, purpose) {
        const row = await (0, database_1.queryOne)(`SELECT id FROM otp_verifications
       WHERE user_id = $1 AND otp_code = $2 AND purpose = $3
         AND expires_at > NOW() AND used = FALSE
       ORDER BY created_at DESC LIMIT 1`, [userId, otpCode, purpose]);
        if (!row)
            throw new errorHandler_1.AppError(400, 'INVALID_OTP', 'OTP is invalid or has expired.');
        await (0, database_1.query)('UPDATE otp_verifications SET used = TRUE WHERE id = $1', [row.id]);
        if (purpose === 'email') {
            await (0, database_1.query)('UPDATE users SET is_verified = TRUE WHERE id = $1', [userId]);
        }
    },
};
//# sourceMappingURL=auth.service.js.map