"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../../middleware/authenticate");
const database_1 = require("../../config/database");
const apiResponse_1 = require("../../utils/apiResponse");
const errorHandler_1 = require("../../middleware/errorHandler");
const logger_1 = require("../../utils/logger");
const router = (0, express_1.Router)();
const CF_APP_ID = process.env.CF_CALLS_APP_ID || '';
const CF_APP_TOKEN = process.env.CF_CALLS_APP_TOKEN || '';
const CF_BASE = `https://rtc.live.cloudflare.com/v1/apps/${CF_APP_ID}`;
async function cfRequest(method, path, body) {
    const res = await fetch(`${CF_BASE}${path}`, {
        method,
        headers: { 'Authorization': `Bearer ${CF_APP_TOKEN}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    try {
        const data = JSON.parse(text);
        if (!res.ok)
            throw new Error(`CF error: ${JSON.stringify(data)}`);
        return data;
    }
    catch (e) {
        if (!res.ok)
            throw new Error(`CF HTTP ${res.status}: ${text.slice(0, 200)}`);
        throw e;
    }
}
// Create session + push tracks - backend handles all CF API calls
router.post('/session/:appointmentId', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const apptId = req.params.appointmentId;
        const { sdp, type, tracks } = req.body;
        // Verify access
        const [appt] = await (0, database_1.query)(`SELECT a.id, d.user_id AS doctor_user_id, p.user_id AS patient_user_id,
              du.full_name AS doctor_name, pu.full_name AS patient_name
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN patients p ON p.id = a.patient_id
       JOIN users du ON du.id = d.user_id
       JOIN users pu ON pu.id = p.user_id
       WHERE a.id = $1`, [apptId]);
        if (!appt)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Appointment not found.');
        const hasAccess = appt.doctor_user_id === req.user.sub || appt.patient_user_id === req.user.sub;
        if (!hasAccess)
            throw new errorHandler_1.AppError(403, 'FORBIDDEN', 'Access denied.');
        // Create Cloudflare session
        const session = await cfRequest('POST', '/sessions/new');
        // If SDP offer provided, push tracks
        let tracksResult = null;
        if (sdp && tracks) {
            logger_1.logger.info('CF tracks request', { tracks: JSON.stringify(tracks), sessionId: session.sessionId || session.session_id });
            const cfSessionId = session.sessionId || session.session_id;
            tracksResult = await cfRequest('POST', `/sessions/${cfSessionId}/tracks/new`, {
                sessionDescription: { type, sdp },
                tracks,
            });
            logger_1.logger.info('CF tracks response', { type: tracksResult?.sessionDescription?.type, sdp: tracksResult?.sessionDescription?.sdp?.slice(0, 200) });
        }
        const isDoctor = appt.doctor_user_id === req.user.sub;
        const cfSessionId2 = session.sessionId || session.session_id;
        (0, apiResponse_1.sendSuccess)(res, {
            session_id: cfSessionId2,
            sessionDescription: tracksResult?.sessionDescription || null,
            user_name: isDoctor ? appt.doctor_name : appt.patient_name,
            is_doctor: isDoctor,
        });
    }
    catch (e) {
        logger_1.logger.error('Video session error', { error: e.message });
        next(e);
    }
});
exports.default = router;
// Pull remote tracks via backend (keeps CF token secure)
router.post('/session/:appointmentId/pull', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const { sessionId, remoteSessionId } = req.body;
        if (!sessionId || !remoteSessionId)
            throw new errorHandler_1.AppError(400, 'MISSING_FIELDS', 'sessionId and remoteSessionId required.');
        // Get remote session tracks
        const remoteSession = await cfRequest('GET', `/sessions/${remoteSessionId}`);
        const remoteTracks = (remoteSession.tracks || []).filter((t) => t.location === 'local');
        (0, apiResponse_1.sendSuccess)(res, { remoteTracks, remoteSession });
    }
    catch (e) {
        next(e);
    }
});
// Renegotiate session
router.put('/session/:appointmentId/renegotiate', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const { sessionId, sessionDescription } = req.body;
        if (!sessionId || !sessionDescription)
            throw new errorHandler_1.AppError(400, 'MISSING_FIELDS', 'sessionId and sessionDescription required.');
        const result = await cfRequest('PUT', `/sessions/${sessionId}/renegotiate`, { sessionDescription });
        (0, apiResponse_1.sendSuccess)(res, result);
    }
    catch (e) {
        next(e);
    }
});
// Push pull tracks request 
router.post('/session/:appointmentId/tracks/pull', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const { sessionId, sessionDescription, tracks } = req.body;
        const result = await cfRequest('POST', `/sessions/${sessionId}/tracks/new`, {
            sessionDescription,
            tracks,
        });
        (0, apiResponse_1.sendSuccess)(res, result);
    }
    catch (e) {
        next(e);
    }
});
//# sourceMappingURL=video.routes.js.map