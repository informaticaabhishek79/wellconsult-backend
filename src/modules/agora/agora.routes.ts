import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { sendSuccess } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';
import { RtcTokenBuilder, RtcRole } from 'agora-token';

const router = Router();

const APP_ID = process.env.AGORA_APP_ID || '';
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || '';

// Generate Agora RTC token for a video call
router.post('/token', authenticate, async (req, res, next) => {
  try {
    const { channel_name } = req.body;
    if (!channel_name) throw new AppError(400, 'MISSING_FIELDS', 'channel_name required.');
    if (!APP_ID || !APP_CERTIFICATE) throw new AppError(500, 'CONFIG_ERROR', 'Agora not configured.');

    // Use numeric UID derived from user ID
    const uid = Math.abs(
      req.user!.sub.split('').reduce((a: number, c: string) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)
    ) % 1000000;

    const expirationTimeInSeconds = 3600; // 1 hour
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      APP_ID,
      APP_CERTIFICATE,
      channel_name,
      uid,
      RtcRole.PUBLISHER,
      expirationTimeInSeconds,
      privilegeExpiredTs
    );

    sendSuccess(res, {
      token,
      app_id: APP_ID,
      channel: channel_name,
      uid,
      expires_at: privilegeExpiredTs,
    });
  } catch (e) { next(e); }
});

export default router;
