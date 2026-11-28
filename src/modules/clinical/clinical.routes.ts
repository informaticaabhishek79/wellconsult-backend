import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query, queryOne } from '../../config/database';
import { sendSuccess, sendCreated } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';
import { NotificationService } from '../notifications/notifications.service';
import { mailer } from '../../utils/mailer';
import { checkAllergies, normaliseAllergies } from './allergy';
import { todayIST, addDays, istInstant, validTimes, timesFromFrequency } from './meds';

/* ─────────────────────────────────────────────────────────────────────────────
   Connected care: pre-consultation assessment, care plan, health timeline,
   medicine schedules and drug-allergy checks.
   ───────────────────────────────────────────────────────────────────────────── */

const router = Router();
router.use(authenticate);

const s = (v: any, max = 2000) => (v == null ? null : String(v).trim().slice(0, max) || null);
const esc = (v: any) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

async function patientIdFor(userId: string) {
  const p = await queryOne<{ id: string }>('SELECT id FROM patients WHERE user_id=$1', [userId]);
  if (!p) throw new AppError(404, 'NOT_FOUND', 'Patient profile not found.');
  return p.id;
}

/** Loads an appointment the caller is part of (its patient or its doctor). */
async function apptFor(id: string, user: any) {
  const a = await queryOne<any>(
    `SELECT a.*, pu.id AS patient_user_id, pu.full_name AS patient_name, pu.email AS patient_email, pu.fcm_token AS patient_fcm,
            du.full_name AS doctor_name, d.medical_system
     FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN users pu ON pu.id=p.user_id
     JOIN doctors d ON d.id=a.doctor_id JOIN users du ON du.id=d.user_id WHERE a.id=$1`, [id]);
  if (!a) throw new AppError(404, 'NOT_FOUND', 'Appointment not found.');
  const role = user.role === 'patient' && a.patient_user_id === user.sub ? 'patient'
    : user.role === 'doctor' && a.doctor_id === user.doctorId ? 'doctor' : null;
  if (!role) throw new AppError(403, 'FORBIDDEN', 'You are not part of this appointment.');
  return { a, role };
}

async function doctorCanSeePatient(doctorId: string, patientId: string) {
  const r = await queryOne('SELECT 1 FROM appointments WHERE doctor_id=$1 AND patient_id=$2 LIMIT 1', [doctorId, patientId]);
  if (!r) throw new AppError(403, 'FORBIDDEN', 'You can only see patients who have booked with you.');
}

export async function patientAllergies(patientId: string): Promise<string[]> {
  const h = await queryOne<any>('SELECT allergies FROM patient_medical_history WHERE patient_id=$1', [patientId]).catch(() => null);
  return normaliseAllergies(h?.allergies);
}

/* ── Pre-consultation assessment ─────────────────────────────────────────── */

// Symptoms the patient can tick that mean "get emergency care, don't wait".
const RED_FLAG_SYMPTOMS: Record<string, string> = {
  chest_pain: 'Chest pain or pressure',
  breathlessness: 'Severe difficulty breathing',
  fainting: 'Fainting or unconsciousness',
  one_side_weakness: 'Weakness, numbness or drooping on one side',
  confusion: 'Sudden confusion or trouble speaking',
  seizure: 'Seizure / fits',
  severe_bleeding: 'Heavy bleeding',
  suicidal_thoughts: 'Thoughts of harming yourself',
  severe_allergic: 'Swelling of face/lips or throat after a medicine or food',
};

