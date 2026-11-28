import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query, queryOne } from '../../config/database';
import { sendSuccess, sendCreated } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';

/* Home health tracking: BP, sugar, weight, temperature, oxygen, pulse. Ranges follow common adult
   screening thresholds and are shown as guidance only; they are not a diagnosis. */

const router = Router();
router.use(authenticate);

type Status = { level: 'ok' | 'watch' | 'high' | 'low' | 'urgent'; label: string };

export const KINDS: Record<string, { unit: string; min: number; max: number; min2?: number; max2?: number }> = {
  bp: { unit: 'mmHg', min: 50, max: 260, min2: 30, max2: 160 },
  sugar: { unit: 'mg/dL', min: 20, max: 700 },
  weight: { unit: 'kg', min: 1, max: 300 },
  temp: { unit: '°F', min: 90, max: 110 },
  spo2: { unit: '%', min: 50, max: 100 },
  pulse: { unit: '/min', min: 20, max: 250 },
};

export function classify(kind: string, v: number, v2?: number | null, context?: string | null, heightCm?: number | null): Status {
  switch (kind) {
    case 'bp': {
      const d = Number(v2 || 0);
      if (v >= 180 || d >= 120) return { level: 'urgent', label: 'Very high: get medical help now' };
      if (v < 90 || (d && d < 60)) return { level: 'low', label: 'Low' };
      if (v >= 140 || d >= 90) return { level: 'high', label: 'High' };
      if (v >= 130 || d >= 80) return { level: 'watch', label: 'Slightly high' };
      if (v >= 120) return { level: 'watch', label: 'Elevated' };
      return { level: 'ok', label: 'Normal' };
    }
    case 'sugar': {
      if (v < 70) return { level: 'urgent', label: 'Low sugar: eat something sweet now' };
      if (v > 400) return { level: 'urgent', label: 'Very high: get medical help' };
      if (context === 'fasting') return v >= 126 ? { level: 'high', label: 'High (fasting)' } : v >= 100 ? { level: 'watch', label: 'Borderline (fasting)' } : { level: 'ok', label: 'Normal (fasting)' };
      if (context === 'after_meal') return v >= 200 ? { level: 'high', label: 'High (after meal)' } : v >= 140 ? { level: 'watch', label: 'Borderline (after meal)' } : { level: 'ok', label: 'Normal (after meal)' };
      return v >= 200 ? { level: 'high', label: 'High' } : { level: 'ok', label: 'In range' };
    }
    case 'weight': {
      if (!heightCm) return { level: 'ok', label: 'Add height in Medical History to see BMI' };
      const bmi = v / Math.pow(heightCm / 100, 2);
      const b = bmi.toFixed(1);
      // Asian cut-offs (WHO expert consultation): overweight from 23, obese from 27.5.
      if (bmi < 18.5) return { level: 'low', label: `BMI ${b}: underweight` };
      if (bmi < 23) return { level: 'ok', label: `BMI ${b}: healthy` };
      if (bmi < 27.5) return { level: 'watch', label: `BMI ${b}: overweight` };
      return { level: 'high', label: `BMI ${b}: obese` };
    }
    case 'temp':
      if (v >= 104) return { level: 'urgent', label: 'Very high fever' };
      if (v >= 100.4) return { level: 'high', label: 'Fever' };
      if (v >= 99.5) return { level: 'watch', label: 'Slightly raised' };
      if (v < 95) return { level: 'urgent', label: 'Too low: get medical help' };
      return { level: 'ok', label: 'Normal' };
    case 'spo2':
      if (v < 92) return { level: 'urgent', label: 'Low oxygen: get medical help now' };
      if (v < 95) return { level: 'watch', label: 'Slightly low' };
      return { level: 'ok', label: 'Normal' };
    case 'pulse':
      if (v > 130 || v < 45) return { level: 'urgent', label: v > 130 ? 'Very fast' : 'Very slow' };
      if (v > 100) return { level: 'high', label: 'Fast (at rest)' };
      if (v < 60) return { level: 'low', label: 'Slow (normal for some fit people)' };
      return { level: 'ok', label: 'Normal' };
  }
  return { level: 'ok', label: '' };
}

async function patientIdFor(userId: string) {
  const p = await queryOne<{ id: string }>('SELECT id FROM patients WHERE user_id=$1', [userId]);
  if (!p) throw new AppError(404, 'NOT_FOUND', 'Patient profile not found.');
  return p.id;
}

