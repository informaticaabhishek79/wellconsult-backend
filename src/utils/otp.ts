import crypto from 'crypto';

export const generateOtp = (): string =>
  crypto.randomInt(100000, 999999).toString();

export const OTP_TTL_SECONDS = 600; // 10 minutes
