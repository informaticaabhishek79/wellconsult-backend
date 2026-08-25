import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { AppointmentsService } from './appointments.service';
import { sendSuccess, sendCreated } from '../../utils/apiResponse';

const router = Router();

router.post('/', authenticate, authorize('patient'), async (req, res, next) => {
  try {
    const data = await AppointmentsService.book(req.user!.patientId!, req.body);
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
    sendSuccess(res, await AppointmentsService.cancel(req.params.id, req.body.reason));
  } catch (e) { next(e); }
});

export default router;
