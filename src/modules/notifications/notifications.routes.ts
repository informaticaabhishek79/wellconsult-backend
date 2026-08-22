import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { NotificationService } from './notifications.service';
import { sendSuccess, sendNoContent } from '../../utils/apiResponse';
import { getPagination } from '../../utils/pagination';

const router = Router();

router.get('/', authenticate, async (req, res, next) => {
  try {
    const { page, limit } = getPagination(req);
    const data = await NotificationService.listForUser(req.user!.sub, page, limit);
    sendSuccess(res, data.rows, 200, { page, limit, total: data.total });
  } catch (e) { next(e); }
});

router.patch('/:id/read', authenticate, async (req, res, next) => {
  try {
    await NotificationService.markRead(req.params.id, req.user!.sub);
    sendSuccess(res, { message: 'Marked as read.' });
  } catch (e) { next(e); }
});

router.patch('/read-all', authenticate, async (req, res, next) => {
  try {
    await NotificationService.markAllRead(req.user!.sub);
    sendNoContent(res);
  } catch (e) { next(e); }
});

export default router;