function redFlags(symptoms: string[], v: any): string[] {
  const out = symptoms.filter(k => RED_FLAG_SYMPTOMS[k]).map(k => RED_FLAG_SYMPTOMS[k]);
  const n = (x: any) => (x === '' || x == null ? null : Number(x));
  const spo2 = n(v.spo2), temp = n(v.temp_f), sys = n(v.bp_systolic), dia = n(v.bp_diastolic), pulse = n(v.pulse), sugar = n(v.sugar);
  if (spo2 != null && spo2 < 92) out.push(`Oxygen level ${spo2}% (below 92%)`);
  if (temp != null && temp >= 104) out.push(`Very high fever ${temp}°F`);
  if (sys != null && (sys >= 180 || sys < 90)) out.push(`Blood pressure ${sys}${dia ? '/' + dia : ''}`);
  if (pulse != null && (pulse > 130 || pulse < 45)) out.push(`Pulse ${pulse}/min`);
  if (sugar != null && (sugar > 400 || sugar < 70)) out.push(`Blood sugar ${sugar} mg/dL`);
  return out;
}

router.get('/appointments/:id', async (req, res, next) => {
  try {
    const { a, role } = await apptFor(req.params.id, req.user);
    const assessment = await queryOne('SELECT * FROM pre_assessments WHERE appointment_id=$1', [a.id]);
    const care_plan = await queryOne('SELECT * FROM care_plans WHERE appointment_id=$1', [a.id]);
    const prescriptions = await query(
      `SELECT p.id, p.issued_at, JSON_AGG(pi ORDER BY pi.id) FILTER (WHERE pi.id IS NOT NULL) AS items
       FROM prescriptions p LEFT JOIN prescription_items pi ON pi.prescription_id=p.id
       WHERE p.appointment_id=$1 GROUP BY p.id ORDER BY p.issued_at`, [String(a.id)]).catch(() => []);
    const history = role === 'doctor'
      ? await queryOne<any>('SELECT blood_group, chronic_conditions, allergies, current_medications, past_surgeries FROM patient_medical_history WHERE patient_id=$1', [a.patient_id]).catch(() => null)
      : null;
    sendSuccess(res, {
      appointment: { id: a.id, status: a.status, consult_type: a.consult_type, appt_date: a.appt_date, appt_time: a.appt_time,
        patient_id: role === 'doctor' ? a.patient_id : undefined, patient_name: a.patient_name, doctor_name: a.doctor_name, medical_system: a.medical_system },
      role, assessment, care_plan, prescriptions, history,
      allergies: await patientAllergies(a.patient_id),
      red_flag_options: RED_FLAG_SYMPTOMS,
    });
  } catch (e) { next(e); }
});

router.put('/appointments/:id/assessment', authorize('patient'), async (req, res, next) => {
  try {
    const { a } = await apptFor(req.params.id, req.user);
    if (!['pending_payment', 'booked', 'confirmed', 'ongoing'].includes(a.status))
      throw new AppError(409, 'CLOSED', 'The assessment can only be filled before or during the consultation.');
    const b = req.body || {};
    const complaint = s(b.chief_complaint, 500);
    if (!complaint) throw new AppError(400, 'MISSING_FIELDS', 'Tell the doctor the main reason for the consultation.');
    const symptoms = Array.isArray(b.symptoms) ? b.symptoms.map((x: any) => String(x).slice(0, 60)).slice(0, 40) : [];
    const vitals: any = {};
    for (const k of ['temp_f', 'bp_systolic', 'bp_diastolic', 'pulse', 'spo2', 'sugar', 'weight_kg']) {
      const n = Number(b.vitals?.[k]); if (b.vitals?.[k] !== '' && b.vitals?.[k] != null && Number.isFinite(n)) vitals[k] = n;
    }
    const allergies = normaliseAllergies(b.allergies);
    const flags = redFlags(symptoms, vitals);
    const sev = Number(b.severity);
    const row = await queryOne(
      `INSERT INTO pre_assessments (appointment_id, patient_id, chief_complaint, duration, severity, symptoms, current_medicines, allergies, vitals, notes, red_flags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (appointment_id) DO UPDATE SET chief_complaint=$3, duration=$4, severity=$5, symptoms=$6, current_medicines=$7,
         allergies=$8, vitals=$9, notes=$10, red_flags=$11, updated_at=NOW()
       RETURNING *`,
      [a.id, a.patient_id, complaint, s(b.duration, 100), Number.isFinite(sev) ? Math.min(10, Math.max(1, Math.round(sev))) : null,
       JSON.stringify(symptoms), s(b.current_medicines, 1000), JSON.stringify(allergies), JSON.stringify(vitals), s(b.notes, 2000), JSON.stringify(flags)]);

    // Keep the health profile in step: allergies the patient adds here become part of their record.
    if (allergies.length) {
      const h = await queryOne<any>('SELECT allergies FROM patient_medical_history WHERE patient_id=$1', [a.patient_id]);
      if (h) {
        const merged = [...new Set([...normaliseAllergies(h.allergies), ...allergies])];
        await query('UPDATE patient_medical_history SET allergies=$1, updated_at=NOW() WHERE patient_id=$2', [JSON.stringify(merged), a.patient_id]);
      } else {
        await query('INSERT INTO patient_medical_history (patient_id, allergies) VALUES ($1,$2)', [a.patient_id, JSON.stringify(allergies)]);
      }
    }
    if (flags.length) {
      try {
        const { io } = await import('../chat/chat.gateway');
        io?.to(`doctor:${a.doctor_id}`).emit('assessment_red_flag', { appointmentId: a.id, patientName: a.patient_name, flags });
      } catch { /* optional */ }
    }
    sendSuccess(res, { ...row, urgent: flags.length > 0 });
  } catch (e) { next(e); }
});

