import { query } from '../../config/database';
import { NotificationService } from '../notifications/notifications.service';
import { logger } from '../../utils/logger';

/* Medicine schedules built from prescriptions, and the reminder job. All times are IST. */

const IST_MS = 330 * 60000;
export const todayIST = (offsetDays = 0) => new Date(Date.now() + IST_MS + offsetDays * 86400000).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
export const istInstant = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);

const MORNING = '08:00', AFTERNOON = '14:00', EVENING = '18:00', NIGHT = '21:00';

/** Turns a written frequency ("1-0-1", "BD", "twice a day", "at bedtime", "SOS") into reminder times. */
export function timesFromFrequency(freq?: string | null): { times: string[]; guessed: boolean } {
  const f = String(freq || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!f) return { times: [MORNING], guessed: true };
  const m = f.match(/^(\d(?:\.\d)?|½|1\/2)\s*-\s*(\d(?:\.\d)?|½|1\/2)\s*-\s*(\d(?:\.\d)?|½|1\/2)(?:\s*-\s*(\d(?:\.\d)?|½|1\/2))?/);
  if (m) {
    const on = (x?: string) => !!x && x !== '0';
    const slots = m[4] !== undefined ? [MORNING, AFTERNOON, EVENING, NIGHT] : [MORNING, AFTERNOON, NIGHT];
    const times = slots.filter((_, i) => on(m[i + 1]));
    return { times, guessed: false };
  }
  if (/\b(sos|prn|as needed|when needed|if needed|when required|as required)\b/.test(f)) return { times: [], guessed: false };
  const everyH = f.match(/every (\d{1,2}) ?(h|hr|hrs|hour|hours)\b/);
  if (everyH) {
    const step = Math.max(4, Number(everyH[1]));
    const times: string[] = [];
    for (let h = 8; h < 24 && times.length < 6; h += step) times.push(`${String(h).padStart(2, '0')}:00`);
    return { times, guessed: false };
  }
  if (/\b(qid|qds)\b|four times|4 times/.test(f)) return { times: ['08:00', '12:00', '16:00', NIGHT], guessed: false };
  if (/\b(tds|tid)\b|thrice|three times|3 times/.test(f)) return { times: [MORNING, AFTERNOON, NIGHT], guessed: false };
  if (/\b(bd|bid)\b|twice|two times|2 times/.test(f)) return { times: [MORNING, NIGHT], guessed: false };
  if (/\b(hs)\b|bed ?time|at night|night/.test(f)) return { times: ['22:00'], guessed: false };
  if (/\b(od|qd)\b|once|daily|every day|morning|a day/.test(f)) return { times: [MORNING], guessed: false };
  if (/weekly|once a week/.test(f)) return { times: [MORNING], guessed: true };
  return { times: [MORNING], guessed: true };
}

export function validTimes(v: any): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(String).filter(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))].sort().slice(0, 8);
}

/** Creates one schedule per prescribed medicine. */
export async function schedulesFromPrescription(client: any, prescriptionId: string, patientId: string, items: any[]) {
  const start = todayIST();
  for (const it of items || []) {
    if (!it?.medicine_name) continue;
    const { times } = timesFromFrequency(it.frequency);
    const days = Number(it.duration_days);
    const end = Number.isFinite(days) && days > 0 ? addDays(start, Math.min(days, 365) - 1) : null;
    await client.query(
      `INSERT INTO medication_schedules (patient_id, prescription_id, medicine_name, dosage, instructions, times, start_date, end_date, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'prescription')`,
      [patientId, String(prescriptionId), it.medicine_name, it.dosage || null,
       [it.frequency, it.instructions].filter(Boolean).join(' · ') || null, times, start, end]);
  }
}

/** Every 5 minutes: create a dose row for each time that has just come due and send one reminder for it. */
export async function runMedicationReminders() {
  const today = todayIST();
  const now = Date.now();
  const rows = await query<any>(
    `SELECT ms.id, ms.medicine_name, ms.dosage, ms.times, u.id AS user_id, u.fcm_token
     FROM medication_schedules ms
     JOIN patients p ON p.id = ms.patient_id
     JOIN users u ON u.id = p.user_id
     WHERE ms.active AND ms.start_date <= $1 AND (ms.end_date IS NULL OR ms.end_date >= $1)
       AND cardinality(ms.times) > 0`, [today]);
  let sent = 0;
  for (const r of rows) {
    for (const t of r.times || []) {
      const due = istInstant(today, t);
      const late = now - due.getTime();
      if (late < 0 || late > 15 * 60000) continue;
      const ins = await query<{ id: number }>(
        `INSERT INTO medication_doses (schedule_id, due_at, status, reminded_at) VALUES ($1,$2,'due',NOW())
         ON CONFLICT (schedule_id, due_at) DO NOTHING RETURNING id`, [r.id, due]);
      if (!ins.length) continue;
      sent++;
      await NotificationService.send({
        userId: r.user_id, type: 'med_reminder', title: `Time for ${r.medicine_name}`,
        body: `${r.dosage ? r.dosage + ' · ' : ''}Tap to mark it taken.`, refType: 'medication', refId: String(r.id), fcmToken: r.fcm_token,
      }).catch(e => logger.warn('Medicine reminder failed', { error: e?.message }));
    }
  }
  if (sent) logger.info(`[Meds] reminders sent: ${sent}`);
}

/** Daily: remind patients the day before a follow-up the doctor asked for. */
export async function runFollowUpReminders() {
  const rows = await query<any>(
    `SELECT cp.id, cp.appointment_id, cp.follow_up_date, u.id AS user_id, u.fcm_token, du.full_name AS doctor_name
     FROM care_plans cp JOIN patients p ON p.id = cp.patient_id JOIN users u ON u.id = p.user_id
     JOIN doctors d ON d.id = cp.doctor_id JOIN users du ON du.id = d.user_id
     WHERE NOT cp.follow_up_reminded AND cp.follow_up_date IS NOT NULL AND cp.follow_up_date <= $1`, [todayIST(1)]);
  for (const r of rows) {
    await NotificationService.send({
      userId: r.user_id, type: 'follow_up', title: 'Follow-up due',
      body: `${r.doctor_name} asked to see you again around now. Book your follow-up from Appointments.`,
      refType: 'appointment', refId: r.appointment_id, fcmToken: r.fcm_token,
    }).catch(() => {});
    await query('UPDATE care_plans SET follow_up_reminded=TRUE WHERE id=$1', [r.id]);
  }
}
