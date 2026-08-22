import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { sendError } from '../utils/apiResponse';
import { Request, Response } from 'express';

const handler = (_req: Request, res: Response) =>
  sendError(res, 429, 'TOO_MANY_REQUESTS', 'Too many requests. Please try again later.');

/** General API rate limiter — 100 req / 15 min per IP */
export const apiLimiter = rateLimit({
  windowMs:         env.rateLimit.windowMs,
  max:              env.rateLimit.max,
  standardHeaders:  true,
  legacyHeaders:    false,
  handler,
});

/** Auth endpoints — stricter: 10 req / 15 min */
export const authLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  handler,
  keyGenerator: (req) => req.body?.email || req.ip || 'unknown',
});

/** OTP send — 5 req / 10 min */
export const otpLimiter = rateLimit({
  windowMs:        10 * 60 * 1000,
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  handler,
});

/** File upload — 20 req / hour */
export const uploadLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,
  max:             20,
  standardHeaders: true,
  legacyHeaders:   false,
  handler,
});
