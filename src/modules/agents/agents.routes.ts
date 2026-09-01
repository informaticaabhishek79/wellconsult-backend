import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query, queryOne } from '../../config/database';
import { sendSuccess } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';
import AWS from 'aws-sdk';

const router = Router();

const r2 = new AWS.S3({
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  region: 'auto', signatureVersion: 'v4',
});
const BUCKET = process.env.R2_BUCKET || 'onlineconsultation';

// Generate unique agent code
async function generateAgentCode(): Promise<string> {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'DA-';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  const existing = await queryOne('SELECT id FROM marketing_agents WHERE agent_code=$1', [code]);
  return existing ? generateAgentCode() : code;
}

// ── Public: Register as agent ──────────────────────────────────────────────
router.post('/register', authenticate, async (req, res, next) => {
  try {
    const { full_name, phone, city, state, address, territory } = req.body;
    if (!full_name || !phone) throw new AppError(400, 'MISSING_FIELDS', 'full_name and phone required.');

    // Check if already registered
    const existing = await queryOne('SELECT id FROM marketing_agents WHERE user_id=$1', [req.user!.sub]);
    if (existing) throw new AppError(409, 'ALREADY_REGISTERED', 'You are already registered as an agent.');

    const user = await queryOne<{ email: string }>('SELECT email FROM users WHERE id=$1', [req.user!.sub]);
    const agent_code = await generateAgentCode();

    const [agent] = await query(
      `INSERT INTO marketing_agents (user_id, agent_code, full_name, email, phone, city, state, address, territory)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user!.sub, agent_code, full_name, user!.email, phone, city, state, address, territory]
    ) as any[];

    sendSuccess(res, agent);
  } catch (e) { next(e); }
});

// Get my agent profile
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const agent = await queryOne(
      `SELECT a.*, u.full_name AS user_name, u.email AS user_email
       FROM marketing_agents a JOIN users u ON u.id = a.user_id
       WHERE a.user_id=$1`,
      [req.user!.sub]
    );
    if (!agent) throw new AppError(404, 'NOT_FOUND', 'Agent profile not found.');
    sendSuccess(res, agent);
  } catch (e) { next(e); }
});

// Get my documents
router.get('/me/documents', authenticate, async (req, res, next) => {
  try {
    const agent = await queryOne<{id:string}>('SELECT id FROM marketing_agents WHERE user_id=$1', [req.user!.sub]);
    if (!agent) throw new AppError(404, 'NOT_FOUND', 'Agent not found.');
    const docs = await query('SELECT * FROM agent_documents WHERE agent_id=$1 ORDER BY created_at DESC', [agent.id]);
    sendSuccess(res, docs);
  } catch (e) { next(e); }
});

// Upload document URL
router.post('/me/documents/upload-url', authenticate, async (req, res, next) => {
  try {
    const agent = await queryOne<{id:string}>('SELECT id FROM marketing_agents WHERE user_id=$1', [req.user!.sub]);
    if (!agent) throw new AppError(404, 'NOT_FOUND', 'Agent not found.');
    const { file_name, content_type, doc_type } = req.body;
    const key = `agent-docs/${agent.id}/${doc_type}/${Date.now()}-${file_name.replace(/[^a-zA-Z0-9.-]/g,'_')}`;
    const upload_url = r2.getSignedUrl('putObject', { Bucket: BUCKET, Key: key, ContentType: content_type, Expires: 300 });
    sendSuccess(res, { upload_url, key });
  } catch (e) { next(e); }
});

// Save document metadata
router.post('/me/documents', authenticate, async (req, res, next) => {
  try {
    const agent = await queryOne<{id:string}>('SELECT id FROM marketing_agents WHERE user_id=$1', [req.user!.sub]);
    if (!agent) throw new AppError(404, 'NOT_FOUND', 'Agent not found.');
    const { doc_type, file_key, file_name } = req.body;
    const [doc] = await query(
      `INSERT INTO agent_documents (agent_id, doc_type, file_key, file_name) VALUES ($1,$2,$3,$4) RETURNING *`,
      [agent.id, doc_type, file_key, file_name]
    ) as any[];
    sendSuccess(res, doc);
  } catch (e) { next(e); }
});

// Get my referrals
router.get('/me/referrals', authenticate, async (req, res, next) => {
  try {
    const agent = await queryOne<{id:string}>('SELECT id FROM marketing_agents WHERE user_id=$1', [req.user!.sub]);
    if (!agent) throw new AppError(404, 'NOT_FOUND', 'Agent not found.');
    const referrals = await query(
      `SELECT r.*, u.full_name AS referred_name, u.email AS referred_email
       FROM agent_referrals r LEFT JOIN users u ON u.id = r.referred_user_id
       WHERE r.agent_id=$1 ORDER BY r.created_at DESC`,
      [agent.id]
    );
    sendSuccess(res, referrals);
  } catch (e) { next(e); }
});

// Get my violations
router.get('/me/violations', authenticate, async (req, res, next) => {
  try {
    const agent = await queryOne<{id:string}>('SELECT id FROM marketing_agents WHERE user_id=$1', [req.user!.sub]);
    if (!agent) throw new AppError(404, 'NOT_FOUND', 'Agent not found.');
    const violations = await query(
      `SELECT v.*, u.full_name AS admin_name FROM agent_violations v
       JOIN users u ON u.id = v.admin_id WHERE v.agent_id=$1 ORDER BY v.created_at DESC`,
      [agent.id]
    );
    sendSuccess(res, violations);
  } catch (e) { next(e); }
});

// ── Admin routes ──────────────────────────────────────────────────────────

// List all agents
router.get('/', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const agents = await query(
      `SELECT a.*, u.full_name AS user_name
       FROM marketing_agents a JOIN users u ON u.id = a.user_id
       ORDER BY a.created_at DESC`
    );
    sendSuccess(res, agents);
  } catch (e) { next(e); }
});

// Verify/approve agent
router.post('/:agentId/verify', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    await query(
      `UPDATE marketing_agents SET profile_status='active', verified_at=NOW() WHERE id=$1`,
      [req.params.agentId]
    );
    sendSuccess(res, { message: 'Agent verified and activated.' });
  } catch (e) { next(e); }
});

// Reject agent
router.post('/:agentId/reject', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { reason } = req.body;
    await query(
      `UPDATE marketing_agents SET profile_status='rejected', termination_reason=$1 WHERE id=$2`,
      [reason, req.params.agentId]
    );
    sendSuccess(res, { message: 'Agent rejected.' });
  } catch (e) { next(e); }
});

// File a violation
router.post('/:agentId/violations', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { violation_type, description, severity, action_taken } = req.body;
    if (!violation_type || !description) throw new AppError(400, 'MISSING_FIELDS', 'violation_type and description required.');

    const [violation] = await query(
      `INSERT INTO agent_violations (agent_id, violation_type, description, severity, action_taken, admin_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.agentId, violation_type, description, severity || 'warning', action_taken, req.user!.sub]
    ) as any[];

    // Update violation count
    const agent = await queryOne<{violation_count: number}>('SELECT violation_count FROM marketing_agents WHERE id=$1', [req.params.agentId]) as any;
    const newCount = (agent.violation_count || 0) + 1;

    // Auto-terminate after 3 violations
    if (newCount >= 3) {
      await query(
        `UPDATE marketing_agents SET violation_count=$1, profile_status='terminated', terminated_at=NOW(),
         termination_reason='Automatic termination after 3 violations' WHERE id=$2`,
        [newCount, req.params.agentId]
      );
    } else {
      await query('UPDATE marketing_agents SET violation_count=$1 WHERE id=$2', [newCount, req.params.agentId]);
    }

    sendSuccess(res, { violation, violation_count: newCount, auto_terminated: newCount >= 3 });
  } catch (e) { next(e); }
});

