import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query, queryOne, withTransaction } from '../../config/database';
import { sendSuccess, sendCreated } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';

/* Doctor availability calendar: weekly working hours (turned into bookable slots),
   slot length, and days or hours off. Existing bookings are never cancelled by a
   schedule change; the doctor is shown any that clash. */

const router = Router();
router.use(authenticate, authorize('doctor'));

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (t: string) => { const [h, m] = t.slice(0, 5).split(':').map(Number); return h * 60 + m; };
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const ds = (v: any) => v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10);
const todayIST = (n = 0) => new Date(Date.now() + 330 * 60000 + n * 86400000).toISOString().slice(0, 10);

/** Joins consecutive slots of a day back into working ranges, e.g. 09:00–13:00. */
function rangesFromSlots(slots: { slot_start: string; slot_end: string }[]) {
  const out: { from: string; to: string }[] = [];
  for (const s of slots.sort((a, b) => a.slot_start.localeCompare(b.slot_start))) {
    const from = String(s.slot_start).slice(0, 5), to = String(s.slot_end).slice(0, 5);
    const last = out[out.length - 1];
    if (last && last.to === from) last.to = to; else out.push({ from, to });
  }
  return out;
}

router.get('/me', async (req, res, next) => {
  try {
    const dId = req.user!.doctorId!;
    const doc = await queryOne<any>('SELECT slot_minutes FROM doctors WHERE id=$1', [dId]);
    const slots = await query<any>('SELECT day_of_week, slot_start::text, slot_end::text FROM doctor_availability WHERE doctor_id=$1 AND is_active', [dId]);
    const weekly: Record<number, { from: string; to: string }[]> = {};
    for (let d = 0; d < 7; d++) weekly[d] = rangesFromSlots(slots.filter(s => Number(s.day_of_week) === d));
    const timeOff = await query<any>(`SELECT id, off_date, from_time::text, to_time::text, reason FROM doctor_time_off WHERE doctor_id=$1 AND off_date >= $2 ORDER BY off_date, from_time NULLS FIRST`, [dId, todayIST()]);
    const appts = await query<any>(
      `SELECT a.id, a.appt_date, a.appt_time::text, a.consult_type, a.status, u.full_name AS patient_name
       FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN users u ON u.id=p.user_id
       WHERE a.doctor_id=$1 AND a.appt_date BETWEEN $2 AND $3 AND a.status IN ('booked','confirmed','ongoing','pending_payment')
       ORDER BY a.appt_date, a.appt_time`, [dId, todayIST(), todayIST(27)]);
    sendSuccess(res, {
      slot_minutes: Number(doc?.slot_minutes || 30), weekly,
      time_off: timeOff.map(t => ({ ...t, off_date: ds(t.off_date), from_time: t.from_time?.slice(0, 5) || null, to_time: t.to_time?.slice(0, 5) || null })),
      appointments: appts.map(a => ({ ...a, appt_date: ds(a.appt_date), appt_time: String(a.appt_time).slice(0, 5) })),
    });
  } catch (e) { next(e); }
});

