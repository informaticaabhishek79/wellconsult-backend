import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, JwtPayload } from '../utils/jwt';
import { sendError } from '../utils/apiResponse';
import { redis } from '../config/redis';

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

    req.user = payload;
    next();
  } catch {
    sendError(res, 401, 'INVALID_TOKEN', 'Token is invalid or expired.');
  }
}