async function readingsFor(patientId: string, days: number) {
  const h = await queryOne<any>('SELECT height_cm FROM patient_medical_history WHERE patient_id=$1', [patientId]).catch(() => null);
  const height = h?.height_cm ? Number(h.height_cm) : null;
  const rows = await query<any>(
    `SELECT id, kind, value, value2, context, note, taken_at, source FROM health_readings
     WHERE patient_id=$1 AND taken_at > NOW() - ($2::int * INTERVAL '1 day') ORDER BY taken_at`, [patientId, days]);
  const out = rows.map(r => ({ ...r, value: Number(r.value), value2: r.value2 == null ? null : Number(r.value2),
    status: classify(r.kind, Number(r.value), r.value2 == null ? null : Number(r.value2), r.context, height) }));
  const latest: Record<string, any> = {};
  for (const r of out) latest[r.kind] = r;
  return { readings: out, latest, height_cm: height, units: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.unit])) };
}

/** Saves readings typed into a pre-consultation form, replacing ones saved earlier from the same form. */
export async function saveVitalsAsReadings(patientId: string, appointmentId: string, v: any) {
  await query(`DELETE FROM health_readings WHERE source='assessment' AND source_ref=$1`, [String(appointmentId)]);
  const add = (kind: string, value: any, value2: any = null) => Number.isFinite(Number(value)) && value !== null && value !== '' &&
    query(`INSERT INTO health_readings (patient_id, kind, value, value2, source, source_ref) VALUES ($1,$2,$3,$4,'assessment',$5)`,
      [patientId, kind, Number(value), value2 == null || value2 === '' ? null : Number(value2), String(appointmentId)]);
  await Promise.all([
    v.bp_systolic != null && add('bp', v.bp_systolic, v.bp_diastolic), v.sugar != null && add('sugar', v.sugar),
    v.weight_kg != null && add('weight', v.weight_kg), v.temp_f != null && add('temp', v.temp_f),
    v.spo2 != null && add('spo2', v.spo2), v.pulse != null && add('pulse', v.pulse),
  ].filter(Boolean));
}

router.get('/me/readings', authorize('patient'), async (req, res, next) => {
  try {
    const days = Math.min(730, Math.max(7, Number(req.query.days) || 90));
    sendSuccess(res, await readingsFor(await patientIdFor(req.user!.sub), days));
  } catch (e) { next(e); }
});

router.post('/me/readings', authorize('patient'), async (req, res, next) => {
  try {
    const pid = await patientIdFor(req.user!.sub);
    const b = req.body || {};
    const k = KINDS[b.kind];
    if (!k) throw new AppError(400, 'INVALID', 'Choose what you measured.');
    const v = Number(b.value), v2 = b.value2 === '' || b.value2 == null ? null : Number(b.value2);
    if (!Number.isFinite(v) || v < k.min || v > k.max) throw new AppError(400, 'OUT_OF_RANGE', `That reading looks wrong. Enter a value between ${k.min} and ${k.max} ${k.unit}.`);
    if (b.kind === 'bp' && (v2 == null || !Number.isFinite(v2) || v2 < k.min2! || v2 > k.max2! || v2 >= v))
      throw new AppError(400, 'OUT_OF_RANGE', 'Enter both numbers of the BP reading, e.g. 120 / 80.');
    const at = b.taken_at ? new Date(b.taken_at) : new Date();
    if (isNaN(at.getTime()) || at.getTime() > Date.now() + 5 * 60000 || at.getTime() < Date.now() - 365 * 86400000) throw new AppError(400, 'INVALID', 'Check the date and time.');
    const context = b.kind === 'sugar' && ['fasting', 'after_meal', 'random'].includes(b.context) ? b.context : null;
    const row = await queryOne<any>(
      `INSERT INTO health_readings (patient_id, kind, value, value2, context, note, taken_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [pid, b.kind, v, b.kind === 'bp' ? v2 : null, context, b.note ? String(b.note).slice(0, 300) : null, at]);
    const h = await queryOne<any>('SELECT height_cm FROM patient_medical_history WHERE patient_id=$1', [pid]).catch(() => null);
    sendCreated(res, { ...row, status: classify(b.kind, v, v2, context, h?.height_cm ? Number(h.height_cm) : null) });
  } catch (e) { next(e); }
});

router.delete('/me/readings/:id', authorize('patient'), async (req, res, next) => {
  try {
    const pid = await patientIdFor(req.user!.sub);
    const r = await query('DELETE FROM health_readings WHERE id=$1 AND patient_id=$2 RETURNING id', [req.params.id, pid]);
    if (!r.length) throw new AppError(404, 'NOT_FOUND', 'Reading not found.');
    sendSuccess(res, { deleted: true });
  } catch (e) { next(e); }
});

router.get('/patients/:patientId/readings', authorize('doctor'), async (req, res, next) => {
  try {
    const ok = await queryOne('SELECT 1 FROM appointments WHERE doctor_id=$1 AND patient_id=$2 LIMIT 1', [req.user!.doctorId, req.params.patientId]);
    if (!ok) throw new AppError(403, 'FORBIDDEN', 'You can only see patients who have booked with you.');
    sendSuccess(res, await readingsFor(req.params.patientId, 180));
  } catch (e) { next(e); }
});

export default router;
