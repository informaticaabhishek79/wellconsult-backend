"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../../middleware/authenticate");
const apiResponse_1 = require("../../utils/apiResponse");
const errorHandler_1 = require("../../middleware/errorHandler");
const agora_token_1 = require("agora-token");
const router = (0, express_1.Router)();
const APP_ID = process.env.AGORA_APP_ID || '';
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || '';
// Generate Agora RTC token for a video call
router.post('/token', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const { channel_name } = req.body;
        if (!channel_name)
            throw new errorHandler_1.AppError(400, 'MISSING_FIELDS', 'channel_name required.');
        if (!APP_ID || !APP_CERTIFICATE)
            throw new errorHandler_1.AppError(500, 'CONFIG_ERROR', 'Agora not configured.');
        // Use numeric UID derived from user ID
        const uid = Math.abs(req.user.sub.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)) % 1000000;
        const expirationTimeInSeconds = 3600; // 1 hour
        const currentTimestamp = Math.floor(Date.now() / 1000);
        const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;
        const token = agora_token_1.RtcTokenBuilder.buildTokenWithUid(APP_ID, APP_CERTIFICATE, channel_name, uid, agora_token_1.RtcRole.PUBLISHER, expirationTimeInSeconds, privilegeExpiredTs);
        (0, apiResponse_1.sendSuccess)(res, {
            token,
            app_id: APP_ID,
            channel: channel_name,
            uid,
            expires_at: privilegeExpiredTs,
        });
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
//# sourceMappingURL=agora.routes.js.map