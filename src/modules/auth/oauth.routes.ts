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

// Temporary session store (in-memory, expires in 5 min)
const oauthSessions = new Map<string, any>();

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

// Step 2: Google callback - store session, redirect with short code
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
      const [newUser] = await query(
        `INSERT INTO users (full_name, email, password_hash, role, is_verified, is_active, avatar_url)
         VALUES ($1, $2, 'GOOGLE_OAUTH', 'patient', TRUE, TRUE, $3) RETURNING id, full_name, role`,
        [googleUser.name || googleUser.email.split('@')[0], googleUser.email, googleUser.picture || null]
      ) as any[];
      await query('INSERT INTO patients (user_id) VALUES ($1)', [newUser.id]);
      user = { ...newUser, is_active: true };
    }

    if (!user.is_active) { res.redirect(`${FRONTEND_URL}?oauth_error=account_disabled`); return; }

    // Get patient/doctor ID
    let patientId = null, doctorId = null;
    if (user.role === 'patient') {
      const p = await queryOne<{ id: string }>('SELECT id FROM patients WHERE user_id=$1', [user.id]);
      patientId = p?.id;
    } else if (user.role === 'doctor') {
      const d = await queryOne<{ id: string }>('SELECT id FROM doctors WHERE user_id=$1', [user.id]);
      doctorId = d?.id;
    }

    // Generate JWT tokens
    const accessToken  = jwt.sign({ sub: user.id, role: user.role, patientId, doctorId }, JWT_SECRET, { expiresIn: '15m' });
    const refreshToken = jwt.sign({ sub: user.id }, JWT_REFRESH_SECRET, { expiresIn: '30d' });

    // Store in memory with short code
    const sessionCode = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    oauthSessions.set(sessionCode, {
      accessToken, refreshToken,
      user: { id: user.id, full_name: user.full_name, role: user.role, patientId, doctorId },
      expires: Date.now() + 5 * 60 * 1000,
    });

    // Cleanup old sessions
    for (const [k, v] of oauthSessions) {
      if (v.expires < Date.now()) oauthSessions.delete(k);
    }

    // Use HTML page to pass code via localStorage then redirect
    const html = '<!DOCTYPE html><html><head><title>Signing you in...</title></head><body><script>try{localStorage.setItem("oauth_code","' + sessionCode + '");window.location.href="' + FRONTEND_URL + '";}catch(e){window.location.href="' + FRONTEND_URL + '?oauth_error=storage_failed";}</' + 'script><p>Signing you in, please wait...</p></body></html>';
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    logger.error('Google OAuth error', { error: (err as Error).message });
    res.redirect(`${FRONTEND_URL}?oauth_error=server_error`);
  }
});

// Step 3: Frontend exchanges code for tokens
router.post('/google/token', async (req, res) => {
  const { code } = req.body;
  if (!code) { res.status(400).json({ success: false, error: { message: 'No code provided' } }); return; }

  const session = oauthSessions.get(code);
  if (!session || session.expires < Date.now()) {
    res.status(400).json({ success: false, error: { message: 'Invalid or expired OAuth code' } });
    return;
  }

  oauthSessions.delete(code);
  res.json({ success: true, data: session });
});

export default router;
