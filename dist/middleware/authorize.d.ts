import { Request, Response, NextFunction } from 'express';
type Role = 'patient' | 'doctor' | 'admin';
/**
 * Role guard — pass one or more roles that are allowed.
 * Usage: router.get('/admin/stats', authenticate, authorize('admin'), handler)
 */
export declare function authorize(...roles: Role[]): (req: Request, res: Response, next: NextFunction) => void;
/**
 * Resource ownership guard — patient can only touch their own records.
 * Pass the request param that holds the patient/doctor id.
 */
export declare function ownsResource(paramKey: string, userField: 'patientId' | 'doctorId'): (req: Request, res: Response, next: NextFunction) => void;
export {};
