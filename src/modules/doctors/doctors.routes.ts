import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { DoctorsService } from './doctors.service';
import { sendSuccess } from '../../utils/apiResponse';

const router = Router();

// Public routes
router.get('/', async (req, res, next) => {
  try {
    const { rows, total, page, limit } = await DoctorsService.search(req);
    sendSuccess(res, rows, 200, { page, limit, total });
  } catch (e) { next(e); }
});

router.get('/:id/availability', async (req, res, next) => {
  try {
    const date = req.query.date as string || new Date().toISOString().slice(0, 10);
    sendSuccess(res, await DoctorsService.getAvailability(req.params.id, date));
  } catch (e) { next(e); }
});

// Doctor auth routes
router.get('/me/dashboard', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    const data = await DoctorsService.getDashboard(req.user!.doctorId!);
    sendSuccess(res, data);
  } catch (e) { next(e); }
});

router.get('/me/profile', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    sendSuccess(res, await DoctorsService.getById(req.user!.doctorId!));
  } catch (e) { next(e); }
});

router.put('/me/profile', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    sendSuccess(res, await DoctorsService.updateProfile(req.user!.doctorId!, req.body));
  } catch (e) { next(e); }
});

router.post('/me/fees', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    sendSuccess(res, await DoctorsService.updateFees(req.user!.doctorId!, req.body));
  } catch (e) { next(e); }
});

router.post('/me/availability', authenticate, authorize('doctor'), async (req, res, next) => {
  try {
    sendSuccess(res, await DoctorsService.addAvailability(req.user!.doctorId!, req.body));
  } catch (e) { next(e); }
});

// Public doctor detail (must be last to avoid conflicts with /me routes)
router.get('/:id', async (req, res, next) => {
  try { sendSuccess(res, await DoctorsService.getById(req.params.id)); }
  catch (e) { next(e); }
});

export default router;