/* ── Care plan (doctor) ──────────────────────────────────────────────────── */

router.put('/appointments/:id/care-plan', authorize('doctor'), async (req, res, next) => {
  try {
    const { a } = await apptFor(req.params.id, req.user);
    if (!['confirmed', 'ongoing', 'completed'].includes(a.status))
      throw new AppError(409, 'NOT_READY', 'A care plan can be written once the appointment is confirmed.');
    const b = req.body || {};
    let follow: string | null = null;
    if (b.follow_up_date && /^\d{4}-\d{2}-\d{2}$/.test(b.follow_up_date)) follow = b.follow_up_date;
    else if (Number(b.follow_up_days) > 0) follow = addDays(todayIST(), Math.min(365, Number(b.follow_up_days)));
    const tests = Array.isArray(b.tests) ? b.tests.map((t: any) => String(t).trim().slice(0, 120)).filter(Boolean).slice(0, 20) : [];
    const existing = await queryOne('SELECT id FROM care_plans WHERE appointment_id=$1', [a.id]);
    const row = await queryOne<any>(
      `INSERT INTO care_plans (appointment_id, doctor_id, patient_id, diagnosis, summary, advice, diet, lifestyle, warning_signs, tests, follow_up_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (appointment_id) DO UPDATE SET diagnosis=$4, summary=$5, advice=$6, diet=$7, lifestyle=$8, warning_signs=$9, tests=$10,
         follow_up_date=$11, follow_up_reminded = (care_plans.follow_up_date IS NOT DISTINCT FROM $11) AND care_plans.follow_up_reminded, updated_at=NOW()
       RETURNING *`,
      [a.id, a.doctor_id, a.patient_id, s(b.diagnosis, 300), s(b.summary), s(b.advice), s(b.diet), s(b.lifestyle), s(b.warning_signs), JSON.stringify(tests), follow]);

    const title = existing ? `${a.doctor_name} updated your care plan` : `Your care plan from ${a.doctor_name} is ready`;
    NotificationService.send({ userId: a.patient_user_id, type: 'care_plan', title, body: 'Open Appointments to read it.', refType: 'appointment', refId: a.id, fcmToken: a.patient_fcm }).catch(() => {});
    if (a.patient_email) {
      const sec = (h: string, v: any) => (v ? `<h3 style="margin:16px 0 4px;color:#0F1F4B">${h}</h3><div style="white-space:pre-wrap">${esc(v)}</div>` : '');
      mailer.emails.send({
        to: a.patient_email, subject: title,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;color:#334155">
          <h2 style="color:#0A7B6C">Deemona Doctors</h2><p>Hi ${esc(a.patient_name)}, here is your care plan from ${esc(a.doctor_name)}.</p>
          ${sec('Diagnosis', row.diagnosis)}${sec('Summary', row.summary)}${sec('What to do', row.advice)}${sec('Diet', row.diet)}${sec('Lifestyle', row.lifestyle)}
          ${tests.length ? sec('Tests advised', tests.join('\n')) : ''}${sec('Get urgent help if', row.warning_signs)}
          ${follow ? `<p><b>Follow-up:</b> around ${follow}. We'll remind you the day before.</p>` : ''}
          <p style="color:#991B1B">In an emergency call 112.</p></div>`,
      }).catch(() => {});
    }
    sendSuccess(res, row);
  } catch (e) { next(e); }
});

/* ── Allergy check (doctor, while writing a prescription) ────────────────── */

router.post('/allergy-check', authorize('doctor'), async (req, res, next) => {
  try {
    const { appointment_id, medicines } = req.body || {};
    const { a } = await apptFor(String(appointment_id), req.user);
    const allergies = await patientAllergies(a.patient_id);
    sendSuccess(res, { allergies, warnings: checkAllergies(allergies, Array.isArray(medicines) ? medicines.map(String) : []) });
  } catch (e) { next(e); }
});

/* ── Health timeline ─────────────────────────────────────────────────────── */

async function timeline(patientId: string) {
  const items: any[] = [];
  const push = (rows: any[], f: (r: any) => any) => rows.forEach(r => items.push(f(r)));
  const safe = (p: Promise<any[]>) => p.catch(() => [] as any[]);
  const [appts, assess, plans, rx, recs, meds] = await Promise.all([
    safe(query<any>(`SELECT a.id, a.status, a.consult_type, a.appt_date, a.appt_time, a.created_at, du.full_name AS doctor_name, d.medical_system
                     FROM appointments a JOIN doctors d ON d.id=a.doctor_id JOIN users du ON du.id=d.user_id
                     WHERE a.patient_id=$1 AND a.status <> 'pending_payment'`, [patientId])),
    safe(query<any>(`SELECT appointment_id, chief_complaint, severity, red_flags, created_at FROM pre_assessments WHERE patient_id=$1`, [patientId])),
    safe(query<any>(`SELECT cp.appointment_id, cp.diagnosis, cp.summary, cp.follow_up_date, cp.created_at, du.full_name AS doctor_name
                     FROM care_plans cp JOIN doctors d ON d.id=cp.doctor_id JOIN users du ON du.id=d.user_id WHERE cp.patient_id=$1`, [patientId])),
    safe(query<any>(`SELECT p.id, p.issued_at, du.full_name AS doctor_name, ARRAY_REMOVE(ARRAY_AGG(pi.medicine_name ORDER BY pi.id), NULL) AS medicines
                     FROM prescriptions p JOIN doctors d ON d.id=p.doctor_id JOIN users du ON du.id=d.user_id
                     LEFT JOIN prescription_items pi ON pi.prescription_id=p.id WHERE p.patient_id=$1 GROUP BY p.id, du.full_name`, [patientId])),
    safe(query<any>(`SELECT id, test_name, category, report_date, created_at FROM patient_records WHERE patient_id=$1`, [patientId])),
    safe(query<any>(`SELECT id, medicine_name, dosage, start_date, end_date, created_at FROM medication_schedules WHERE patient_id=$1 AND source='manual'`, [patientId])),
  ]);
  const dstr = (v: any) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10));
  push(appts, r => ({ type: 'appointment', at: istInstant(dstr(r.appt_date), String(r.appt_time).slice(0, 5)).toISOString(), ref: r.id,
    title: `${r.consult_type[0].toUpperCase() + r.consult_type.slice(1)} consultation with ${r.doctor_name}`, detail: r.medical_system, status: r.status }));
  push(assess, r => ({ type: 'assessment', at: r.created_at, ref: r.appointment_id, title: `Symptoms reported: ${r.chief_complaint}`,
    detail: r.severity ? `Severity ${r.severity}/10` : null, status: (r.red_flags || []).length ? 'urgent' : null }));
  push(plans, r => ({ type: 'care_plan', at: r.created_at, ref: r.appointment_id, title: `Care plan from ${r.doctor_name}${r.diagnosis ? ': ' + r.diagnosis : ''}`,
    detail: r.follow_up_date ? `Follow-up around ${dstr(r.follow_up_date)}` : r.summary?.slice(0, 140) || null }));
  push(rx, r => ({ type: 'prescription', at: r.issued_at, ref: r.id, title: `Prescription from ${r.doctor_name}`, detail: (r.medicines || []).join(', ') || null }));
  push(recs, r => ({ type: 'record', at: r.report_date ? istInstant(dstr(r.report_date), '09:00').toISOString() : r.created_at, ref: r.id,
    title: `Report uploaded: ${r.test_name}`, detail: r.category }));
  push(meds, r => ({ type: 'medicine', at: r.created_at, ref: r.id, title: `Started ${r.medicine_name}`, detail: r.dosage }));
  return items.sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime()).slice(0, 300);
}

router.get('/me/timeline', authorize('patient'), async (req, res, next) => {
  try { sendSuccess(res, await timeline(await patientIdFor(req.user!.sub))); } catch (e) { next(e); }
});

router.get('/patients/:patientId/timeline', authorize('doctor'), async (req, res, next) => {
  try {
    await doctorCanSeePatient(req.user!.doctorId!, req.params.patientId);
    sendSuccess(res, await timeline(req.params.patientId));
  } catch (e) { next(e); }
});

/* ── Medicines (patient) ─────────────────────────────────────────────────── */

router.get('/me/medicines', authorize('patient'), async (req, res, next) => {
  try {
    const pid = await patientIdFor(req.user!.sub);
    const today = todayIST();
    const schedules = await query<any>(
      `SELECT ms.*, du.full_name AS doctor_name FROM medication_schedules ms
       LEFT JOIN prescriptions p ON p.id::text = ms.prescription_id
       LEFT JOIN doctors d ON d.id = p.doctor_id LEFT JOIN users du ON du.id = d.user_id
       WHERE ms.patient_id=$1 AND (ms.end_date IS NULL OR ms.end_date >= $2::date - 14)
       ORDER BY ms.active DESC, ms.created_at DESC`, [pid, today]);
    const doses = await query<any>(
      `SELECT md.schedule_id, md.due_at, md.status FROM medication_doses md JOIN medication_schedules ms ON ms.id=md.schedule_id
       WHERE ms.patient_id=$1 AND md.due_at >= NOW() - INTERVAL '8 days'`, [pid]);
    const key = (id: any, at: any) => `${id}|${new Date(at).toISOString()}`;
    const doseMap = new Map(doses.map(d => [key(d.schedule_id, d.due_at), d.status]));
    const ds = (v: any) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : v ? String(v).slice(0, 10) : null);
    const todayList: any[] = [];
    for (const m of schedules) {
      m.start_date = ds(m.start_date); m.end_date = ds(m.end_date);
      const runningToday = m.active && m.start_date <= today && (!m.end_date || m.end_date >= today);
      m.running = runningToday;
      if (!runningToday) continue;
      for (const t of m.times || []) {
        const due = istInstant(today, t);
        todayList.push({ schedule_id: m.id, medicine_name: m.medicine_name, dosage: m.dosage, time: t, due_at: due.toISOString(),
          status: doseMap.get(key(m.id, due)) === 'taken' || doseMap.get(key(m.id, due)) === 'skipped' ? doseMap.get(key(m.id, due)) : due.getTime() <= Date.now() ? 'due' : 'upcoming' });
      }
    }
    todayList.sort((x, y) => x.due_at.localeCompare(y.due_at));
    const week = doses.filter(d => new Date(d.due_at).getTime() < Date.now() && new Date(d.due_at).getTime() > Date.now() - 7 * 86400000);
    sendSuccess(res, {
      today: todayList, schedules,
      adherence_7d: { taken: week.filter(d => d.status === 'taken').length, total: week.length },
      allergies: await patientAllergies(pid),
    });
  } catch (e) { next(e); }
});

router.post('/me/doses', authorize('patient'), async (req, res, next) => {
  try {
    const pid = await patientIdFor(req.user!.sub);
    const { schedule_id, due_at, status } = req.body || {};
    if (!['taken', 'skipped'].includes(status)) throw new AppError(400, 'INVALID', 'Status must be taken or skipped.');
    const ms = await queryOne<any>('SELECT id, times FROM medication_schedules WHERE id=$1 AND patient_id=$2', [schedule_id, pid]);
    if (!ms) throw new AppError(404, 'NOT_FOUND', 'Medicine not found.');
    const due = new Date(due_at);
    if (isNaN(due.getTime()) || due.getTime() > Date.now() + 3 * 3600000) throw new AppError(400, 'INVALID', 'You can mark a dose up to 3 hours early.');
    await query(
      `INSERT INTO medication_doses (schedule_id, due_at, status, acted_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (schedule_id, due_at) DO UPDATE SET status=$3, acted_at=NOW()`, [ms.id, due, status]);
    sendSuccess(res, { schedule_id: ms.id, due_at: due.toISOString(), status });
  } catch (e) { next(e); }
});

router.post('/me/medicines', authorize('patient'), async (req, res, next) => {
  try {
    const pid = await patientIdFor(req.user!.sub);
    const b = req.body || {};
    const name = s(b.medicine_name, 120);
    if (!name) throw new AppError(400, 'MISSING_FIELDS', 'Enter the medicine name.');
    const times = b.times ? validTimes(b.times) : timesFromFrequency(b.frequency).times;
    const start = /^\d{4}-\d{2}-\d{2}$/.test(b.start_date || '') ? b.start_date : todayIST();
    const days = Number(b.duration_days);
    const end = /^\d{4}-\d{2}-\d{2}$/.test(b.end_date || '') ? b.end_date : days > 0 ? addDays(start, Math.min(days, 365) - 1) : null;
    const warnings = checkAllergies(await patientAllergies(pid), [name]);
    const row = await queryOne(
      `INSERT INTO medication_schedules (patient_id, medicine_name, dosage, instructions, times, start_date, end_date, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual') RETURNING *`, [pid, name, s(b.dosage, 120), s(b.instructions, 300), times, start, end]);
    sendCreated(res, { ...row, allergy_warnings: warnings });
  } catch (e) { next(e); }
});

router.patch('/me/medicines/:id', authorize('patient'), async (req, res, next) => {
  try {
    const pid = await patientIdFor(req.user!.sub);
    const b = req.body || {};
    const cur = await queryOne<any>('SELECT * FROM medication_schedules WHERE id=$1 AND patient_id=$2', [req.params.id, pid]);
    if (!cur) throw new AppError(404, 'NOT_FOUND', 'Medicine not found.');
    const times = b.times !== undefined ? validTimes(b.times) : cur.times;
    const active = b.active !== undefined ? !!b.active : cur.active;
    const end = b.end_date === null ? null : /^\d{4}-\d{2}-\d{2}$/.test(b.end_date || '') ? b.end_date : cur.end_date;
    const row = await queryOne('UPDATE medication_schedules SET times=$1, active=$2, end_date=$3 WHERE id=$4 RETURNING *', [times, active, end, cur.id]);
    sendSuccess(res, row);
  } catch (e) { next(e); }
});

export default router;
