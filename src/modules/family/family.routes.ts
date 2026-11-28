import { Router } from 'express';
import crypto from 'crypto';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query, queryOne, withTransaction } from '../../config/database';
import { sendSuccess, sendCreated } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';
import { hashPassword } from '../../utils/hash';
import { MEMBER_DOMAIN, ageOn, consentNeeded } from './family.service';

const router = Router();
router.use(authenticate, authorize('patient'));

const MAX_MEMBERS = 4;
const RELATIONS = ['spouse', 'child', 'parent', 'sibling', 'grandparent', 'grandchild', 'other'];
const owner = (req: any) => req.user.actingOwner || req.user.sub;

const CONSENT_TEXT = {
  guardian: 'I am the parent or legal guardian of this person, and I agree to book consultations and manage their health records on their behalf.',
  member: 'This person has agreed that I may book consultations for them and see and manage their health records on Deemona Doctors. They can ask me to remove them at any time.',
};

const shape = (m: any) => ({
  user_id: m.member_user_id, patient_id: m.patient_id, full_name: m.full_name, relation: m.relation,
  date_of_birth: m.dob ? (m.dob instanceof Date ? `${m.dob.getFullYear()}-${String(m.dob.getMonth() + 1).padStart(2, '0')}-${String(m.dob.getDate()).padStart(2, '0')}` : String(m.dob).slice(0, 10)) : null,
  gender: m.gender, age: ageOn(m.dob), consent_type: m.consent_type, consent_at: m.consent_at,
  consent_needed: consentNeeded(m),
});

const MEMBER_SQL = `SELECT fm.*, u.full_name, p.id AS patient_id, p.date_of_birth AS dob, p.gender
  FROM family_members fm JOIN users u ON u.id = fm.member_user_id JOIN patients p ON p.user_id = fm.member_user_id`;

router.get('/', async (req, res, next) => {
  try {
    const me = await queryOne<any>('SELECT u.id, u.full_name FROM users u WHERE u.id=$1', [owner(req)]);
    const members = await query<any>(`${MEMBER_SQL} WHERE fm.owner_user_id=$1 AND fm.active ORDER BY fm.created_at`, [owner(req)]);
    sendSuccess(res, { me, members: members.map(shape), max_members: MAX_MEMBERS, consent_text: CONSENT_TEXT });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.full_name || '').trim().slice(0, 120);
    if (name.length < 2) throw new AppError(400, 'MISSING_FIELDS', 'Enter the family member\'s full name.');
    const relation = RELATIONS.includes(b.relation) ? b.relation : 'other';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date_of_birth || ''))) throw new AppError(400, 'MISSING_FIELDS', 'Enter the date of birth.');
    const age = ageOn(b.date_of_birth);
    if (age == null || age < 0 || age > 120) throw new AppError(400, 'INVALID', 'Check the date of birth.');
    const consentType = age < 18 ? 'guardian' : 'member';
    if (b.consent !== true) throw new AppError(400, 'CONSENT_REQUIRED', consentType === 'guardian'
      ? 'Confirm that you are the parent or legal guardian.' : 'Confirm that this person has agreed to you managing their care.');
    const count = await queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM family_members WHERE owner_user_id=$1 AND active', [owner(req)]);
    if ((count?.n || 0) >= MAX_MEMBERS) throw new AppError(409, 'LIMIT', `You can add up to ${MAX_MEMBERS} family members.`);

    const memberId = await withTransaction(async (client) => {
      const pw = await hashPassword(crypto.randomBytes(24).toString('hex'));     // unusable: members never log in
      const [u] = (await client.query(
        `INSERT INTO users (full_name, email, password_hash, role, is_verified, is_active) VALUES ($1,$2,$3,'patient',FALSE,TRUE) RETURNING id`,
        [name, `family+${crypto.randomUUID()}@${MEMBER_DOMAIN}`, pw])).rows;
      await client.query('INSERT INTO patients (user_id, date_of_birth, gender) VALUES ($1,$2,$3)', [u.id, b.date_of_birth, b.gender ? String(b.gender).slice(0, 20) : null]);
      await client.query(
        `INSERT INTO family_members (owner_user_id, member_user_id, relation, consent_type, consent_text, consent_at, consent_ip)
         VALUES ($1,$2,$3,$4,$5,NOW(),$6)`,
        [owner(req), u.id, relation, consentType, (CONSENT_TEXT as any)[consentType], String(req.ip || '').slice(0, 64)]);
      return u.id as string;
    });
    const m = await queryOne<any>(`${MEMBER_SQL} WHERE fm.member_user_id=$1`, [memberId]);
    sendCreated(res, shape(m));
  } catch (e) { next(e); }
});

router.patch('/:userId', async (req, res, next) => {
  try {
    const m = await queryOne<any>(`${MEMBER_SQL} WHERE fm.owner_user_id=$1 AND fm.member_user_id=$2 AND fm.active`, [owner(req), req.params.userId]);
    if (!m) throw new AppError(404, 'NOT_FOUND', 'Family member not found.');
    const b = req.body || {};
    if (b.full_name && String(b.full_name).trim().length >= 2) await query('UPDATE users SET full_name=$1, updated_at=NOW() WHERE id=$2', [String(b.full_name).trim().slice(0, 120), m.member_user_id]);
    if (b.relation && RELATIONS.includes(b.relation)) await query('UPDATE family_members SET relation=$1 WHERE id=$2', [b.relation, m.id]);
    if (b.gender !== undefined) await query('UPDATE patients SET gender=$1 WHERE user_id=$2', [b.gender ? String(b.gender).slice(0, 20) : null, m.member_user_id]);
    // Fresh consent from a member who is now an adult.
    if (b.renew_consent === true) {
      if ((ageOn(m.dob) ?? 0) < 18) throw new AppError(400, 'INVALID', 'Guardian consent still applies.');
      await query(`UPDATE family_members SET consent_type='member', consent_text=$1, consent_at=NOW(), consent_ip=$2 WHERE id=$3`,
        [CONSENT_TEXT.member, String(req.ip || '').slice(0, 64), m.id]);
    }
    sendSuccess(res, shape(await queryOne<any>(`${MEMBER_SQL} WHERE fm.id=$1`, [m.id])));
  } catch (e) { next(e); }
});

// Removing a member stops anyone acting for them; their past records are kept (medical records must be retained).
router.delete('/:userId', async (req, res, next) => {
  try {
    const r = await query(`UPDATE family_members SET active=FALSE, removed_at=NOW() WHERE owner_user_id=$1 AND member_user_id=$2 AND active RETURNING id`, [owner(req), req.params.userId]);
    if (!r.length) throw new AppError(404, 'NOT_FOUND', 'Family member not found.');
    sendSuccess(res, { removed: true });
  } catch (e) { next(e); }
});

export default router;
