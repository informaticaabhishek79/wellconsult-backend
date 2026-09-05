"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../../middleware/authenticate");
const authorize_1 = require("../../middleware/authorize");
const database_1 = require("../../config/database");
const apiResponse_1 = require("../../utils/apiResponse");
const errorHandler_1 = require("../../middleware/errorHandler");
const aws_sdk_1 = __importDefault(require("aws-sdk"));
const router = (0, express_1.Router)();
const r2 = new aws_sdk_1.default.S3({
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    region: 'auto', signatureVersion: 'v4',
});
const BUCKET = process.env.R2_BUCKET || 'onlineconsultation';
// Generate unique agent code
async function generateAgentCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'DA-';
    for (let i = 0; i < 6; i++)
        code += chars[Math.floor(Math.random() * chars.length)];
    const existing = await (0, database_1.queryOne)('SELECT id FROM marketing_agents WHERE agent_code=$1', [code]);
    return existing ? generateAgentCode() : code;
}
// ── Public: Register as agent ──────────────────────────────────────────────
router.post('/register', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const { full_name, phone, city, state, address, territory } = req.body;
        if (!full_name || !phone)
            throw new errorHandler_1.AppError(400, 'MISSING_FIELDS', 'full_name and phone required.');
        // Check if already registered
        const existing = await (0, database_1.queryOne)('SELECT id FROM marketing_agents WHERE user_id=$1', [req.user.sub]);
        if (existing)
            throw new errorHandler_1.AppError(409, 'ALREADY_REGISTERED', 'You are already registered as an agent.');
        const user = await (0, database_1.queryOne)('SELECT email FROM users WHERE id=$1', [req.user.sub]);
        const agent_code = await generateAgentCode();
        const [agent] = await (0, database_1.query)(`INSERT INTO marketing_agents (user_id, agent_code, full_name, email, phone, city, state, address, territory)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [req.user.sub, agent_code, full_name, user.email, phone, city, state, address, territory]);
        (0, apiResponse_1.sendSuccess)(res, agent);
    }
    catch (e) {
        next(e);
    }
});
// Get my agent profile
router.get('/me', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const agent = await (0, database_1.queryOne)(`SELECT a.*, u.full_name AS user_name, u.email AS user_email
       FROM marketing_agents a JOIN users u ON u.id = a.user_id
       WHERE a.user_id=$1`, [req.user.sub]);
        if (!agent)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Agent profile not found.');
        (0, apiResponse_1.sendSuccess)(res, agent);
    }
    catch (e) {
        next(e);
    }
});
// Get my documents
router.get('/me/documents', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const agent = await (0, database_1.queryOne)('SELECT id FROM marketing_agents WHERE user_id=$1', [req.user.sub]);
        if (!agent)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Agent not found.');
        const docs = await (0, database_1.query)('SELECT * FROM agent_documents WHERE agent_id=$1 ORDER BY created_at DESC', [agent.id]);
        (0, apiResponse_1.sendSuccess)(res, docs);
    }
    catch (e) {
        next(e);
    }
});
// Upload document URL
router.post('/me/documents/upload-url', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const agent = await (0, database_1.queryOne)('SELECT id FROM marketing_agents WHERE user_id=$1', [req.user.sub]);
        if (!agent)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Agent not found.');
        const { file_name, content_type, doc_type } = req.body;
        const key = `agent-docs/${agent.id}/${doc_type}/${Date.now()}-${file_name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        const upload_url = r2.getSignedUrl('putObject', { Bucket: BUCKET, Key: key, ContentType: content_type, Expires: 300 });
        (0, apiResponse_1.sendSuccess)(res, { upload_url, key });
    }
    catch (e) {
        next(e);
    }
});
// Save document metadata
router.post('/me/documents', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const agent = await (0, database_1.queryOne)('SELECT id FROM marketing_agents WHERE user_id=$1', [req.user.sub]);
        if (!agent)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Agent not found.');
        const { doc_type, file_key, file_name } = req.body;
        const [doc] = await (0, database_1.query)(`INSERT INTO agent_documents (agent_id, doc_type, file_key, file_name) VALUES ($1,$2,$3,$4) RETURNING *`, [agent.id, doc_type, file_key, file_name]);
        (0, apiResponse_1.sendSuccess)(res, doc);
    }
    catch (e) {
        next(e);
    }
});
// Get my referrals
router.get('/me/referrals', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const agent = await (0, database_1.queryOne)('SELECT id FROM marketing_agents WHERE user_id=$1', [req.user.sub]);
        if (!agent)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Agent not found.');
        const referrals = await (0, database_1.query)(`SELECT r.*, u.full_name AS referred_name, u.email AS referred_email
       FROM agent_referrals r LEFT JOIN users u ON u.id = r.referred_user_id
       WHERE r.agent_id=$1 ORDER BY r.created_at DESC`, [agent.id]);
        (0, apiResponse_1.sendSuccess)(res, referrals);
    }
    catch (e) {
        next(e);
    }
});
// Get my violations
router.get('/me/violations', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const agent = await (0, database_1.queryOne)('SELECT id FROM marketing_agents WHERE user_id=$1', [req.user.sub]);
        if (!agent)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Agent not found.');
        const violations = await (0, database_1.query)(`SELECT v.*, u.full_name AS admin_name FROM agent_violations v
       JOIN users u ON u.id = v.admin_id WHERE v.agent_id=$1 ORDER BY v.created_at DESC`, [agent.id]);
        (0, apiResponse_1.sendSuccess)(res, violations);
    }
    catch (e) {
        next(e);
    }
});
// ── Admin routes ──────────────────────────────────────────────────────────
// List all agents
router.get('/', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const agents = await (0, database_1.query)(`SELECT a.*, u.full_name AS user_name
       FROM marketing_agents a JOIN users u ON u.id = a.user_id
       ORDER BY a.created_at DESC`);
        (0, apiResponse_1.sendSuccess)(res, agents);
    }
    catch (e) {
        next(e);
    }
});
// Verify/approve agent
router.post('/:agentId/verify', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        await (0, database_1.query)(`UPDATE marketing_agents SET profile_status='active', verified_at=NOW() WHERE id=$1`, [req.params.agentId]);
        (0, apiResponse_1.sendSuccess)(res, { message: 'Agent verified and activated.' });
    }
    catch (e) {
        next(e);
    }
});
// Reject agent
router.post('/:agentId/reject', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const { reason } = req.body;
        await (0, database_1.query)(`UPDATE marketing_agents SET profile_status='rejected', termination_reason=$1 WHERE id=$2`, [reason, req.params.agentId]);
        (0, apiResponse_1.sendSuccess)(res, { message: 'Agent rejected.' });
    }
    catch (e) {
        next(e);
    }
});
// File a violation
router.post('/:agentId/violations', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const { violation_type, description, severity, action_taken } = req.body;
        if (!violation_type || !description)
            throw new errorHandler_1.AppError(400, 'MISSING_FIELDS', 'violation_type and description required.');
        const [violation] = await (0, database_1.query)(`INSERT INTO agent_violations (agent_id, violation_type, description, severity, action_taken, admin_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [req.params.agentId, violation_type, description, severity || 'warning', action_taken, req.user.sub]);
        // Update violation count
        const agent = await (0, database_1.queryOne)('SELECT violation_count FROM marketing_agents WHERE id=$1', [req.params.agentId]);
        const newCount = (agent.violation_count || 0) + 1;
        // Auto-terminate after 3 violations
        if (newCount >= 3) {
            await (0, database_1.query)(`UPDATE marketing_agents SET violation_count=$1, profile_status='terminated', terminated_at=NOW(),
         termination_reason='Automatic termination after 3 violations' WHERE id=$2`, [newCount, req.params.agentId]);
        }
        else {
            await (0, database_1.query)('UPDATE marketing_agents SET violation_count=$1 WHERE id=$2', [newCount, req.params.agentId]);
        }
        (0, apiResponse_1.sendSuccess)(res, { violation, violation_count: newCount, auto_terminated: newCount >= 3 });
    }
    catch (e) {
        next(e);
    }
});
// Terminate agent manually
router.post('/:agentId/terminate', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const { reason } = req.body;
        if (!reason)
            throw new errorHandler_1.AppError(400, 'MISSING_REASON', 'Termination reason required.');
        await (0, database_1.query)(`UPDATE marketing_agents SET profile_status='terminated', terminated_at=NOW(), termination_reason=$1 WHERE id=$2`, [reason, req.params.agentId]);
        (0, apiResponse_1.sendSuccess)(res, { message: 'Agent terminated.' });
    }
    catch (e) {
        next(e);
    }
});
// Assign location ID
router.post('/:agentId/assign-location', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const { location_id, location_name } = req.body;
        if (!location_id)
            throw new errorHandler_1.AppError(400, 'MISSING_FIELDS', 'location_id required.');
        await (0, database_1.query)(`UPDATE marketing_agents SET location_id=$1, location_name=$2 WHERE id=$3`, [location_id, location_name || null, req.params.agentId]);
        (0, apiResponse_1.sendSuccess)(res, { message: 'Location assigned successfully.' });
    }
    catch (e) {
        next(e);
    }
});
// Reinstate agent
router.post('/:agentId/reinstate', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        await (0, database_1.query)(`UPDATE marketing_agents SET profile_status='active', terminated_at=NULL, termination_reason=NULL WHERE id=$1`, [req.params.agentId]);
        (0, apiResponse_1.sendSuccess)(res, { message: 'Agent reinstated.' });
    }
    catch (e) {
        next(e);
    }
});
// View agent documents
router.get('/:agentId/documents', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const docs = await (0, database_1.query)('SELECT * FROM agent_documents WHERE agent_id=$1 ORDER BY created_at DESC', [req.params.agentId]);
        (0, apiResponse_1.sendSuccess)(res, docs);
    }
    catch (e) {
        next(e);
    }
});
// View document file
router.get('/:agentId/documents/:docId/view', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const [doc] = await (0, database_1.query)('SELECT * FROM agent_documents WHERE id=$1', [req.params.docId]);
        if (!doc)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Document not found.');
        const url = r2.getSignedUrl('getObject', { Bucket: BUCKET, Key: doc.file_key, Expires: 300 });
        (0, apiResponse_1.sendSuccess)(res, { url });
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
//# sourceMappingURL=agents.routes.js.map