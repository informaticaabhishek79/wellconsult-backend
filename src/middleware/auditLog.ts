import { Request, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { logger } from '../utils/logger';

// Sensitive endpoints that need audit logging
const SENSITIVE_PATHS = [
  '/patients',
  '/prescriptions', 
  '/medical-history',
  '/consultations',
  '/video',
];

export function auditLog(req: Request, res: Response, next: NextFunction) {
  const isSensitive = SENSITIVE_PATHS.some(p => req.path.includes(p));
  if (!isSensitive || !req.user) return next();

  const originalSend = res.json.bind(res);
  res.json = (body: any) => {
    // Log async - don't block response
    setImmediate(async () => {
      try {
        await query(
          `INSERT INTO audit_logs (user_id, action, resource, ip_address, user_agent, status_code)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            req.user!.sub,
            `${req.method} ${req.path}`,
            req.params.patientId || req.params.appointmentId || 'self',
            req.ip || req.headers['x-forwarded-for'] || 'unknown',
            req.headers['user-agent'] || 'unknown',
            res.statusCode,
          ]
        );
      } catch (err) {
        logger.warn('Audit log failed', { error: (err as Error).message });
      }
    });
    return originalSend(body);
  };
  next();
}
