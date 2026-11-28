import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { AppointmentsService } from './appointments.service';
import { sendSuccess, sendCreated } from '../../utils/apiResponse';
import { query } from '../../config/database';
import { AppError } from '../../middleware/errorHandler';

const router = Router();

router.post('/', authenticate, authorize('patient'), async (req, res, next) => {
  try {
    const [patient] = await query<{ id: string }>('SELECT id FROM patients WHERE user_id=$1', [req.user!.sub]);
           if (!patient) throw new AppError(404, 'NOT_FOUND', 'Patient profile not found.');
    const data = await AppointmentsService.book(patient.id, req.body);
    sendCreated(res, data);
  } catch (e) { next(e); }
});

router.get('/:id', authenticate, async (req, res, next) => {
  try {
sendSuccess(res, await AppointmentsService.getById(req.params.id));
  } catch (e) { next(e); }
});

router.patch('/:id/cancel', authenticate, async (req, res, next) => {
  try {
    const { cancelWithPolicy } = await import('../billing/billing.service');
    sendSuccess(res, await cancelWithPolicy(req.params.id, { role: req.user!.role, userId: req.user!.sub, doctorId: req.user!.doctorId as any }, req.body?.reason));
  } catch (e) { next(e); }
});

export default router;