// Terminate agent manually
router.post('/:agentId/terminate', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) throw new AppError(400, 'MISSING_REASON', 'Termination reason required.');
    await query(
      `UPDATE marketing_agents SET profile_status='terminated', terminated_at=NOW(), termination_reason=$1 WHERE id=$2`,
      [reason, req.params.agentId]
    );
    sendSuccess(res, { message: 'Agent terminated.' });
  } catch (e) { next(e); }
});

// Reinstate agent
router.post('/:agentId/reinstate', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    await query(
      `UPDATE marketing_agents SET profile_status='active', terminated_at=NULL, termination_reason=NULL WHERE id=$1`,
      [req.params.agentId]
    );
    sendSuccess(res, { message: 'Agent reinstated.' });
  } catch (e) { next(e); }
});

// View agent documents
router.get('/:agentId/documents', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const docs = await query('SELECT * FROM agent_documents WHERE agent_id=$1 ORDER BY created_at DESC', [req.params.agentId]);
    sendSuccess(res, docs);
  } catch (e) { next(e); }
});

// View document file
router.get('/:agentId/documents/:docId/view', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const [doc] = await query('SELECT * FROM agent_documents WHERE id=$1', [req.params.docId]) as any[];
    if (!doc) throw new AppError(404, 'NOT_FOUND', 'Document not found.');
    const url = r2.getSignedUrl('getObject', { Bucket: BUCKET, Key: doc.file_key, Expires: 300 });
    sendSuccess(res, { url });
  } catch (e) { next(e); }
});

export default router;
