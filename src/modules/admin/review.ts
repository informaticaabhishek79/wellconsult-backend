import { query, queryOne } from '../../config/database';
import { AppError } from '../../middleware/errorHandler';
import { EFFECTIVE_PCT_SQL } from '../../config/schema';

export const REQUIRED_DOCS = ['degree_certificate', 'registration_certificate', 'practice_license', 'id_proof'] as const;

/** Official register each medical system is checked against. */
export function registersFor(system: string) {
  const nmc = [
    { id: 'nmc_imr', label: 'NMC — Indian Medical Register', url: 'https://www.nmc.org.in/information-desk/indian-medical-register/' },
    { id: 'nmc_blacklist', label: 'NMC — Blacklisted doctors', url: 'https://nmc.org.in/indian-medical-register/black-list-doctors' },
  ];
  switch (system) {
    case 'allopathy':   return nmc;
    case 'ayurveda':
    case 'unani':       return [{ id: 'ncism', label: 'NCISM — National Commission for Indian System of Medicine', url: 'https://ncismindia.org/' }];
    case 'homeopathy':  return [{ id: 'nch', label: 'NCH — National Commission for Homoeopathy', url: 'https://www.nch.org.in/' }];
    default:            return [{ id: 'state_board', label: 'State board / council that issued the registration', url: '' }];
  }
}

export async function getDoctorForReview(doctorId: string) {
  const doc = await queryOne<any>(
    `SELECT d.id, d.user_id, u.full_name, u.email, u.phone, d.medical_system, d.degree, d.specialization,
            d.experience_years, d.city, d.bio, d.reg_number, d.reg_body, d.reg_year,
            d.practice_license_no, d.practice_license_authority, d.profile_status, d.rejection_reason,
            d.commission_pct, d.commission_status, d.commission_accepted_pct, d.commission_responded_at,
            ${EFFECTIVE_PCT_SQL} AS offered_pct,
            d.register_check, d.verified_at, d.created_at, d.updated_at
     FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.id = $1`, [doctorId]);
  if (!doc) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');
  const documents = await query(
    `SELECT document_type, file_name, status, uploaded_at FROM doctor_documents WHERE doctor_id=$1 ORDER BY document_type`, [doctorId]);
  return { ...doc, offered_pct: Number(doc.offered_pct), documents, registers: registersFor(doc.medical_system), checklist: checklist(doc, documents as any[]) };
}

export function checklist(doc: any, documents: any[]) {
  const have = new Set(documents.map(d => d.document_type));
  const missingDocs = REQUIRED_DOCS.filter(t => !have.has(t));
  const offered = Number(doc.offered_pct);
  const accepted = doc.commission_status === 'accepted' && doc.commission_accepted_pct != null && Number(doc.commission_accepted_pct) === offered;
  const rc = doc.register_check || {};
  const registerOk = !!(rc.found && rc.name_matches && rc.reg_number_matches && rc.not_blacklisted);
  const items = [
    { key: 'documents',  ok: missingDocs.length === 0, label: 'All required documents uploaded', detail: missingDocs.length ? `Missing: ${missingDocs.map(m => m.replace(/_/g, ' ')).join(', ')}` : '' },
    { key: 'registration', ok: !!(doc.reg_number && doc.reg_body), label: 'Registration number and council provided', detail: '' },
    { key: 'license',    ok: !!doc.practice_license_no, label: 'Practice licence number provided', detail: '' },
    { key: 'commission', ok: accepted, label: `Doctor accepted ${offered}% platform commission`,
      detail: doc.commission_status === 'declined' ? 'Doctor declined the commission' : doc.commission_status === 'accepted' && !accepted ? `Accepted ${doc.commission_accepted_pct}% — new rate not yet accepted` : doc.commission_status === 'pending' ? 'Waiting for the doctor to accept' : '' },
    { key: 'register',   ok: registerOk, label: 'Admin checked the official medical register', detail: rc.checked_at ? (registerOk ? '' : 'Register check did not pass') : 'Not checked yet' },
  ];
  return { ready: items.every(i => i.ok), items };
}

export async function decide(doctorId: string, adminId: string, decision: 'approved' | 'rejected', reason?: string) {
  const d = await getDoctorForReview(doctorId);
  if (decision === 'approved') {
    if (!d.checklist.ready) {
      const open = d.checklist.items.filter((i: any) => !i.ok).map((i: any) => i.label + (i.detail ? ` (${i.detail})` : '')).join('; ');
      throw new AppError(422, 'NOT_READY', `Cannot verify yet: ${open}.`);
    }
    await query(`UPDATE doctors SET profile_status='verified', verified_at=NOW(), verified_by=$2, rejection_reason=NULL, updated_at=NOW() WHERE id=$1`, [doctorId, adminId]);
  } else {
    if (!reason || !reason.trim()) throw new AppError(400, 'REASON_REQUIRED', 'Please give a reason for rejection.');
    await query(`UPDATE doctors SET profile_status='rejected', rejection_reason=$2, verified_at=NULL, updated_at=NOW() WHERE id=$1`, [doctorId, reason.trim().slice(0, 500)]);
  }
  return { status: decision === 'approved' ? 'verified' : 'rejected' };
}
