"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../../middleware/authenticate");
const apiResponse_1 = require("../../utils/apiResponse");
const errorHandler_1 = require("../../middleware/errorHandler");
const aws_sdk_1 = __importDefault(require("aws-sdk"));
const router = (0, express_1.Router)();
const r2 = new aws_sdk_1.default.S3({
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    region: 'auto',
    signatureVersion: 'v4',
});
const BUCKET = process.env.R2_BUCKET || 'onlineconsultation';
// Get presigned upload URL for chat media
router.post('/upload-url', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const { appointment_id, file_name, content_type } = req.body;
        if (!appointment_id || !file_name || !content_type) {
            throw new errorHandler_1.AppError(400, 'MISSING_FIELDS', 'appointment_id, file_name and content_type required.');
        }
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm'];
        if (!allowed.includes(content_type)) {
            throw new errorHandler_1.AppError(400, 'INVALID_FORMAT', 'Only images (JPG/PNG/WebP) and videos (MP4/MOV/WebM) allowed.');
        }
        const isVideo = content_type.startsWith('video/');
        const safeFileName = file_name.replace(/[^a-zA-Z0-9.-]/g, '_');
        const key = `chat-media/${appointment_id}/${Date.now()}-${safeFileName}`;
        const upload_url = r2.getSignedUrl('putObject', {
            Bucket: BUCKET, Key: key, ContentType: content_type, Expires: 300,
        });
        (0, apiResponse_1.sendSuccess)(res, { upload_url, key, type: isVideo ? 'video' : 'image' });
    }
    catch (e) {
        next(e);
    }
});
// Get signed view URL for chat media
router.get('/media/:key(*)', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const url = r2.getSignedUrl('getObject', {
            Bucket: BUCKET, Key: req.params.key, Expires: 3600,
        });
        (0, apiResponse_1.sendSuccess)(res, { url });
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
//# sourceMappingURL=chat.routes.js.map