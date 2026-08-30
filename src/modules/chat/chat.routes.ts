import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { sendSuccess } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';
import AWS from 'aws-sdk';

const router = Router();

const r2 = new AWS.S3({
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  region: 'auto',
  signatureVersion: 'v4',
});

const BUCKET = process.env.R2_BUCKET || 'onlineconsultation';

// Get presigned upload URL for chat media
router.post('/upload-url', authenticate, async (req, res, next) => {
  try {
    const { appointment_id, file_name, content_type } = req.body;
    if (!appointment_id || !file_name || !content_type) {
      throw new AppError(400, 'MISSING_FIELDS', 'appointment_id, file_name and content_type required.');
    }

    const allowed = ['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/quicktime','video/webm'];
    if (!allowed.includes(content_type)) {
      throw new AppError(400, 'INVALID_FORMAT', 'Only images (JPG/PNG/WebP) and videos (MP4/MOV/WebM) allowed.');
    }

    const isVideo = content_type.startsWith('video/');
    const safeFileName = file_name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `chat-media/${appointment_id}/${Date.now()}-${safeFileName}`;

    const upload_url = r2.getSignedUrl('putObject', {
      Bucket: BUCKET, Key: key, ContentType: content_type, Expires: 300,
    });

    sendSuccess(res, { upload_url, key, type: isVideo ? 'video' : 'image' });
  } catch (e) { next(e); }
});

// Get signed view URL for chat media
router.get('/media/:key(*)', authenticate, async (req, res, next) => {
  try {
    const url = r2.getSignedUrl('getObject', {
      Bucket: BUCKET, Key: req.params.key, Expires: 3600,
    });
    sendSuccess(res, { url });
  } catch (e) { next(e); }
});

export default router;
