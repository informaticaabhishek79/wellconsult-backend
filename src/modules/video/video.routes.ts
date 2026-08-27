import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { query } from '../../config/database';
import { sendSuccess } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';

const router = Router();
const DAILY_API_KEY = process.env.DAILY_API_KEY || '';
const DAILY_BASE = 'https://api.daily.co/v1';

async function dailyRequest(method: string, path: string, body?: any) {
  const res = await fetch(`${DAILY_BASE}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${DAILY_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(`Daily API error: ${err?.error || res.status}`);
  }
  return res.json();
}

router.post('/room/:appointmentId', authenticate, async (req, res, next) => {
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

    const roomName = `wc-${apptId.slice(0, 8)}`;
    const expiry = Math.floor(Date.now() / 1000) + 3600;

    let room: any;
    try {
      room = await dailyRequest('GET', `/rooms/${roomName}`);
    } catch {
      room = await dailyRequest('POST', '/rooms', {
        name: roomName,
        privacy: 'private',
        properties: { enable_chat: true, enable_screenshare: true, exp: expiry, max_participants: 2 },
      });
    }

    const isDoctor = appt.doctor_user_id === req.user!.sub;
    const token = await dailyRequest('POST', '/meeting-tokens', {
      properties: {
        room_name: roomName,
        user_name: isDoctor ? appt.doctor_name : appt.patient_name,
        is_owner: isDoctor,
        exp: expiry,
      },
    }) as any;

    sendSuccess(res, {
      room_url: room.url,
      token: token.token,
      user_name: isDoctor ? appt.doctor_name : appt.patient_name,
      is_doctor: isDoctor,
    });
  } catch (e) { next(e); }
});

export default router;
