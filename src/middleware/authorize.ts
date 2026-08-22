import { Request, Response, NextFunction } from 'express';
import { sendError } from '../utils/apiResponse';

type Role = 'patient' | 'doctor' | 'admin';

/**
 * Role guard — pass one or more roles that are allowed.
 * Usage: router.get('/admin/stats', authenticate, authorize('admin'), handler)
 */
export function authorize(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      sendError(res, 401, 'NOT_AUTHENTICATED', 'You must be logged in.');
      return;
    }
    if (!roles.includes(req.user.role as Role)) {
      sendError(
        res, 403, 'FORBIDDEN',
        `This action requires one of these roles: ${roles.join(', ')}.`
      );
      return;
    }
    next();
  };
}

/**
 * Resource ownership guard — patient can only touch their own records.
 * Pass the request param that holds the patient/doctor id.
 */
export function ownsResource(paramKey: string, userField: 'patientId' | 'doctorId') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const resourceId = req.params[paramKey];
    const userId     = req.user?.[userField];
    if (req.user?.role === 'admin') { next(); return; } // admins bypass
    if (!userId || userId !== resourceId) {
      sendError(res, 403, 'FORBIDDEN', 'You do not have access to this resource.');
      return;
    }
    next();
  };
}
