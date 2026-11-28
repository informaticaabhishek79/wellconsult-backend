import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, JwtPayload } from '../utils/jwt';
import { sendError } from '../utils/apiResponse';
import { redis } from '../config/redis';
import { resolveActAs } from '../modules/family/family.service';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    sendError(res, 401, 'MISSING_TOKEN', 'Authorization token is required.');
    return;
  }

  const token = header.slice(7);
  try {
    const payload = verifyAccessToken(token);

    // Check token blacklist (set on logout)
    const blacklisted = await redis.get(`blacklist:${token}`);
    if (blacklisted) {
      sendError(res, 401, 'TOKEN_REVOKED', 'Token has been revoked. Please log in again.');
      return;
    }

    const actAs = req.headers['x-act-as'];
    try {
      req.user = await resolveActAs(payload, typeof actAs === 'string' ? actAs : undefined);
    } catch (e: any) {
      sendError(res, 403, 'ACT_AS_DENIED', e?.message || 'You cannot act for this person.');
      return;
    }
    next();
  } catch {
    sendError(res, 401, 'INVALID_TOKEN', 'Token is invalid or expired.');
  }
}
