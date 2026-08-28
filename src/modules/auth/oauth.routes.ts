import { Router } from 'express';
import { query, queryOne } from '../../config/database';
import { logger } from '../../utils/logger';
import jwt from 'jsonwebtoken';

const router = Router();

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const BACKEND_URL          = 'https://wellconsult-backend.onrender.com';
const FRONTEND_URL         = 'https://wellconsult-web.onrender.com';
const JWT_SECRET           = process.env.JWT_SECRET || 'secret';
const JWT_REFRESH_SECRET   = process.env.REFRESH_TOKEN_SECRET || 'refresh-secret';

// Step 1: Redirect to Google
router.get('/google', (req, res) => {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${BACKEND_URL}/api/v1/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Step 2: Google callback
router.get('/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) { res.redirect(`${FRONTEND_URL}?oauth_error=no_code`); return; }

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code as string,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${BACKEND_URL}/api/v1/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json() as any;
    if (!tokenData.access_token) { res.redirect(`${FRONTEND_URL}?oauth_error=token_failed`); return; }

    // Get user info from Google
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const googleUser = await userRes.json() as any;

    if (!googleUser.email) { res.redirect(`${FRONTEND_URL}?oauth_error=no_email`); return; }

    // Find or create user
    let user = await queryOne<any>(
      'SELECT id, full_name, role, is_active FROM users WHERE email=$1',
      [googleUser.email]
    );

    if (!user) {
      // Create new patient account
      const [newUser] = await query(
        `INSERT INTO users (full_name, email, password_hash, role, is_verified, is_active, avatar_url)
         VALUES ($1, $2, $3, 'patient', TRUE, TRUE, $4) RETURNING id, full_name, role`,
        [googleUser.name || googleUser.email.split('@')[0], googleUser.email, 'GOOGLE_OAUTH', googleUser.picture || null]
      ) as any[];

      // Create patient record
      await query('INSERT INTO patients (user_id) VALUES ($1)', [newUser.id]);
      user = newUser;
    }

    if (!user.is_active) { res.redirect(`${FRONTEND_URL}?oauth_error=account_disabled`); return; }

    // Get patient/doctor ID
    let patientId = null;
    let doctorId = null;
    if (user.role === 'patient') {
      const p = await queryOne<{ id: string }>('SELECT id FROM patients WHERE user_id=$1', [user.id]);
      patientId = p?.id;
    } else if (user.role === 'doctor') {
      const d = await queryOne<{ id: string }>('SELECT id FROM doctors WHERE user_id=$1', [user.id]);
      doctorId = d?.id;
    }

    // Generate tokens
    const accessToken = jwt.sign(
      { sub: user.id, role: user.role, patientId, doctorId },
      JWT_SECRET,
      { expiresIn: '15m' }
    );
    const refreshToken = jwt.sign({ sub: user.id }, JWT_REFRESH_SECRET, { expiresIn: '30d' });

    const userData = JSON.stringify({
      id: user.id,
      full_name: user.full_name,
      role: user.role,
      patientId,
      doctorId,
    });

    // Redirect to frontend with tokens
    const params = new URLSearchParams({
      access_token: accessToken,
      refresh_token: refreshToken,
      user: userData,
    });

    res.redirect(`${FRONTEND_URL}?${params}`);
  } catch (err) {
    logger.error('Google OAuth error', { error: (err as Error).message });
    res.redirect(`${FRONTEND_URL}?oauth_error=server_error`);
  }
});

export default router;
