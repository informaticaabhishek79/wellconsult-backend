import { Router } from 'express';
import crypto from 'crypto';
import { query, queryOne } from '../../config/database';
import { redis } from '../../config/redis';
import { logger } from '../../utils/logger';
import { signAccessToken, signRefreshToken } from '../../utils/jwt';

/* ─────────────────────────────────────────────────────────────────────────────
   Sign in with Google. Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env and,
   in Google Cloud → Credentials → OAuth client (Web application), this redirect URI:
     https://doctors.deemona.com/api/v1/auth/google/callback
   Tokens are issued exactly like an email login (same secrets, refresh token in Redis).
   ───────────────────────────────────────────────────────────────────────────── */

const router = Router();

const CLIENT_ID = () => process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = () => process.env.GOOGLE_CLIENT_SECRET || '';
const APP_URL = () => (process.env.APP_URL || 'https://doctors.deemona.com').replace(/\/$/, '');
const CALLBACK = () => `${APP_URL()}/api/v1/auth/google/callback`;
const enabled = () => !!CLIENT_ID() && !!CLIENT_SECRET();

// One-time codes handed to the browser after Google sign-in (5 minutes).
const sessions = new Map<string, { data: any; expires: number }>();
const sweep = () => { for (const [k, v] of sessions) if (v.expires < Date.now()) sessions.delete(k); };
const back = (res: any, err?: string, code?: string) =>
  res.redirect(`${APP_URL()}/${err ? `?oauth_error=${encodeURIComponent(err)}` : `#oauth_code=${code}`}`);

/** Lets the sign-in page show the Google button only when Google sign-in is configured. */
router.get('/google/status', (_req, res) => { res.json({ success: true, data: { enabled: enabled() } }); });

// Step 1: send the user to Google, with a one-time state value to stop forged callbacks.
router.get('/google', (req, res) => {
  if (!enabled()) { back(res, 'not_configured'); return; }
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('g_state', state, { maxAge: 10 * 60 * 1000, httpOnly: true, secure: true, sameSite: 'lax', path: '/api/v1/auth/google' });
  const params = new URLSearchParams({
    client_id: CLIENT_ID(), redirect_uri: CALLBACK(), response_type: 'code',
    scope: 'openid email profile', prompt: 'select_account', state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Step 2: Google sends the user back here.
router.get('/google/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query as Record<string, string>;
    if (error) { back(res, 'cancelled'); return; }
    if (!code) { back(res, 'no_code'); return; }
    if (!state || state !== req.cookies?.g_state) { back(res, 'state_mismatch'); return; }
    res.clearCookie('g_state', { path: '/api/v1/auth/google' });

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: CLIENT_ID(), client_secret: CLIENT_SECRET(), redirect_uri: CALLBACK(), grant_type: 'authorization_code' }),
    });
    const tokenData = await tokenRes.json() as any;
    if (!tokenData.access_token) { logger.warn('Google token exchange failed', { error: tokenData.error }); back(res, 'token_failed'); return; }

    const g = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokenData.access_token}` } })).json() as any;
    if (!g.email || g.email_verified === false) { back(res, 'no_email'); return; }
    const email = String(g.email).toLowerCase();

    let user = await queryOne<any>('SELECT id, full_name, role, is_active, is_verified FROM users WHERE LOWER(email)=$1', [email]);
    if (!user) {
      // New people who choose Google become patients. Doctors and agents register with email first.
      const [u] = await query<any>(
        `INSERT INTO users (full_name, email, password_hash, role, is_verified, is_active, avatar_url)
         VALUES ($1, $2, 'GOOGLE_OAUTH', 'patient', TRUE, TRUE, $3) RETURNING id, full_name, role`,
        [g.name || email.split('@')[0], email, g.picture || null]);
      await query('INSERT INTO patients (user_id) VALUES ($1)', [u.id]);
      user = { ...u, is_active: true };
    } else if (!user.is_verified) {
      // Google has confirmed they own this address.
      await query('UPDATE users SET is_verified=TRUE WHERE id=$1', [user.id]);
    }
    if (!user.is_active) { back(res, 'account_disabled'); return; }

    const patient = user.role === 'patient' ? await queryOne<{ id: string }>('SELECT id FROM patients WHERE user_id=$1', [user.id]) : null;
    const doctor = user.role === 'doctor' ? await queryOne<{ id: string }>('SELECT id FROM doctors WHERE user_id=$1', [user.id]) : null;
    const payload = { sub: user.id, role: user.role, doctorId: doctor?.id, patientId: patient?.id };
    const accessToken = signAccessToken(payload as any);
    const refreshToken = signRefreshToken({ sub: user.id });
    try { await redis.setEx(`refresh:${user.id}`, 30 * 24 * 60 * 60, refreshToken); } catch (e) { logger.warn('Could not store refresh token', { error: (e as Error).message }); }

    sweep();
    const oneTime = crypto.randomBytes(24).toString('hex');
    sessions.set(oneTime, {
      data: { accessToken, refreshToken, user: { id: user.id, full_name: user.full_name, role: user.role, doctorId: doctor?.id, patientId: patient?.id } },
      expires: Date.now() + 5 * 60 * 1000,
    });
    back(res, undefined, oneTime);
  } catch (err) {
    logger.error('Google OAuth error', { error: (err as Error).message });
    back(res, 'server_error');
  }
});

// Step 3: the browser swaps the one-time code for tokens.
router.post('/google/token', (req, res) => {
  const code = String(req.body?.code || '');
  const s = sessions.get(code);
  sessions.delete(code);
  if (!s || s.expires < Date.now()) { res.status(400).json({ success: false, error: { code: 'OAUTH_EXPIRED', message: 'Google sign-in expired. Please try again.' } }); return; }
  res.json({ success: true, data: s.data });
});

export default router;
