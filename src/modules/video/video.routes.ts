import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { query } from '../../config/database';
import { sendSuccess } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';

const router = Router();

const CF_APP_ID = process.env.CF_CALLS_APP_ID || '';
const CF_APP_TOKEN = process.env.CF_CALLS_APP_TOKEN || '';
const CF_BASE = `https://rtc.live.cloudflare.com/v1/apps/${CF_APP_ID}`;

async function cfRequest(method: string, path: string, body?: any) {
  const res = await fetch(`${CF_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${CF_APP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as any;
  if (!res.ok) throw new Error(`CF error: ${data?.errorCode || res.status}`);
  return data;
}

// Create a new session for a participant
router.post('/session/:appointmentId', authenticate, async (req, res, next) => {
  try {
    const apptId = req.params.appointmentId;

    const [appt] = await query(
      `SELECT a.id, d.user_id AS doctor_user_id, p.user_id AS patient_user_id,
              du.full_name AS doctor_name, pu.full_name AS patient_name
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN patients p ON p.id = a.patient_id
       JOIN users du ON du.id = d.user_id
       JOIN users pu ON pu.id = p.user_id
       WHERE a.id = $1`,
      [apptId]
    ) as any[];

    if (!appt) throw new AppError(404, 'NOT_FOUND', 'Appointment not found.');
    const hasAccess = appt.doctor_user_id === req.user!.sub || appt.patient_user_id === req.user!.sub;
    if (!hasAccess) throw new AppError(403, 'FORBIDDEN', 'Access denied.');

    // Create a new Cloudflare session
    const session = await cfRequest('POST', '/sessions/new', {});
    const isDoctor = appt.doctor_user_id === req.user!.sub;

    sendSuccess(res, {
      session_id: session.sessionId,
      app_id: CF_APP_ID,
      room_id: apptId.slice(0, 12),
      user_name: isDoctor ? appt.doctor_name : appt.patient_name,
      is_doctor: isDoctor,
    });
  } catch (e) { next(e); }
});

// Publish tracks to a session
router.post('/session/:sessionId/tracks', authenticate, async (req, res, next) => {
  try {
    const { tracks } = req.body;
    const result = await cfRequest('POST', `/sessions/${req.params.sessionId}/tracks/new`, { tracks });
    sendSuccess(res, result);
  } catch (e) { next(e); }
});

// Pull tracks from another session
router.put('/session/:sessionId/tracks', authenticate, async (req, res, next) => {
  try {
    const { tracks } = req.body;
    const result = await cfRequest('PUT', `/sessions/${req.params.sessionId}/tracks`, { tracks });
    sendSuccess(res, result);
  } catch (e) { next(e); }
});

// Renegotiate SDP
router.put('/session/:sessionId/renegotiate', authenticate, async (req, res, next) => {
  try {
    const { sessionDescription } = req.body;
    const result = await cfRequest('PUT', `/sessions/${req.params.sessionId}/renegotiate`, { sessionDescription });
    sendSuccess(res, result);
  } catch (e) { next(e); }
});

export default router;
