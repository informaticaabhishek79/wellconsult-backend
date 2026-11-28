import { queryOne, query } from '../../config/database';
import { JwtPayload } from '../../utils/jwt';

/* ─────────────────────────────────────────────────────────────────────────────
   Family profiles. Each family member is a real patient (users + patients rows)
   with no way to log in; the account holder acts for them by sending the
   X-Act-As header (member's user id). Consent is recorded when the member is
   added; a minor who has turned 18 needs fresh consent before anyone acts for them.
   ───────────────────────────────────────────────────────────────────────────── */

export const MEMBER_DOMAIN = 'members.deemona.invalid';

/** SQL for the email to reach a patient: family members' mail goes to the account holder. */
export const patientEmailSql = (u: string) =>
  `(CASE WHEN ${u}.email LIKE '%@${MEMBER_DOMAIN}' THEN (SELECT ou.email FROM family_members fm JOIN users ou ON ou.id = fm.owner_user_id WHERE fm.member_user_id = ${u}.id LIMIT 1) ELSE ${u}.email END)`;

export function ageOn(dob: string | Date | null | undefined, at = new Date()): number | null {
  if (!dob) return null;
  const d = dob instanceof Date ? dob : new Date(`${String(dob).slice(0, 10)}T00:00:00`);
  if (isNaN(d.getTime())) return null;
  let a = at.getFullYear() - d.getFullYear();
  const m = at.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && at.getDate() < d.getDate())) a--;
  return a;
}

/** Guardian consent given while the member was a child is not enough once they are an adult. */
export function consentNeeded(m: { consent_type: string; dob: any }) {
  const age = ageOn(m.dob);
  return m.consent_type === 'guardian' && age != null && age >= 18;
}

export class ActAsError extends Error {}

/** Swaps the caller for the family member they are acting for, after checking the link and consent. */
export async function resolveActAs(payload: JwtPayload, actAs?: string | null): Promise<JwtPayload> {
  if (!actAs || actAs === payload.sub) return payload;
  if (payload.role !== 'patient') throw new ActAsError('Only patients can act for family members.');
  const m = await queryOne<any>(
    `SELECT fm.member_user_id, fm.consent_type, p.date_of_birth AS dob, p.id AS patient_id
     FROM family_members fm JOIN patients p ON p.user_id = fm.member_user_id
     WHERE fm.owner_user_id = $1 AND fm.member_user_id = $2 AND fm.active`, [payload.sub, actAs]);
  if (!m) throw new ActAsError('This family member is not linked to your account.');
  if (consentNeeded(m)) throw new ActAsError('This family member is now an adult. Record their consent in Family before acting for them.');
  return { ...payload, sub: m.member_user_id, patientId: m.patient_id, actingOwner: payload.sub };
}

/** The account holder for a user: themselves, or the owner if the user is a family member. */
export async function ownerOf(userId: string): Promise<string> {
  const r = await queryOne<{ owner_user_id: string }>('SELECT owner_user_id FROM family_members WHERE member_user_id=$1 LIMIT 1', [userId]).catch(() => null);
  return r?.owner_user_id || userId;
}

/** The account holder plus every active family member's user id. */
export async function familyUserIds(ownerId: string): Promise<string[]> {
  const rows = await query<{ member_user_id: string }>('SELECT member_user_id FROM family_members WHERE owner_user_id=$1', [ownerId]).catch(() => []);
  return [ownerId, ...rows.map(r => r.member_user_id)];
}