router.put('/me/weekly', async (req, res, next) => {
  try {
    const dId = req.user!.doctorId!;
    const b = req.body || {};
    const len = [15, 20, 30, 45, 60].includes(Number(b.slot_minutes)) ? Number(b.slot_minutes) : 30;
    const rows: [number, string, string][] = [];
    for (let d = 0; d < 7; d++) {
      const ranges = Array.isArray(b.weekly?.[d]) ? b.weekly[d] : [];
      const taken = new Set<number>();
      for (const r of ranges.slice(0, 6)) {
        if (!HHMM.test(r?.from || '') || !HHMM.test(r?.to || '')) throw new AppError(400, 'INVALID', 'Use times like 09:00.');
        const s = toMin(r.from), e = toMin(r.to);
        if (e - s < len) throw new AppError(400, 'INVALID', `Each period must be at least ${len} minutes long.`);
        for (let m = s; m + len <= e; m += len) {
          if (taken.has(m)) throw new AppError(400, 'OVERLAP', 'Two working periods on the same day overlap.');
          taken.add(m); rows.push([d, toHHMM(m), toHHMM(m + len)]);
        }
      }
    }
    await withTransaction(async (client) => {
      await client.query('DELETE FROM doctor_availability WHERE doctor_id=$1', [dId]);
      for (const [d, s, e] of rows)
        await client.query('INSERT INTO doctor_availability (doctor_id, day_of_week, slot_start, slot_end, is_active) VALUES ($1,$2,$3,$4,TRUE)', [dId, d, s, e]);
      await client.query('UPDATE doctors SET slot_minutes=$1 WHERE id=$2', [len, dId]);
    });
    // Upcoming bookings that no longer fall inside working hours (kept; the doctor decides).
    const upcoming = await query<any>(
      `SELECT a.id, a.appt_date, a.appt_time::text, u.full_name AS patient_name FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN users u ON u.id=p.user_id
       WHERE a.doctor_id=$1 AND a.appt_date >= $2 AND a.status IN ('booked','confirmed') AND NOT a.is_instant`, [dId, todayIST()]).catch(() => []);
    const conflicts = upcoming.filter(a => {
      const dow = new Date(`${ds(a.appt_date)}T00:00:00Z`).getUTCDay();
      const t = toMin(String(a.appt_time));
      return !rows.some(([d, s, e]) => d === dow && toMin(s) <= t && t < toMin(e));
    }).map(a => ({ id: a.id, appt_date: ds(a.appt_date), appt_time: String(a.appt_time).slice(0, 5), patient_name: a.patient_name }));
    sendSuccess(res, { slots: rows.length, slot_minutes: len, conflicts });
  } catch (e) { next(e); }
});

router.post('/me/time-off', async (req, res, next) => {
  try {
    const dId = req.user!.doctorId!;
    const b = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.off_date || '') || b.off_date < todayIST()) throw new AppError(400, 'INVALID', 'Choose today or a future date.');
    const to = b.to_date && /^\d{4}-\d{2}-\d{2}$/.test(b.to_date) ? b.to_date : b.off_date;
    if (to < b.off_date) throw new AppError(400, 'INVALID', 'The end date is before the start date.');
    const partial = b.from_time && b.to_time;
    if (partial && (!HHMM.test(b.from_time) || !HHMM.test(b.to_time) || b.to_time <= b.from_time)) throw new AppError(400, 'INVALID', 'Check the times.');
    const days: string[] = [];
    for (let d = new Date(`${b.off_date}T00:00:00Z`); d.toISOString().slice(0, 10) <= to && days.length < 60; d = new Date(d.getTime() + 86400000)) days.push(d.toISOString().slice(0, 10));
    for (const day of days)
      await query('INSERT INTO doctor_time_off (doctor_id, off_date, from_time, to_time, reason) VALUES ($1,$2,$3,$4,$5)',
        [dId, day, partial ? b.from_time : null, partial ? b.to_time : null, b.reason ? String(b.reason).slice(0, 200) : null]);
    const conflicts = await query<any>(
      `SELECT a.id, a.appt_date, a.appt_time::text, u.full_name AS patient_name FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN users u ON u.id=p.user_id
       WHERE a.doctor_id=$1 AND a.appt_date = ANY($2::date[]) AND a.status IN ('booked','confirmed','pending_payment')
         AND ($3::time IS NULL OR (a.appt_time >= $3::time AND a.appt_time < $4::time))`,
      [dId, days, partial ? b.from_time : null, partial ? b.to_time : null]);
    sendCreated(res, { days: days.length, conflicts: conflicts.map(a => ({ id: a.id, appt_date: ds(a.appt_date), appt_time: String(a.appt_time).slice(0, 5), patient_name: a.patient_name })) });
  } catch (e) { next(e); }
});

router.delete('/me/time-off/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM doctor_time_off WHERE id=$1 AND doctor_id=$2 RETURNING id', [req.params.id, req.user!.doctorId]);
    if (!r.length) throw new AppError(404, 'NOT_FOUND', 'Not found.');
    sendSuccess(res, { deleted: true });
  } catch (e) { next(e); }
});

export default router;
